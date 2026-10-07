/**
 * 领域逻辑验证：离线续作、合并冲突、油价重算、幂等重放、口径一致。
 * 运行方式见 package.json 的 verify 脚本（tsc 编译后用 node 执行）。
 * 与 store 一致：全程持有单一 db 对象，操作后统一持久化。
 */
function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(`断言失败：${message}`);
}
function equal<T>(actual: T, expected: T, message = "值应相等"): void {
  if (actual !== expected) {
    throw new Error(`断言失败：${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
  }
}

// ---- 在引入被测模块前 stub localStorage（模块内仅在函数里访问，无顶层副作用）----
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear()
};

import { loadStation, saveStation, loadCloud } from "../src/store/persistence";
import { pushOutbox, pullAndMerge } from "../src/store/sync";
import { cloudEditHandover } from "../src/store/cloud";
import { recalcUnreviewed, currentPrices } from "../src/domain/pricing";
import { buildReconRows, summarize, paymentTotal } from "../src/domain/reconcile";
import { mergePayments } from "../src/domain/merge";
import { toCsv } from "../src/domain/exporter";
import type { OutboxOp, Payment } from "../src/domain/types";

let seq = 0;
const uid = (p: string) => `${p}-test-${++seq}`;

// 与 shiftStore 相同：单一 db 持有 + 统一 persist
const db = loadStation();
const persist = () => saveStation(db);

function enqueue(payload: OutboxOp["payload"], opId = uid("op")) {
  db.outbox.push({ opId, payload, attempts: 0, lastError: null, enqueuedAt: Date.now() });
}

function markSynced(op: OutboxOp) {
  if (op.payload.kind !== "upsert-handover") return;
  const sent = op.payload.handover;
  const local = db.handovers.find((h) => h.id === sent.id);
  if (local && local.rev === sent.rev) local.syncedRev = local.rev;
}

/** 与 store.syncNow 相同：先推后拉，推送失败则保留队列、本次不再拉取 */
function syncCycle(flaky: boolean) {
  const push = pushOutbox(db, { flaky }, markSynced);
  if (!push.failed) pullAndMerge(db);
  persist();
  return push;
}

function localEditHandover(id: string, notes: string) {
  const h = db.handovers.find((x) => x.id === id)!;
  const next = { ...h, notes, rev: h.rev + 1, updatedAt: Date.now() };
  db.handovers[db.handovers.indexOf(h)] = next;
  enqueue({ kind: "upsert-handover", handover: next });
  persist();
  return next;
}

// ============ T1 离线续作：断网录入 → 恢复后推送合并 ============
{
  const before = db.outbox.length;
  const payment: Payment = {
    id: uid("pay"),
    handoverId: "ho-seed-c",
    method: "电子支付",
    amount: 132.8,
    createdAt: Date.now(),
    origin: "station"
  };
  db.payments.push(payment); // 离线也立即入账
  enqueue({ kind: "add-payment", payment }, payment.id);
  persist();
  equal(db.outbox.length, before + 1, "离线录入应进入待传队列");

  const push = syncCycle(false);
  equal(push.failed, false, "恢复后应推送成功");
  assert(loadCloud().payments.some((p) => p.id === payment.id), "恢复后收款应上传到云端");
  equal(db.outbox.length, 0, "推送成功后队列清空");
  equal(
    db.payments.filter((p) => p.id === payment.id).length,
    1,
    "自己上传的流水拉回不重复"
  );
  equal(paymentTotal(db.payments, "ho-seed-c"), 3132.8, "补录后收款应等于销售额");
  console.log("T1 离线续作→恢复合并 ✓");
}

// ============ T2 上传失败保留待传 + 重放幂等不多流水 ============
{
  const payment: Payment = {
    id: uid("pay"),
    handoverId: "ho-seed-b",
    method: "现金",
    amount: 100,
    createdAt: Date.now(),
    origin: "station"
  };
  db.payments.push(payment);
  enqueue({ kind: "add-payment", payment }, payment.id);
  persist();

  const cloudBefore = loadCloud().payments.length;
  const fail = syncCycle(true); // 云端已应用但确认丢失
  equal(fail.failed, true, "丢确认应视为上传失败");
  equal(db.outbox.length, 1, "失败后待传内容必须保留");
  equal(db.outbox[0].attempts, 1, "失败应记录重试次数");
  assert(db.outbox[0].lastError, "失败应记录错误");
  equal(loadCloud().payments.length, cloudBefore + 1, "云端其实已入账（确认丢失）");

  const retry = syncCycle(false); // 重试 → 重放
  equal(retry.failed, false, "重试应成功");
  equal(db.outbox.length, 0, "重试成功后队列清空");
  equal(loadCloud().payments.length, cloudBefore + 1, "重放不能多出收款流水");
  equal(
    db.payments.filter((p) => p.id === payment.id).length,
    1,
    "站内流水同样不重复"
  );
  console.log("T2 失败保留+重放幂等 ✓");
}

// ============ T3 两端各有改动：已复核值不被迟到副本覆盖，留两版 ============
{
  const local = localEditHandover("ho-seed-a", "站内复核后补充说明"); // 已复核班次本地再改
  cloudEditHandover("ho-seed-a", { salesAmount: 9999, notes: "中心端迟到副本" });

  // 本地改动尚未上传（断网场景），直接拉取合并
  pullAndMerge(db);
  persist();

  const h = db.handovers.find((x) => x.id === "ho-seed-a")!;
  equal(h.salesAmount, local.salesAmount, "已复核销售额不得被迟到副本覆盖");
  equal(h.notes, "站内复核后补充说明", "当前值保持站内版");
  equal(h.status, "已复核");
  const conflict = db.conflicts.find((c) => c.handoverId === "ho-seed-a");
  assert(conflict, "两端各有改动应留下冲突");
  equal(conflict!.incomingVersion.salesAmount, 9999, "迟到副本完整保留待核对");
  equal(conflict!.stationVersion.id, local.id);

  // 再拉一次：不重复报冲突
  pullAndMerge(db);
  equal(db.conflicts.filter((c) => c.handoverId === "ho-seed-a").length, 1, "同一远端版本不重复报冲突");
  console.log("T3 已复核保护+两版留档 ✓");
}

// ============ T4 未复核班次两端改动：同样留两版等站长核对 ============
{
  localEditHandover("ho-seed-b", "站内补录备注");
  cloudEditHandover("ho-seed-b", { notes: "对端也改了这班" });

  pullAndMerge(db);
  persist();

  const h = db.handovers.find((x) => x.id === "ho-seed-b")!;
  equal(h.notes, "站内补录备注", "未复核时当前值也用站内版");
  assert(db.conflicts.some((c) => c.handoverId === "ho-seed-b"), "未复核两端改动同样留两版");
  console.log("T4 未复核两端改动留两版 ✓");
}

// ============ T5 仅对端改动：直接合并进站内账本 ============
{
  cloudEditHandover("ho-seed-c", { notes: "中心端补充：现金已补齐" });
  const pull = pullAndMerge(db);
  persist();
  const h = db.handovers.find((x) => x.id === "ho-seed-c")!;
  equal(h.notes, "中心端补充：现金已补齐", "本地未改的应直接采用远端");
  assert(!db.conflicts.some((c) => c.handoverId === "ho-seed-c"), "无两端改动不报冲突");
  assert(pull.pulled >= 1, "应拉取到对端改动");
  console.log("T5 单向改动直接合并 ✓");
}

// ============ T6 油价变化：未复核重算，已复核锁定 ============
{
  const lockedA = db.handovers.find((x) => x.id === "ho-seed-a")!.salesAmount;
  const beforeB = db.handovers.find((x) => x.id === "ho-seed-b")!.salesAmount;

  db.prices.push({ fuelType: "95#汽油", price: 9.0, effectiveAt: Date.now() });
  const recalced = recalcUnreviewed(db.handovers, currentPrices(db.prices), Date.now());
  for (const h of recalced) {
    db.handovers[db.handovers.findIndex((x) => x.id === h.id)] = h;
  }
  persist();

  equal(
    db.handovers.find((x) => x.id === "ho-seed-a")!.salesAmount,
    lockedA,
    "已复核交接单销售额锁定不重算"
  );
  const b = db.handovers.find((x) => x.id === "ho-seed-b")!;
  assert(b.salesAmount !== beforeB, "未复核交接单应按新价重算");
  // B 班：95# 379L×9.0 + 92# 458L×7.85 = 3411 + 3595.30
  equal(b.salesAmount, 7006.3, "重算金额应与新价一致");
  console.log("T6 油价重算（未复核动、已复核锁） ✓");
}

// ============ T7 收款合并按幂等键去重 ============
{
  const local: Payment[] = [
    { id: "p1", handoverId: "h", method: "现金", amount: 10, createdAt: 1, origin: "station" }
  ];
  const remote: Payment[] = [
    { id: "p1", handoverId: "h", method: "现金", amount: 10, createdAt: 1, origin: "cloud" },
    { id: "p2", handoverId: "h", method: "电子支付", amount: 20, createdAt: 2, origin: "cloud" }
  ];
  const merged = mergePayments(local, remote);
  equal(merged.payments.length, 2, "同幂等键只保留一笔");
  equal(merged.added, 1);
  console.log("T7 收款流水幂等并集 ✓");
}

// ============ T8 列表 / 汇总 / 导出同一对账状态与收入 ============
{
  const rows = buildReconRows(db.handovers, db.payments, db.conflicts);
  const summary = summarize(rows);
  const csv = toCsv(rows);

  const conflictRow = rows.find((r) => r.handover.id === "ho-seed-a")!;
  equal(conflictRow.status, "有冲突", "有未决冲突的班次列表状态应为有冲突");
  assert(csv.includes("有冲突"), "导出与列表状态一致");
  assert(csv.includes(summary.receivedSum.toFixed(2)), "导出合计收入与汇总一致");
  equal(
    summary.receivedSum,
    Math.round(rows.reduce((a, r) => a + r.received, 0) * 100) / 100,
    "汇总收入与列表逐行之和一致"
  );
  const header = csv.split("\n")[0];
  assert(header.includes("对账状态") && header.includes("收款合计"), "导出包含状态与收入列");
  console.log("T8 列表/汇总/导出同口径 ✓");
}

console.log("\n全部验证通过。");
