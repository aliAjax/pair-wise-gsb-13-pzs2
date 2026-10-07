// 领域模型：班次交接单、油枪读数、收款流水、油价、同步与冲突
export type ShiftName = "早班" | "中班" | "晚班";
export type FuelType = "92#汽油" | "95#汽油" | "0#柴油";
export type PayMethod = "现金" | "电子支付" | "加油卡";
export type ReviewStatus = "待复核" | "已复核";
/** 对账状态：由交接单复核态 + 收款差额 + 冲突派生，列表/汇总/导出共用 */
export type ReconStatus = "待复核" | "已复核" | "有差异" | "有冲突";
export type Origin = "station" | "cloud";

export const SHIFT_NAMES: ShiftName[] = ["早班", "中班", "晚班"];
export const FUEL_TYPES: FuelType[] = ["92#汽油", "95#汽油", "0#柴油"];
export const PAY_METHODS: PayMethod[] = ["现金", "电子支付", "加油卡"];

/** 油枪读数：开班/收班表数，销量 = 收班 - 开班 */
export interface NozzleReading {
  nozzleId: string;
  fuelType: FuelType;
  opening: number;
  closing: number;
}

/** 班次交接单 */
export interface Handover {
  id: string;
  shiftDate: string; // YYYY-MM-DD
  shift: ShiftName;
  operator: string;
  readings: NozzleReading[];
  /** 销售额：按油价快照计算；未复核时随油价变化重算，复核后锁定 */
  salesAmount: number;
  priceSnapshot: Record<FuelType, number>;
  status: ReviewStatus;
  notes: string;
  /** 本地修订号与已和云端对齐的修订号，用于检出“两端各有改动” */
  rev: number;
  syncedRev: number;
  updatedAt: number;
  origin: Origin;
  deleted: boolean;
}

/** 收款流水：id 即幂等键，重放不会重复入账 */
export interface Payment {
  id: string;
  handoverId: string;
  method: PayMethod;
  amount: number;
  createdAt: number;
  origin: Origin;
}

/** 油价变动记录（按生效时间取最新） */
export interface PriceRecord {
  fuelType: FuelType;
  price: number;
  effectiveAt: number;
}

/** 两端各有改动时保留的两版，等站长核对 */
export interface ConflictPair {
  handoverId: string;
  stationVersion: Handover;
  incomingVersion: Handover;
  detectedAt: number;
}

export type OutboxPayload =
  | { kind: "upsert-handover"; handover: Handover }
  | { kind: "add-payment"; payment: Payment }
  | { kind: "price-change"; record: PriceRecord };

/** 待传操作：上传失败保留在队列中，可重试 */
export interface OutboxOp {
  opId: string; // 幂等键
  payload: OutboxPayload;
  attempts: number;
  lastError: string | null;
  enqueuedAt: number;
}

export interface SyncLogEntry {
  at: number;
  message: string;
}

/** 站内库（本机 localStorage） */
export interface StationDb {
  handovers: Handover[];
  payments: Payment[];
  prices: PriceRecord[];
  conflicts: ConflictPair[];
  outbox: OutboxOp[];
  log: SyncLogEntry[];
}

/** 模拟云端库（中心端/另一终端），独立 localStorage 命名空间 */
export interface CloudDb {
  handovers: Handover[];
  payments: Payment[];
  prices: PriceRecord[];
  /** 已应用过的操作幂等键：重放直接返回成功，不再重复入账 */
  appliedOpIds: string[];
}
