import type { ConflictPair, FuelType, Handover, NozzleReading, Payment, ReconStatus } from "./types";

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function readingVolume(r: Pick<NozzleReading, "opening" | "closing">): number {
  return round2(Math.max(0, r.closing - r.opening));
}

/** 单班总销量（升） */
export function handoverVolume(h: Pick<Handover, "readings">): number {
  return round2(h.readings.reduce((acc, r) => acc + readingVolume(r), 0));
}

/** 按油价表计算销售额 */
export function computeSales(h: Pick<Handover, "readings">, prices: Record<FuelType, number>): number {
  return round2(
    h.readings.reduce((acc, r) => acc + readingVolume(r) * (prices[r.fuelType] ?? 0), 0)
  );
}

/** 某班次的收款合计（收款流水按幂等键唯一，天然不重复） */
export function paymentTotal(payments: Payment[], handoverId: string): number {
  return round2(
    payments.filter((p) => p.handoverId === handoverId).reduce((acc, p) => acc + p.amount, 0)
  );
}

export function reconStatusOf(h: Handover, received: number, hasConflict: boolean): ReconStatus {
  if (hasConflict) return "有冲突";
  if (h.status === "已复核") return "已复核";
  return Math.abs(round2(received - h.salesAmount)) > 0.005 ? "有差异" : "待复核";
}

/** 对账行：列表、汇总、导出共用同一份派生结果 */
export interface ReconRow {
  handover: Handover;
  volume: number;
  salesAmount: number;
  received: number;
  diff: number;
  status: ReconStatus;
}

export function buildReconRows(
  handovers: Handover[],
  payments: Payment[],
  conflicts: ConflictPair[]
): ReconRow[] {
  const conflictIds = new Set(conflicts.map((c) => c.handoverId));
  return handovers
    .filter((h) => !h.deleted)
    .map((h) => {
      const received = paymentTotal(payments, h.id);
      const diff = round2(received - h.salesAmount);
      return {
        handover: h,
        volume: handoverVolume(h),
        salesAmount: h.salesAmount,
        received,
        diff,
        status: reconStatusOf(h, received, conflictIds.has(h.id))
      };
    })
    .sort((a, b) => b.handover.updatedAt - a.handover.updatedAt);
}

export interface ReconSummary {
  total: number;
  pending: number;
  reviewed: number;
  diff: number;
  conflict: number;
  salesSum: number;
  receivedSum: number;
  diffSum: number;
}

/** 汇总与列表、导出走同一批 ReconRow，保证状态与收入口径一致 */
export function summarize(rows: ReconRow[]): ReconSummary {
  return {
    total: rows.length,
    pending: rows.filter((r) => r.status === "待复核").length,
    reviewed: rows.filter((r) => r.status === "已复核").length,
    diff: rows.filter((r) => r.status === "有差异").length,
    conflict: rows.filter((r) => r.status === "有冲突").length,
    salesSum: round2(rows.reduce((a, r) => a + r.salesAmount, 0)),
    receivedSum: round2(rows.reduce((a, r) => a + r.received, 0)),
    diffSum: round2(rows.reduce((a, r) => a + r.diff, 0))
  };
}
