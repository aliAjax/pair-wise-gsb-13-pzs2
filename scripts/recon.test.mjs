// 核心对账逻辑测试：node scripts/recon.test.mjs
// 先编译：npx tsc src/lib/recon.ts --outDir scripts/.build --module ES2020 --target ES2020 --skipLibCheck
import assert from "node:assert/strict";
import {
  applyOpToServer,
  buildCsv,
  businessDiffers,
  computeSales,
  mergeHandover,
  mergePayments,
  mergePrices,
  recalcUnreviewed,
  reconRows,
  resolveConflict,
  summarize,
} from "./.build/recon.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const prices = [
  { fuelType: "92#汽油", price: 7.85, effectiveAt: "2026-10-01T00:00:00.000Z" },
  { fuelType: "0#柴油", price: 7.12, effectiveAt: "2026-10-01T00:00:00.000Z" },
];

const mkHandover = (over = {}) => ({
  id: "h1",
  shiftDate: "2026-10-06",
  shift: "早班",
  status: "待复核",
  readings: [{ id: "r1", pumpNo: "1号泵", fuelType: "92#汽油", start: 100, end: 200 }],
  salesAmount: 785,
  notes: "备注",
  version: 1,
  updatedAt: "2026-10-06T08:00:00.000Z",
  origin: "站内",
  reviewedAt: null,
  recalcMark: null,
  conflict: null,
  ...over,
});

const NOW = "2026-10-06T12:00:00.000Z";

test("销售额按生效油价计算", () => {
  const readings = [
    { id: "a", pumpNo: "1号泵", fuelType: "92#汽油", start: 0, end: 100 },
    { id: "b", pumpNo: "3号泵", fuelType: "0#柴油", start: 0, end: 50 },
  ];
  assert.equal(computeSales(readings, prices, NOW), 100 * 7.85 + 50 * 7.12);
});

test("合并：中心端无新版本 → 不动", () => {
  const local = mkHandover({ version: 3 });
  const remote = mkHandover({ version: 2 });
  assert.equal(mergeHandover(local, remote, 2, NOW).action, "none");
});

test("合并：仅中心端改动且站内未复核 → 直接采用", () => {
  const local = mkHandover({ version: 1 });
  const remote = mkHandover({ version: 2, notes: "中心端补充", updatedAt: "2026-10-06T09:00:00.000Z" });
  const r = mergeHandover(local, remote, 1, NOW);
  assert.equal(r.action, "fast-forward");
  assert.equal(r.handover.notes, "中心端补充");
});

test("合并：站内已复核不被迟到副本覆盖，留两版", () => {
  const local = mkHandover({ status: "已复核", version: 2, salesAmount: 785 });
  const remote = mkHandover({ version: 3, salesAmount: 999, notes: "迟到副本" });
  const r = mergeHandover(local, remote, 2, NOW);
  assert.equal(r.action, "conflict");
  assert.equal(r.handover.salesAmount, 785, "生效值仍是站内已复核金额");
  assert.equal(r.handover.status, "已复核");
  assert.equal(r.handover.conflict.remote.salesAmount, 999, "中心版保留待核对");
  assert.equal(r.handover.conflict.local.salesAmount, 785);
});

test("合并：双端均改动且站内已复核 → 站内版生效，两版留存", () => {
  const local = mkHandover({ status: "已复核", version: 3, salesAmount: 800 });
  const remote = mkHandover({ version: 3, salesAmount: 900, notes: "中心端改" });
  const r = mergeHandover(local, remote, 2, NOW);
  assert.equal(r.action, "conflict");
  assert.equal(r.handover.salesAmount, 800);
  assert.ok(r.handover.conflict);
});

test("合并：双端均未复核 → 取较新一版生效，仍留两版", () => {
  const local = mkHandover({ version: 3, notes: "站内改", updatedAt: "2026-10-06T10:00:00.000Z" });
  const remote = mkHandover({ version: 3, notes: "中心改", updatedAt: "2026-10-06T11:00:00.000Z" });
  const r = mergeHandover(local, remote, 2, NOW);
  assert.equal(r.action, "conflict");
  assert.equal(r.handover.notes, "中心改");
  assert.equal(r.handover.conflict.local.notes, "站内改");
});

test("冲突解决：采用任一版后版本号超过双端", () => {
  const local = mkHandover({ status: "已复核", version: 3, salesAmount: 800 });
  const remote = mkHandover({ version: 5, salesAmount: 900 });
  const conflicted = mergeHandover(local, remote, 2, NOW).handover;
  const resolved = resolveConflict(conflicted, "remote", 5, NOW);
  assert.equal(resolved.conflict, null);
  assert.equal(resolved.salesAmount, 900);
  assert.ok(resolved.version > 5);
});

