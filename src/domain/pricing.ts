import { computeSales } from "./reconcile";
import type { FuelType, Handover, PriceRecord } from "./types";
import { FUEL_TYPES } from "./types";

/** 取某一时刻的生效油价 */
export function currentPrices(prices: PriceRecord[], at = Date.now()): Record<FuelType, number> {
  const result = Object.fromEntries(FUEL_TYPES.map((f) => [f, 0])) as Record<FuelType, number>;
  for (const rec of [...prices].sort((a, b) => a.effectiveAt - b.effectiveAt)) {
    if (rec.effectiveAt <= at) result[rec.fuelType] = rec.price;
  }
  return result;
}

/**
 * 油价变化后重算：只动“未复核”的交接单，已复核的锁定不动。
 * 返回被重算的交接单（调用方负责落库与入待传队列）。
 */
export function recalcUnreviewed(
  handovers: Handover[],
  prices: Record<FuelType, number>,
  now: number
): Handover[] {
  const changed: Handover[] = [];
  for (const h of handovers) {
    if (h.deleted || h.status === "已复核") continue;
    const salesAmount = computeSales(h, prices);
    if (salesAmount === h.salesAmount) continue;
    changed.push({
      ...h,
      salesAmount,
      priceSnapshot: { ...prices },
      rev: h.rev + 1,
      updatedAt: now
    });
  }
  return changed;
}
