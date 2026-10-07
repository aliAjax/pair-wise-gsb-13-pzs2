// 加油站班次交接 —— 离线对账核心逻辑
// 全部为纯函数 / 纯数据，不依赖 Vue 与浏览器 API，便于单元测试。

export const SHIFTS = ["早班", "中班", "晚班"] as const;
export const FUEL_TYPES = ["92#汽油", "95#汽油", "0#柴油"] as const;
export const PAY_METHODS = ["现金", "电子支付", "油卡"] as const;
export const PUMPS = ["1号泵", "2号泵", "3号泵", "4号泵"] as const;

export type BaseStatus = "待复核" | "已复核" | "有差异";
export const BASE_STATUSES: BaseStatus[] = ["待复核", "已复核", "有差异"];
export const CONFLICT_STATUS = "冲突待核";

export interface PumpReading {
  id: string;
  pumpNo: string;
  fuelType: string;
  start: number;
  end: number;
}

/** 冲突快照：去掉 conflict 字段，避免无限嵌套 */
export type HandoverSnapshot = Omit<Handover, "conflict">;

export interface Handover {
  id: string;
  shiftDate: string; // YYYY-MM-DD
  shift: string;
  status: BaseStatus;
  readings: PumpReading[];
  salesAmount: number; // 销售额，按录入/重算时的油价计算
  notes: string;
  version: number; // 逻辑版本：每次改动 = max(自身, 同步基线) + 1
  updatedAt: string;
  origin: "站内" | "中心";
  reviewedAt: string | null;
  recalcMark: string | null; // 油价变动触发重算的时间标记
  conflict: { local: HandoverSnapshot; remote: HandoverSnapshot; detectedAt: string } | null;
}

export interface Payment {
  id: string; // 客户端生成的幂等键，重放不入重复流水
  handoverId: string;
  method: string;
  amount: number;
  createdAt: string;
}

export interface FuelPrice {
  fuelType: string;
  price: number;
  effectiveAt: string;
}

export type Op =
  | { opId: string; kind: "handover"; payload: Handover; attempts: number }
  | { opId: string; kind: "payment"; payload: Payment; attempts: number }
  | { opId: string; kind: "price"; payload: FuelPrice; attempts: number };

export interface LocalState {
  handovers: Handover[];
  payments: Payment[];
  prices: FuelPrice[];
  outbox: Op[];
  /** 各交接单最近一次成功同步时的版本（合并基线） */
  syncedVersion: Record<string, number>;
  lastSyncAt: string | null;
}

/** 模拟中心端（真实部署时替换为服务端接口） */
export interface ServerState {
  handovers: Handover[];
  payments: Payment[];
  prices: FuelPrice[];
}

// ---------- 基础工具 ----------

