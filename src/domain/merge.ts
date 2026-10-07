import type { ConflictPair, Handover, Payment, PriceRecord } from "./types";

export interface MergeResult {
  handovers: Handover[];
  conflicts: ConflictPair[];
  newConflicts: ConflictPair[];
  pulledFromRemote: number;
}

function upsertConflict(
  conflicts: ConflictPair[],
  newConflicts: ConflictPair[],
  station: Handover,
  incoming: Handover,
  now: number
): void {
  const existing = conflicts.find((c) => c.handoverId === station.id);
  if (existing) {
    existing.stationVersion = station;
    existing.incomingVersion = incoming;
    existing.detectedAt = now;
    return;
  }
  const pair: ConflictPair = {
    handoverId: station.id,
    stationVersion: station,
    incomingVersion: incoming,
    detectedAt: now
  };
  conflicts.push(pair);
  newConflicts.push(pair);
}

/**
 * 网络恢复后合并两端交接单：
 * - 仅远端有改动 → 采用远端；
 * - 仅本地有改动 → 保留本地（等上传）；
 * - 两端各有改动 → 站内已复核值绝不被迟到副本覆盖；无论是否复核，
 *   都保留两版进冲突区，等站长核对，当前展示值仍用站内版。
 */
export function mergeHandovers(
  local: Handover[],
  remote: Handover[],
  existingConflicts: ConflictPair[],
  now: number
): MergeResult {
  const byId = new Map(local.map((h) => [h.id, h]));
  const conflicts = existingConflicts.map((c) => ({ ...c }));
  const newConflicts: ConflictPair[] = [];
  let pulledFromRemote = 0;

  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l) {
      byId.set(r.id, { ...r, syncedRev: r.rev });
      pulledFromRemote++;
      continue;
    }
    if (r.rev <= l.syncedRev) continue; // 这版远端数据本地已见过
    const localChanged = l.rev !== l.syncedRev;
    if (!localChanged) {
      byId.set(r.id, { ...r, syncedRev: r.rev });
      pulledFromRemote++;
      continue;
    }
    // 两端各有改动：本地保持为当前值，远端作为迟到副本留档待核对
    upsertConflict(conflicts, newConflicts, l, r, now);
    byId.set(r.id, { ...l, syncedRev: Math.max(l.syncedRev, r.rev) });
  }

  return { handovers: [...byId.values()], conflicts, newConflicts, pulledFromRemote };
}

/** 收款流水按幂等键并集合并：重放/重复推送都不会多出流水 */
export function mergePayments(local: Payment[], remote: Payment[]): { payments: Payment[]; added: number } {
  const known = new Set(local.map((p) => p.id));
  const added = remote.filter((p) => !known.has(p.id));
  return { payments: [...local, ...added], added: added.length };
}

/** 油价记录按（油品 + 生效时间）并集合并 */
export function mergePrices(local: PriceRecord[], remote: PriceRecord[]): PriceRecord[] {
  const key = (p: PriceRecord) => `${p.fuelType}@${p.effectiveAt}`;
  const known = new Set(local.map(key));
  const added = remote.filter((p) => !known.has(key(p)));
  return [...local, ...added];
}
