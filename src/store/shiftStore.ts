import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { buildReconRows, computeSales, summarize } from "../domain/reconcile";
import { currentPrices, recalcUnreviewed } from "../domain/pricing";
import { toCsv } from "../domain/exporter";
import type {
  FuelType,
  Handover,
  NozzleReading,
  OutboxOp,
  PayMethod,
  Payment,
  ShiftName,
  StationDb
} from "../domain/types";
import { loadStation, saveStation } from "./persistence";
import { addLog, pullAndMerge, pushOutbox } from "./sync";
import { cloudAddPayment, cloudEditHandover } from "./cloud";

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export const useShiftStore = defineStore("shift", () => {
  const db = ref<StationDb>(loadStation());
  const online = ref(true);
  /** 模拟“云端已应用但确认丢失”，用于验证重放幂等 */
  const flaky = ref(false);
  const syncing = ref(false);
  const lastSyncAt = ref<number | null>(null);

  // ---------- 派生：列表 / 汇总 / 导出共用 ----------
  const pricesNow = computed(() => currentPrices(db.value.prices));
  const reconRows = computed(() => buildReconRows(db.value.handovers, db.value.payments, db.value.conflicts));
  const summary = computed(() => summarize(reconRows.value));
  const pendingOps = computed(() => db.value.outbox.length);
  const activeHandovers = computed(() => db.value.handovers.filter((h) => !h.deleted));

  function persist() {
    saveStation(db.value);
  }

  function enqueue(payload: OutboxOp["payload"], opId = uid("op")) {
    db.value.outbox.push({ opId, payload, attempts: 0, lastError: null, enqueuedAt: Date.now() });
  }

  function touch(h: Handover): Handover {
    return { ...h, rev: h.rev + 1, updatedAt: Date.now() };
  }

  function replaceHandover(next: Handover, sync = true) {
    const idx = db.value.handovers.findIndex((h) => h.id === next.id);
    if (idx >= 0) db.value.handovers[idx] = next;
    else db.value.handovers.push(next);
    if (sync) enqueue({ kind: "upsert-handover", handover: next });
  }

  // ---------- 离线续作：三处录入都只写本地 + 入待传队列 ----------
  function addHandover(input: {
    shiftDate: string;
    shift: ShiftName;
    operator: string;
    readings: NozzleReading[];
    notes: string;
  }) {
    const snapshot = { ...pricesNow.value };
    const h: Handover = {
      id: uid("ho"),
      shiftDate: input.shiftDate,
      shift: input.shift,
      operator: input.operator || "未署名",
      readings: input.readings,
      salesAmount: 0,
      priceSnapshot: snapshot,
      status: "待复核",
      notes: input.notes || "暂无备注",
      rev: 1,
      syncedRev: 0,
      updatedAt: Date.now(),
      origin: "station",
      deleted: false
    };
    h.salesAmount = computeSales(h, snapshot);
    db.value.handovers.unshift(h);
    enqueue({ kind: "upsert-handover", handover: h });
    addLog(db.value, `新增交接单：${h.shiftDate} ${h.shift}（已入待传队列）`);
    persist();
  }

  function updateReadings(handoverId: string, readings: NozzleReading[]) {
    const h = db.value.handovers.find((x) => x.id === handoverId);
    if (!h || h.status === "已复核") return;
    const next = touch({ ...h, readings });
    next.salesAmount = computeSales(next, pricesNow.value);
    next.priceSnapshot = { ...pricesNow.value };
    replaceHandover(next);
    addLog(db.value, `补录油枪读数：${h.shiftDate} ${h.shift}，销售额重算为 ¥${next.salesAmount.toFixed(2)}`);
    persist();
  }

  function review(handoverId: string) {
    const h = db.value.handovers.find((x) => x.id === handoverId);
    if (!h || h.status === "已复核") return;
    replaceHandover(touch({ ...h, status: "已复核" }));
    addLog(db.value, `复核通过：${h.shiftDate} ${h.shift}，销售额锁定 ¥${h.salesAmount.toFixed(2)}`);
    persist();
  }

  function removeHandover(handoverId: string) {
    const h = db.value.handovers.find((x) => x.id === handoverId);
    if (!h) return;
    replaceHandover(touch({ ...h, deleted: true }));
    db.value.conflicts = db.value.conflicts.filter((c) => c.handoverId !== handoverId);
    persist();
  }

  function addPayment(handoverId: string, method: PayMethod, amount: number) {
    if (!(amount > 0)) return;
    const payment: Payment = {
      id: uid("pay"), // id 即幂等键：重放同一操作不会重复入账
      handoverId,
      method,
      amount: Math.round(amount * 100) / 100,
      createdAt: Date.now(),
      origin: "station"
    };
    db.value.payments.push(payment);
    enqueue({ kind: "add-payment", payment }, payment.id);
    addLog(db.value, `收款入账：${method} ¥${payment.amount.toFixed(2)}（待上传）`);
    persist();
  }

  /** 油价变化：未复核交接单销售额重算并入待传队列，已复核锁定不动 */
  function changePrice(fuelType: FuelType, price: number) {
    if (!(price > 0)) return;
    const now = Date.now();
    const record = { fuelType, price, effectiveAt: now };
    db.value.prices.push(record);
    enqueue({ kind: "price-change", record });
    const recalced = recalcUnreviewed(db.value.handovers, currentPrices(db.value.prices, now), now);
    for (const h of recalced) replaceHandover(h);
    addLog(
      db.value,
      recalced.length > 0
        ? `油价变更：${fuelType} → ¥${price.toFixed(2)}，已重算 ${recalced.length} 张未复核交接单（已复核锁定不动）`
        : `油价变更：${fuelType} → ¥${price.toFixed(2)}，无待重算的未复核交接单`
    );
    persist();
  }

  // ---------- 同步：网络恢复后先推后拉，合并两端记录 ----------
  function syncNow() {
    if (!online.value) {
      addLog(db.value, "当前离线：同步跳过，待传队列保留");
      persist();
      return;
    }
    syncing.value = true;
    try {
      const push = pushOutbox(db.value, { flaky: flaky.value }, (op) => {
        if (op.payload.kind === "upsert-handover") {
          const sent = op.payload.handover;
          const local = db.value.handovers.find((h) => h.id === sent.id);
          if (local && local.rev === sent.rev) local.syncedRev = local.rev;
        }
      });
      if (push.failed) {
        persist();
        return; // 推送失败：保留队列，本次不再拉取，避免半同步状态
      }
      const pull = pullAndMerge(db.value);
      lastSyncAt.value = Date.now();
      addLog(
        db.value,
        `同步完成：上传 ${push.pushed} 条，拉取 ${pull.pulled} 条交接单、${pull.paymentsAdded} 笔收款` +
          (pull.conflictsFound > 0 ? `，检出 ${pull.conflictsFound} 个冲突待站长核对` : "")
      );
      persist();
    } finally {
      syncing.value = false;
    }
  }

  // ---------- 冲突核对：站长拍板 ----------
  function resolveConflict(handoverId: string, choice: "station" | "incoming") {
    const conflict = db.value.conflicts.find((c) => c.handoverId === handoverId);
    if (!conflict) return;
    if (choice === "station") {
      // 站内版上传覆盖云端
      const winner = touch(conflict.stationVersion);
      replaceHandover(winner);
      addLog(db.value, `冲突已核对：保留站内版（${conflict.stationVersion.shiftDate} ${conflict.stationVersion.shift}），待上传`);
    } else {
      const incoming = conflict.incomingVersion;
      const idx = db.value.handovers.findIndex((h) => h.id === handoverId);
      if (idx >= 0) db.value.handovers[idx] = { ...incoming, syncedRev: incoming.rev };
      addLog(db.value, `冲突已核对：采用迟到副本（${incoming.shiftDate} ${incoming.shift}）`);
    }
    db.value.conflicts = db.value.conflicts.filter((c) => c.handoverId !== handoverId);
    persist();
  }

  // ---------- 演示对端改动 ----------
  function simulateCloudEdit(handoverId: string, patch: { salesAmount?: number; notes?: string }) {
    const next = cloudEditHandover(handoverId, patch);
    addLog(db.value, next ? `模拟对端改动：云端交接单 rev ${next.rev}，待同步合并` : "模拟失败：云端无此交接单");
    persist();
  }

  function simulateCloudPayment(handoverId: string, method: PayMethod, amount: number) {
    cloudAddPayment({
      id: uid("pay-cloud"),
      handoverId,
      method,
      amount,
      createdAt: Date.now(),
      origin: "cloud"
    });
    addLog(db.value, `模拟对端补登收款：${method} ¥${amount.toFixed(2)}，待同步合并`);
    persist();
  }

  // ---------- 导出：与列表/汇总同一份 reconRows ----------
  function exportCsv() {
    return toCsv(reconRows.value);
  }

  function setOnline(v: boolean) {
    online.value = v;
    addLog(db.value, v ? "网络已恢复，可执行同步" : "已断网：录入照常进行，操作进入待传队列");
    persist();
  }

  return {
    db,
    online,
    flaky,
    syncing,
    lastSyncAt,
    pricesNow,
    reconRows,
    summary,
    pendingOps,
    activeHandovers,
    addHandover,
    updateReadings,
    review,
    removeHandover,
    addPayment,
    changePrice,
    syncNow,
    resolveConflict,
    simulateCloudEdit,
    simulateCloudPayment,
    exportCsv,
    setOnline,
    persist
  };
});
