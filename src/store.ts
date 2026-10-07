import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  applyOpToServer,
  buildCsv,
  clone,
  computeSales,
  describeOp,
  isLocked,
  mergeHandover,
  mergePayments,
  mergePrices,
  nowIso,
  priceAt,
  recalcUnreviewed,
  reconRows,
  resolveConflict,
  round2,
  summarize,
  uid,
  type FuelPrice,
  type Handover,
  type LocalState,
  type Op,
  type Payment,
  type ServerState,
} from "./lib/recon";

const LOCAL_KEY = "dfwlfront-7-shift-local-v1";
const SERVER_KEY = "dfwlfront-7-shift-server-v1";

// ---------- 演示种子数据 ----------

function seedHandovers(): Handover[] {
  const prices = seedPrices();
  const mk = (
    id: string,
    shiftDate: string,
    shift: string,
    status: Handover["status"],
    readings: Handover["readings"],
    notes: string,
    updatedAt: string,
    reviewedAt: string | null
  ): Handover => ({
    id,
    shiftDate,
    shift,
    status,
    readings,
    salesAmount: computeSales(readings, prices, updatedAt),
    notes,
    version: 1,
    updatedAt,
    origin: "站内",
    reviewedAt,
    recalcMark: null,
    conflict: null,
  });
  return [
    mk(
      "h-1005-early",
      "2026-10-05",
      "早班",
      "已复核",
      [
        { id: "r-1", pumpNo: "1号泵", fuelType: "92#汽油", start: 10234, end: 12834 },
        { id: "r-2", pumpNo: "2号泵", fuelType: "95#汽油", start: 8540, end: 10140 },
      ],
      "账实一致",
      "2026-10-05T08:10:00.000Z",
      "2026-10-05T09:02:00.000Z"
    ),
    mk(
      "h-1005-mid",
      "2026-10-05",
      "中班",
      "待复核",
      [
        { id: "r-3", pumpNo: "1号泵", fuelType: "92#汽油", start: 12834, end: 14834 },
        { id: "r-4", pumpNo: "3号泵", fuelType: "0#柴油", start: 22100, end: 24000 },
      ],
      "等待站长确认，差异待查",
      "2026-10-05T16:05:00.000Z",
      null
    ),
    mk(
      "h-1006-early",
      "2026-10-06",
      "早班",
      "待复核",
      [{ id: "r-5", pumpNo: "2号泵", fuelType: "95#汽油", start: 10140, end: 10940 }],
      "早班补录中",
      "2026-10-06T08:12:00.000Z",
      null
    ),
  ];
}

function seedPayments(): Payment[] {
  return [
    { id: "p-seed-1", handoverId: "h-1005-early", method: "现金", amount: 9722, createdAt: "2026-10-05T08:20:00.000Z" },
    { id: "p-seed-2", handoverId: "h-1005-early", method: "电子支付", amount: 24000, createdAt: "2026-10-05T08:21:00.000Z" },
    { id: "p-seed-3", handoverId: "h-1005-mid", method: "现金", amount: 6400, createdAt: "2026-10-05T16:10:00.000Z" },
    { id: "p-seed-4", handoverId: "h-1005-mid", method: "电子支付", amount: 19800, createdAt: "2026-10-05T16:11:00.000Z" },
  ];
}

function seedPrices(): FuelPrice[] {
  return [
    { fuelType: "92#汽油", price: 7.85, effectiveAt: "2026-10-01T00:00:00.000Z" },
    { fuelType: "95#汽油", price: 8.32, effectiveAt: "2026-10-01T00:00:00.000Z" },
    { fuelType: "0#柴油", price: 7.12, effectiveAt: "2026-10-01T00:00:00.000Z" },
  ];
}

function seedLocal(): LocalState {
  const handovers = seedHandovers();
  const syncedVersion: Record<string, number> = {};
  for (const h of handovers) syncedVersion[h.id] = h.version;
  return {
    handovers,
    payments: seedPayments(),
    prices: seedPrices(),
    outbox: [],
    syncedVersion,
    lastSyncAt: null,
  };
}

function seedServer(): ServerState {
  return { handovers: seedHandovers(), payments: seedPayments(), prices: seedPrices() };
}