export function uid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clone<T>(value: T): T {
  // 状态均为可 JSON 序列化数据；JSON 深拷贝兼容 Vue 响应式 Proxy（structuredClone 会抛 DataCloneError）
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 已复核类状态（已复核 / 有差异）锁定金额，不被迟到副本覆盖、不参与重算 */
export function isLocked(status: BaseStatus): boolean {
  return status !== "待复核";
}

export function snapshot(h: Handover): HandoverSnapshot {
  const { conflict: _conflict, ...rest } = h;
  return clone(rest);
}

// ---------- 油价与销售额 ----------

/** 指定时间点的生效油价：取 effectiveAt <= at 的最新一档 */
export function priceAt(prices: FuelPrice[], fuelType: string, at: string): number {
  let best: FuelPrice | null = null;
  for (const p of prices) {
    if (p.fuelType !== fuelType || p.effectiveAt > at) continue;
    if (!best || p.effectiveAt > best.effectiveAt) best = p;
  }
  return best ? best.price : 0;
}

export function readingVolume(r: PumpReading): number {
  return round2(r.end - r.start);
}

export function computeSales(readings: PumpReading[], prices: FuelPrice[], at: string): number {
  const total = readings.reduce((acc, r) => acc + readingVolume(r) * priceAt(prices, r.fuelType, at), 0);
  return round2(total);
}

/**
 * 油价变化后重算：仅未复核（待复核）交接单重算销售额；
 * 已复核 / 有差异班次金额锁定不动。返回新数组与被重算的单据。
 */
export function recalcUnreviewed(
  handovers: Handover[],
  prices: FuelPrice[],
  syncedVersion: Record<string, number>,
  at: string
): { handovers: Handover[]; changed: Handover[] } {
  const changed: Handover[] = [];
  const next = handovers.map((h) => {
    if (isLocked(h.status)) return h;
    const amount = computeSales(h.readings, prices, at);
    if (Math.abs(amount - h.salesAmount) < 0.005) return h;
    const updated: Handover = {
      ...h,
      salesAmount: amount,
      recalcMark: at,
      version: Math.max(h.version, syncedVersion[h.id] ?? 0) + 1,
      updatedAt: at,
    };
    changed.push(updated);
    return updated;
  });
  return { handovers: next, changed };
}

// ---------- 合并与冲突 ----------

/** 业务字段是否一致（忽略版本号、时间戳、冲突挂起等元数据） */
export function businessDiffers(a: Handover, b: Handover): boolean {
  if (a.shiftDate !== b.shiftDate || a.shift !== b.shift) return true;
  if (a.status !== b.status || a.notes !== b.notes) return true;
  if (Math.abs(a.salesAmount - b.salesAmount) > 0.005) return true;
  if (a.readings.length !== b.readings.length) return true;
  const key = (r: PumpReading) => `${r.pumpNo}|${r.fuelType}|${r.start}|${r.end}`;
  const as = a.readings.map(key).sort();
  const bs = b.readings.map(key).sort();
  return as.some((v, i) => v !== bs[i]);
}

export type MergeResult =
  | { action: "none" }
  | { action: "ack"; baseline: number }
  | { action: "fast-forward"; baseline: number; handover: Handover }
  | { action: "conflict"; baseline: number; handover: Handover; reason: string };

/**
 * 合并中心端来单。规则：
 * 1. 中心端无新版本 → 不动；
 * 2. 仅中心端改动：站内未复核 → 直接采用；站内已复核 → 迟到副本不得覆盖，留两版待站长核对；
 * 3. 双端均有改动且内容不一致 → 一律留两版待站长核对；
 *    生效值优先保留已复核方（站内已复核绝不降级），都未复核时取更新时间较新者。
 */
export function mergeHandover(local: Handover, remote: Handover, synced: number, at: string): MergeResult {
  const localChanged = local.version > synced;
  const remoteChanged = remote.version > synced;
  if (!remoteChanged) return { action: "none" };
  const baseline = remote.version;

  // 已挂起冲突：中心端又有新版本时只刷新中心端快照，继续等站长核对
  if (local.conflict) {
    if (!businessDiffers(local.conflict.remote as Handover, remote)) return { action: "ack", baseline };
    const handover: Handover = { ...local, conflict: { ...local.conflict, remote: snapshot(remote) } };
    return { action: "conflict", baseline, handover, reason: "冲突未核对，中心端又推来新版本" };
  }

  if (!businessDiffers(local, remote)) return { action: "ack", baseline };

  const keepBoth = (effective: Handover, reason: string): MergeResult => ({
    action: "conflict",
    baseline,
    reason,
    handover: {
      ...effective,
      conflict: { local: snapshot(local), remote: snapshot(remote), detectedAt: at },
    },
  });

  if (!localChanged) {
    if (isLocked(local.status)) {
      return keepBoth(local, "站内已复核，中心端迟到副本未覆盖，留两版待站长核对");
    }
    return { action: "fast-forward", baseline, handover: { ...clone(remote), conflict: null } };
  }

  // 双端均有改动
  if (isLocked(local.status)) {
    return keepBoth(local, "双端均有改动，站内已复核值保留生效，中心版留待站长核对");
  }
  if (isLocked(remote.status)) {
    return keepBoth(remote, "双端均有改动，中心端已复核，站内修改留待站长核对");
  }
  const newer = remote.updatedAt > local.updatedAt ? remote : local;
  return keepBoth(newer, "双端均有改动且均未复核，暂取较新一版，两版待站长核对");
}

/** 冲突解决：采用某一版，版本号推到双端之上，等待下次上传 */
export function resolveConflict(
  handover: Handover,
  choice: "local" | "remote",
  synced: number,
  at: string
): Handover {
  if (!handover.conflict) return handover;
  const chosen = choice === "local" ? handover.conflict.local : handover.conflict.remote;
  const base = Math.max(handover.version, handover.conflict.local.version, handover.conflict.remote.version, synced);
  return {
    ...(clone(chosen) as Handover),
    conflict: null,
    version: base + 1,
    updatedAt: at,
    origin: choice === "local" ? "站内" : "中心",
  };
}

// ---------- 收款流水（幂等） ----------

/** 按幂等键（id）求并集，重放不会多出流水 */
export function mergePayments(local: Payment[], remote: Payment[]): { merged: Payment[]; added: number } {
  const seen = new Map<string, Payment>();
  for (const p of [...local, ...remote]) if (!seen.has(p.id)) seen.set(p.id, p);
  const merged = [...seen.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { merged, added: merged.length - local.length };
}

/** 油价按 (油品, 生效时间) 求并集 */
export function mergePrices(local: FuelPrice[], remote: FuelPrice[]): { merged: FuelPrice[]; added: number } {
  const key = (p: FuelPrice) => `${p.fuelType}|${p.effectiveAt}`;
  const seen = new Map<string, FuelPrice>();
  for (const p of [...local, ...remote]) if (!seen.has(key(p))) seen.set(key(p), p);
  const merged = [...seen.values()].sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
  return { merged, added: merged.length - local.length };
}

/**
 * 服务端应用一条待传操作（幂等）：
 * - 收款流水按 id 去重，重放只记一笔；
 * - 交接单按版本 upsert，旧版本重放直接忽略（applied=false，调用方不得推进同步基线）；
 * - 油价按 (油品, 生效时间) upsert。
 */
export function applyOpToServer(server: ServerState, op: Op): { note: string; applied: boolean } {
  if (op.kind === "payment") {
    const p = op.payload;
    if (server.payments.some((x) => x.id === p.id)) {
      return { applied: true, note: `收款流水 ${p.id.slice(0, 8)} 已存在，幂等跳过 ¥${p.amount.toFixed(2)}` };
    }
    server.payments.push(clone(p));
    return { applied: true, note: `收款流水入账 ${p.method} ¥${p.amount.toFixed(2)}` };
  }
  if (op.kind === "handover") {
    const h = op.payload;
    const idx = server.handovers.findIndex((x) => x.id === h.id);
    if (idx >= 0) {
      const current = server.handovers[idx];
      if (current.version > h.version) {
        return { applied: false, note: `交接单 ${h.shiftDate} ${h.shift} v${h.version} 版本过旧，忽略` };
      }
      // 双端离线各自改到同一版本号但内容不同：拒收，交由合并流程留两版
      if (current.version === h.version && businessDiffers(current, h)) {
        return { applied: false, note: `交接单 ${h.shiftDate} ${h.shift} v${h.version} 双端同版本内容冲突，待合并` };
      }
      server.handovers[idx] = clone(h);
    } else {
      server.handovers.push(clone(h));
    }
    return { applied: true, note: `交接单 ${h.shiftDate} ${h.shift} v${h.version} 已接收` };
  }
  const price = op.payload;
  const idx = server.prices.findIndex((x) => x.fuelType === price.fuelType && x.effectiveAt === price.effectiveAt);
  if (idx >= 0) server.prices[idx] = clone(price);
  else server.prices.push(clone(price));
  return { applied: true, note: `油价 ${price.fuelType} ¥${price.price.toFixed(2)}/L 已接收` };
}

// ---------- 对账视图模型（列表 / 汇总 / 导出共用同一来源） ----------

export interface ReconRow {
  id: string;
  shiftDate: string;
  shift: string;
  baseStatus: BaseStatus;
  displayStatus: string;
  conflictPending: boolean;
  volume: number;
  sales: number;
  received: number;
  diff: number;
  syncState: "待传" | "已同步" | "冲突待核";
  notes: string;
  recalcMark: string | null;
  updatedAt: string;
  version: number;
}

const SHIFT_ORDER: Record<string, number> = { 早班: 0, 中班: 1, 晚班: 2 };

export function reconRows(handovers: Handover[], payments: Payment[], outbox: Op[]): ReconRow[] {
  const pendingIds = new Set<string>();
  for (const op of outbox) {
    if (op.kind === "handover") pendingIds.add(op.payload.id);
    if (op.kind === "payment") pendingIds.add(op.payload.handoverId);
  }
  const rows = handovers.map((h): ReconRow => {
    const received = round2(payments.filter((p) => p.handoverId === h.id).reduce((s, p) => s + p.amount, 0));
    const volume = round2(h.readings.reduce((s, r) => s + readingVolume(r), 0));
    const conflictPending = h.conflict !== null;
    return {
      id: h.id,
      shiftDate: h.shiftDate,
      shift: h.shift,
      baseStatus: h.status,
      displayStatus: conflictPending ? CONFLICT_STATUS : h.status,
      conflictPending,
      volume,
      sales: h.salesAmount,
      received,
      diff: round2(received - h.salesAmount),
      syncState: conflictPending ? "冲突待核" : pendingIds.has(h.id) ? "待传" : "已同步",
      notes: h.notes,
      recalcMark: h.recalcMark,
      updatedAt: h.updatedAt,
      version: h.version,
    };
  });
  return rows.sort(
    (a, b) =>
      b.shiftDate.localeCompare(a.shiftDate) ||
      (SHIFT_ORDER[a.shift] ?? 9) - (SHIFT_ORDER[b.shift] ?? 9)
  );
}

export interface Summary {
  total: number;
  byStatus: Record<string, number>;
  sales: number;
  received: number;
  diff: number;
}

export function summarize(rows: ReconRow[]): Summary {
  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.displayStatus] = (byStatus[row.displayStatus] ?? 0) + 1;
  return {
    total: rows.length,
    byStatus,
    sales: round2(rows.reduce((s, r) => s + r.sales, 0)),
    received: round2(rows.reduce((s, r) => s + r.received, 0)),
    diff: round2(rows.reduce((s, r) => s + r.diff, 0)),
  };
}

// ---------- 导出 ----------

const CSV_HEADER = ["日期", "班次", "对账状态", "销量(L)", "销售额(元)", "实收(元)", "差异(元)", "同步状态", "备注"];

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 导出与列表/汇总同源：同样的状态与收入数字 */
export function buildCsv(rows: ReconRow[], summary: Summary): string {
  const lines = [CSV_HEADER.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [r.shiftDate, r.shift, r.displayStatus, r.volume.toFixed(2), r.sales.toFixed(2), r.received.toFixed(2), r.diff.toFixed(2), r.syncState, r.notes]
        .map(csvCell)
        .join(",")
    );
  }
  lines.push(
    ["合计", "", String(summary.total) + "单", "", summary.sales.toFixed(2), summary.received.toFixed(2), summary.diff.toFixed(2), "", ""]
      .map(csvCell)
      .join(",")
  );
  return lines.join("\n");
}

// ---------- 展示格式化 ----------

export function formatMoney(n: number): string {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function describeOp(op: Op): string {
  if (op.kind === "handover") return `交接单 ${op.payload.shiftDate} ${op.payload.shift} v${op.payload.version}`;
  if (op.kind === "payment") return `收款 ${op.payload.method} ¥${op.payload.amount.toFixed(2)}`;
  return `油价 ${op.payload.fuelType} ¥${op.payload.price.toFixed(2)}/L`;
}
