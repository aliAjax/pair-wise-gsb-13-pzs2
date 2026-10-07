// 端到端场景测试：断网补录 → 恢复合并 → 冲突保护 → 失败重试幂等 → 油价重算
// 运行：node_modules/.bin/esbuild scripts/store.e2e.ts --bundle --format=esm --platform=node --outfile=scripts/.build/e2e.mjs && node scripts/.build/e2e.mjs
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";

// localStorage 内存替身（store 仅在调用时访问，import 时不触碰）
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  get length() {
    return mem.size;
  },
} as Storage;

const { useReconStore } = await import("../src/store");
setActivePinia(createPinia());
const store = useReconStore();

store.resetAll();

// 1) 初始：3 张交接单，销售额合计一致
assert.equal(store.rows.length, 3);
assert.equal(store.summary.sales, 33722 + 29228 + 6656);
console.log("PASS 初始种子与汇总");

// 2) 断网后离线续作：补收款、复核
store.toggleOnline();
assert.equal(store.online, false);
store.addPayment("h-1005-mid", "现金", 3028);
assert.equal(store.rows.find((r) => r.id === "h-1005-mid")!.diff, 0);
store.review("h-1005-mid");
assert.equal(store.handoverOf("h-1005-mid")!.status, "已复核");
assert.ok(store.pendingCount >= 2, "离线操作进入待传队列");
console.log("PASS 断网离线补录与复核");

// 3) 中心端改动同一已复核班次（迟到副本）
store.simulateServerEdit(); // 改的是服务端第一张“已复核”单 h-1005-early
const serverEarly = store.server.handovers.find((h) => h.id === "h-1005-early")!;
assert.equal(serverEarly.salesAmount > 33722, true);
console.log("PASS 模拟中心端改动");

// 4) 恢复网络 → 自动合并：站内已复核值不被覆盖，留两版待核对
store.toggleOnline();
const early = store.handoverOf("h-1005-early")!;
assert.equal(early.salesAmount, 33722, "站内已复核金额未被迟到副本覆盖");
assert.ok(early.conflict, "冲突挂起");
assert.equal(early.conflict!.remote.salesAmount, serverEarly.salesAmount, "中心版留存");
assert.equal(store.rows.find((r) => r.id === "h-1005-early")!.displayStatus, "冲突待核");
// 离线期间的复核与收款已上传
const serverMid = store.server.handovers.find((h) => h.id === "h-1005-mid")!;
assert.equal(serverMid.status, "已复核");
assert.equal(store.server.payments.filter((p) => p.handoverId === "h-1005-mid").length, 3);
console.log("PASS 恢复网络合并：已复核保护 + 两版待核 + 离线改动已上传");

// 5) 站长核对：采用站内版并上传
store.resolve("h-1005-early", "local");
assert.equal(store.handoverOf("h-1005-early")!.conflict, null);
store.syncNow();
const serverEarlyAfter = store.server.handovers.find((h) => h.id === "h-1005-early")!;
assert.equal(serverEarlyAfter.salesAmount, 33722, "中心端被纠正为站内版");
console.log("PASS 站长核对后上传生效");

// 6) 上传失败（响应丢失）→ 保留待传 → 重试幂等不多流水
store.simulateFailure = true;
store.addPayment("h-1006-early", "电子支付", 6656);
const payId = store.local.payments[store.local.payments.length - 1].id;
store.syncNow();
assert.equal(store.pendingCount > 0, true, "失败后待传保留");
assert.equal(store.server.payments.filter((p) => p.id === payId).length, 1, "服务端其实已收到一笔");
store.syncNow(); // 仍失败，重试一次
store.simulateFailure = false;
store.syncNow(); // 恢复后重放
assert.equal(store.pendingCount, 0);
assert.equal(store.server.payments.filter((p) => p.id === payId).length, 1, "重放后仍只有一笔流水");
assert.equal(store.local.payments.filter((p) => p.id === payId).length, 1);
console.log("PASS 上传失败保留待传，重试/重放不多收款流水");

// 7) 油价变化：未复核重算，已复核锁定
store.addPrice("95#汽油", 8.5, new Date().toISOString());
const earlyOpen = store.handoverOf("h-1006-early")!;
assert.equal(earlyOpen.salesAmount, 800 * 8.5, "未复核班次按新价重算");
assert.ok(earlyOpen.recalcMark, "重算标记已记录");
assert.equal(store.handoverOf("h-1005-early")!.salesAmount, 33722, "已复核班次锁定不变");
console.log("PASS 油价变化后未复核重算、已复核锁定");

// 8) 双端离线同版本分叉：推送被拒 → 基线不推进 → 合并留两版
store.resetAll();
store.toggleOnline(); // 离线
store.addReading("h-1005-mid", { pumpNo: "4号泵", fuelType: "92#汽油", start: 0, end: 100 });
store.simulateServerEdit("h-1005-mid"); // 中心端也改同一班 → 双端同为 v2 内容不同
store.toggleOnline(); // 恢复网络，自动同步
const mid = store.handoverOf("h-1005-mid")!;
assert.ok(mid.conflict, "同版本分叉被判为冲突");
assert.equal(mid.conflict!.local.readings.length, 3, "站内版读数保留");
assert.equal(store.rows.find((r) => r.id === "h-1005-mid")!.displayStatus, "冲突待核");
store.resolve("h-1005-mid", "local");
store.syncNow();
assert.equal(store.server.handovers.find((h) => h.id === "h-1005-mid")!.readings.length, 3, "核对后站内版上传生效");
console.log("PASS 双端同版本分叉：拒收→留两版→核对后上传");

// 9) 列表 / 汇总 / 导出同源
const rows = store.rows;
const sum = store.summary;
assert.equal(
  rows.reduce((s, r) => s + r.sales, 0).toFixed(2),
  sum.sales.toFixed(2)
);
console.log("PASS 列表与汇总同数（导出 CSV 共用同一视图，已在单元测试覆盖）");

console.log("\n端到端场景全部通过");