test("收款流水重放不多账（幂等）", () => {
  const server = { handovers: [], payments: [], prices: [] };
  const op = {
    opId: "o1",
    kind: "payment",
    payload: { id: "pay-1", handoverId: "h1", method: "现金", amount: 100, createdAt: NOW },
    attempts: 0,
  };
  applyOpToServer(server, op);
  const replay = applyOpToServer(server, op); // 响应丢失后的重试
  applyOpToServer(server, op);
  assert.equal(server.payments.length, 1, "重放后仍只有一笔流水");
  assert.match(replay.note, /幂等/);
});

test("交接单旧版本重放被忽略", () => {
  const server = { handovers: [], payments: [], prices: [] };
  applyOpToServer(server, { opId: "o1", kind: "handover", payload: mkHandover({ version: 3 }), attempts: 0 });
  const r = applyOpToServer(server, { opId: "o2", kind: "handover", payload: mkHandover({ version: 2 }), attempts: 0 });
  assert.match(r.note, /过旧/);
  assert.equal(r.applied, false);
  assert.equal(server.handovers[0].version, 3);
});

test("双端同版本不同内容：中心端拒收待合并，同内容重放幂等", () => {
  const server = { handovers: [], payments: [], prices: [] };
  applyOpToServer(server, { opId: "o1", kind: "handover", payload: mkHandover({ version: 2, notes: "中心版" }), attempts: 0 });
  const divergent = applyOpToServer(server, { opId: "o2", kind: "handover", payload: mkHandover({ version: 2, notes: "站内版" }), attempts: 0 });
  assert.equal(divergent.applied, false, "同版本不同内容被拒收");
  assert.equal(server.handovers[0].notes, "中心版", "中心端内容未被覆盖");
  const replay = applyOpToServer(server, { opId: "o3", kind: "handover", payload: mkHandover({ version: 2, notes: "中心版" }), attempts: 0 });
  assert.equal(replay.applied, true, "同内容重放幂等接收");
  assert.equal(server.handovers.length, 1);
});

test("油价变化：未复核重算，已复核锁定", () => {
  const locked = mkHandover({ id: "h-lock", status: "已复核", salesAmount: 785, version: 2 });
  const open = mkHandover({ id: "h-open", salesAmount: 785, version: 2 });
  const newPrices = [...prices, { fuelType: "92#汽油", price: 8.0, effectiveAt: "2026-10-06T00:00:00.000Z" }];
  const { handovers, changed } = recalcUnreviewed([locked, open], newPrices, {}, NOW);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].id, "h-open");
  assert.equal(handovers[1].salesAmount, 800, "100L × 8.0");
  assert.ok(handovers[1].version > 2, "重算后版本推进");
  assert.equal(handovers[0].salesAmount, 785, "已复核金额锁定");
});

test("收款/油价并集合并幂等", () => {
  const p = { id: "p1", handoverId: "h1", method: "现金", amount: 10, createdAt: NOW };
  const a = mergePayments([p], [p, { ...p, id: "p2" }]);
  assert.equal(a.merged.length, 2);
  assert.equal(a.added, 1);
  const b = mergePayments(a.merged, a.merged);
  assert.equal(b.added, 0);
  const pr = mergePrices(prices, prices);
  assert.equal(pr.added, 0);
});

test("列表 / 汇总 / 导出同源同数", () => {
  const handovers = [
    mkHandover({ id: "h1", status: "已复核", salesAmount: 100 }),
    mkHandover({ id: "h2", shift: "中班", salesAmount: 200, conflict: null }),
  ];
  const payments = [
    { id: "p1", handoverId: "h1", method: "现金", amount: 100, createdAt: NOW },
    { id: "p2", handoverId: "h2", method: "电子支付", amount: 150, createdAt: NOW },
  ];
  const rows = reconRows(handovers, payments, []);
  const summary = summarize(rows);
  assert.equal(summary.sales, 300);
  assert.equal(summary.received, 250);
  assert.equal(summary.diff, -50);
  const csv = buildCsv(rows, summary);
  assert.match(csv, /300\.00/, "导出含同一销售额合计");
  assert.match(csv, /250\.00/, "导出含同一实收合计");
  assert.match(csv, /-50\.00/, "导出含同一差异");
  assert.equal(rows.find((r) => r.id === "h1").displayStatus, "已复核");
});

test("待传队列驱动同步状态展示", () => {
  const h = mkHandover({ id: "h1" });
  const rows = reconRows([h], [], [{ opId: "o", kind: "handover", payload: h, attempts: 0 }]);
  assert.equal(rows[0].syncState, "待传");
  const rows2 = reconRows([h], [], []);
  assert.equal(rows2[0].syncState, "已同步");
});

test("businessDiffers 忽略版本号只比业务字段", () => {
  const a = mkHandover({ version: 1 });
  const b = mkHandover({ version: 9, updatedAt: "2027-01-01T00:00:00.000Z" });
  assert.equal(businessDiffers(a, b), false);
  assert.equal(businessDiffers(a, { ...b, salesAmount: 1 }), true);
});

console.log(`\n${passed} 项通过`);