function load<T>(key: string, fallback: () => T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // 数据损坏时回退种子
  }
  return fallback();
}

export interface LogEntry {
  time: string;
  text: string;
}

export const useReconStore = defineStore("recon", () => {
  const local = ref<LocalState>(load(LOCAL_KEY, seedLocal));
  const server = ref<ServerState>(load(SERVER_KEY, seedServer));
  const online = ref(true);
  /** 模拟“请求已到达、响应丢失”：服务端可能已写入，客户端视为失败，重试靠幂等去重 */
  const simulateFailure = ref(false);
  const logs = ref<LogEntry[]>([]);

  // ---------- 持久化 ----------

  function persistLocal() {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(local.value));
  }
  function persistServer() {
    localStorage.setItem(SERVER_KEY, JSON.stringify(server.value));
  }

  function log(text: string) {
    logs.value.unshift({ time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), text });
    if (logs.value.length > 60) logs.value.length = 60;
  }

  // ---------- 查询（列表 / 汇总 / 导出共用） ----------

  const rows = computed(() => reconRows(local.value.handovers, local.value.payments, local.value.outbox));
  const summary = computed(() => summarize(rows.value));
  const pendingCount = computed(() => local.value.outbox.length);
  const conflictCount = computed(() => rows.value.filter((r) => r.conflictPending).length);

  function handoverOf(id: string): Handover | undefined {
    return local.value.handovers.find((h) => h.id === id);
  }

  function currentPrice(fuelType: string): number {
    return priceAt(local.value.prices, fuelType, nowIso());
  }

  // ---------- 本地录入（离线可续作，一律先落本地 + 待传队列） ----------

  function touch(h: Handover) {
    h.version = Math.max(h.version, local.value.syncedVersion[h.id] ?? 0) + 1;
    h.updatedAt = nowIso();
  }

  function enqueueHandover(h: Handover) {
    // 同一交接单的待传快照只保留最新一版
    local.value.outbox = local.value.outbox.filter((op) => !(op.kind === "handover" && op.payload.id === h.id));
    local.value.outbox.push({ opId: uid(), kind: "handover", payload: clone(h), attempts: 0 });
  }

  function addHandover(input: { shiftDate: string; shift: string; notes: string }) {
    const h: Handover = {
      id: uid(),
      shiftDate: input.shiftDate,
      shift: input.shift,
      status: "待复核",
      readings: [],
      salesAmount: 0,
      notes: input.notes || "暂无备注",
      version: 1,
      updatedAt: nowIso(),
      origin: "站内",
      reviewedAt: null,
      recalcMark: null,
      conflict: null,
    };
    local.value.handovers.unshift(h);
    enqueueHandover(h);
    persistLocal();
    log(`已登记交接单 ${h.shiftDate} ${h.shift}，进入待传队列`);
  }

  function addReading(handoverId: string, reading: { pumpNo: string; fuelType: string; start: number; end: number }) {
    const h = handoverOf(handoverId);
    if (!h || h.conflict) return;
    if (isLocked(h.status)) {
      log(`交接单 ${h.shiftDate} ${h.shift} 已复核，读数锁定不可改`);
      return;
    }
    h.readings.push({ id: uid(), ...reading });
    h.salesAmount = computeSales(h.readings, local.value.prices, nowIso());
    h.recalcMark = null;
    touch(h);
    enqueueHandover(h);
    persistLocal();
    log(`已补录 ${h.shiftDate} ${h.shift} ${reading.pumpNo} 读数，销售额 ¥${h.salesAmount.toFixed(2)}`);
  }

  function addPayment(handoverId: string, method: string, amount: number) {
    const h = handoverOf(handoverId);
    if (!h || h.conflict) return;
    const payment: Payment = { id: uid(), handoverId, method, amount: round2(amount), createdAt: nowIso() };
    local.value.payments.push(payment);
    local.value.outbox.push({ opId: uid(), kind: "payment", payload: payment, attempts: 0 });
    persistLocal();
    log(`收款 ${method} ¥${payment.amount.toFixed(2)} 已入账（待传，幂等键 ${payment.id.slice(0, 8)}）`);
  }

  function addPrice(fuelType: string, price: number, effectiveAt: string) {
    const p: FuelPrice = { fuelType, price: round2(price), effectiveAt };
    local.value.prices.push(p);
    local.value.outbox.push({ opId: uid(), kind: "price", payload: p, attempts: 0 });
    const { handovers, changed } = recalcUnreviewed(local.value.handovers, local.value.prices, local.value.syncedVersion, nowIso());
    local.value.handovers = handovers;
    for (const h of changed) enqueueHandover(h);
    persistLocal();
    log(
      changed.length > 0
        ? `油价 ${fuelType} 调整为 ¥${price.toFixed(2)}/L，${changed.length} 张未复核交接单已按新价重算，已复核班次保持锁定`
        : `油价 ${fuelType} 调整为 ¥${price.toFixed(2)}/L，无需重算的未复核交接单`
    );
  }

  function review(id: string) {
    const h = handoverOf(id);
    if (!h || h.conflict || h.status !== "待复核") return;
    const row = rows.value.find((r) => r.id === id);
    const balanced = row ? Math.abs(row.diff) < 0.005 : true;
    h.status = balanced ? "已复核" : "有差异";
    h.reviewedAt = nowIso();
    touch(h);
    enqueueHandover(h);
    persistLocal();
    log(`复核 ${h.shiftDate} ${h.shift}：${balanced ? "账实一致，已复核" : "存在差异，标记有差异"}`);
  }

  function reopen(id: string) {
    const h = handoverOf(id);
    if (!h || h.conflict || h.status === "待复核") return;
    h.status = "待复核";
    h.reviewedAt = null;
    touch(h);
    enqueueHandover(h);
    persistLocal();
    log(`重新打开 ${h.shiftDate} ${h.shift}，回到待复核`);
  }

  function resolve(id: string, choice: "local" | "remote") {
    const idx = local.value.handovers.findIndex((h) => h.id === id);
    const h = local.value.handovers[idx];
    if (!h?.conflict) return;
    const winner = resolveConflict(h, choice, local.value.syncedVersion[id] ?? 0, nowIso());
    local.value.handovers[idx] = winner;
    enqueueHandover(winner);
    persistLocal();
    log(`站长核对 ${h.shiftDate} ${h.shift}：采用${choice === "local" ? "站内" : "中心"}版，待上传`);
  }

  function removeHandover(id: string) {
    const h = handoverOf(id);
    if (!h) return;
    local.value.handovers = local.value.handovers.filter((x) => x.id !== id);
    local.value.payments = local.value.payments.filter((p) => p.handoverId !== id);
    local.value.outbox = local.value.outbox.filter(
      (op) => !(op.kind === "handover" && op.payload.id === id) && !(op.kind === "payment" && op.payload.handoverId === id)
    );
    persistLocal();
    log(`已删除 ${h.shiftDate} ${h.shift}（仅本地，不影响中心端）`);
  }

  // ---------- 同步引擎 ----------

  function toggleOnline() {
    online.value = !online.value;
    if (online.value) {
      log("网络已恢复，开始合并双端记录");
      syncNow();
    } else {
      log("已断网：录入保存在本地，恢复后自动续传");
    }
  }

  function syncNow() {
    if (!online.value) {
      log("当前离线：待传内容保留在队列中");
      return;
    }
    if (simulateFailure.value) {
      // 请求已到达、响应丢失：服务端可能已写入，客户端按失败处理，保留待传并重试
      for (const op of local.value.outbox) {
        applyOpToServer(server.value, op);
        op.attempts += 1;
        log(`上传失败（第 ${op.attempts} 次）：${describeOp(op)}，已保留待重试`);
      }
      persistServer();
      persistLocal();
      log("网络异常，本次同步中止；恢复后重试不会重复入账");
      return;
    }

    // 1) 推送待传队列（幂等：重放不多账）
    for (const op of local.value.outbox) {
      const res = applyOpToServer(server.value, op);
      // 仅当中心端真正接收时才推进同步基线；版本过旧被拒的交接单留待合并阶段处理
      if (op.kind === "handover" && res.applied) {
        local.value.syncedVersion[op.payload.id] = op.payload.version;
      }
      log(`已上传：${res.note}`);
    }
    local.value.outbox = [];
    persistServer();

    // 2) 拉取中心端并合并
    let added = 0;
    let forwarded = 0;
    let conflicts = 0;
    for (const remote of server.value.handovers) {
      const idx = local.value.handovers.findIndex((h) => h.id === remote.id);
      if (idx === -1) {
        local.value.handovers.push(clone(remote));
        local.value.syncedVersion[remote.id] = remote.version;
        added += 1;
        continue;
      }
      const synced = local.value.syncedVersion[remote.id] ?? 0;
      const result = mergeHandover(local.value.handovers[idx], remote, synced, nowIso());
      if (result.action === "none") continue;
      local.value.syncedVersion[remote.id] = result.baseline;
      if (result.action === "fast-forward") {
        local.value.handovers[idx] = result.handover;
        forwarded += 1;
      } else if (result.action === "conflict") {
        local.value.handovers[idx] = result.handover;
        // 核对前不再自动上传该班次，避免覆盖中心端另一版
        local.value.outbox = local.value.outbox.filter((op) => !(op.kind === "handover" && op.payload.id === remote.id));
        conflicts += 1;
        log(`冲突：${remote.shiftDate} ${remote.shift} —— ${result.reason}`);
      }
    }

    const pm = mergePayments(local.value.payments, server.value.payments);
    local.value.payments = pm.merged;
    if (pm.added > 0) log(`合并中心端收款流水 ${pm.added} 笔（按幂等键去重）`);

    const pr = mergePrices(local.value.prices, server.value.prices);
    if (pr.added > 0) {
      local.value.prices = pr.merged;
      const { handovers, changed } = recalcUnreviewed(local.value.handovers, local.value.prices, local.value.syncedVersion, nowIso());
      local.value.handovers = handovers;
      for (const h of changed) enqueueHandover(h);
      log(`中心端油价更新 ${pr.added} 条，${changed.length} 张未复核交接单已重算`);
    }

    local.value.lastSyncAt = nowIso();
    persistLocal();
    log(`同步完成：新增 ${added}，更新 ${forwarded}，冲突待核 ${conflicts}，待传 ${local.value.outbox.length}`);
  }

  /** 演示用：模拟另一终端在中心端补录/改动同一班次 */
  function simulateServerEdit(targetId?: string) {
    const candidates = server.value.handovers;
    if (candidates.length === 0) return;
    const target =
      (targetId ? candidates.find((h) => h.id === targetId) : undefined) ??
      candidates.find((h) => h.status === "已复核") ??
      candidates[0];
    const idx = server.value.handovers.findIndex((h) => h.id === target.id);
    const copy = clone(target);
    const last = copy.readings[copy.readings.length - 1];
    if (last) last.end = round2(last.end + 50);
    copy.salesAmount = computeSales(copy.readings, server.value.prices, nowIso());
    copy.notes = `${copy.notes}（中心端补录）`;
    copy.version = target.version + 1;
    copy.updatedAt = nowIso();
    copy.origin = "中心";
    server.value.handovers[idx] = copy;
    persistServer();
    log(`中心端改动 ${copy.shiftDate} ${copy.shift}（v${copy.version}），联网同步后参与合并`);
  }

  // ---------- 导出 / 重置 ----------

  function exportCsv() {
    const csv = "﻿" + buildCsv(rows.value, summary.value);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    a.href = url;
    a.download = `交接对账-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    log("已导出对账 CSV（与列表、汇总同源）");
  }

  function resetAll() {
    local.value = seedLocal();
    server.value = seedServer();
    logs.value = [];
    persistLocal();
    persistServer();
    log("已重置演示数据");
  }

  return {
    local,
    server,
    online,
    simulateFailure,
    logs,
    rows,
    summary,
    pendingCount,
    conflictCount,
    handoverOf,
    currentPrice,
    addHandover,
    addReading,
    addPayment,
    addPrice,
    review,
    reopen,
    resolve,
    removeHandover,
    toggleOnline,
    syncNow,
    simulateServerEdit,
    exportCsv,
    resetAll,
  };
});
