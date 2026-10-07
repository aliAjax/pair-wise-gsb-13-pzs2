import { mergeHandovers, mergePayments, mergePrices } from "../domain/merge";
import type { OutboxOp, StationDb } from "../domain/types";
import { loadCloud } from "./persistence";
import { pushOpToCloud } from "./cloud";

export function describeOp(op: OutboxOp): string {
  const p = op.payload;
  if (p.kind === "upsert-handover") {
    const h = p.handover;
    return `交接单 ${h.shiftDate} ${h.shift}（rev ${h.rev}）`;
  }
  if (p.kind === "add-payment") {
    return `收款 ${p.payment.method} ¥${p.payment.amount.toFixed(2)}`;
  }
  return `油价 ${p.record.fuelType} → ¥${p.record.price.toFixed(2)}`;
}

export function addLog(db: StationDb, message: string): void {
  db.log.unshift({ at: Date.now(), message });
  if (db.log.length > 100) db.log.length = 100;
}

export interface PushResult {
  pushed: number;
  failed: boolean;
}

/**
 * 推送待传队列：逐条上传，失败即停并保留剩余队列，等待下次重试。
 * onApplied 用于把已上传的交接单标记为“已与云端对齐”。
 */
export function pushOutbox(
  db: StationDb,
  opts: { flaky: boolean },
  onApplied: (op: OutboxOp) => void
): PushResult {
  let pushed = 0;
  while (db.outbox.length > 0) {
    const op = db.outbox[0];
    try {
      const result = pushOpToCloud(op, opts);
      db.outbox.shift();
      pushed++;
      onApplied(op);
      addLog(
        db,
        result === "replayed"
          ? `重放去重：${describeOp(op)} 云端已入账，未重复写入`
          : `已上传：${describeOp(op)}`
      );
    } catch (err) {
      op.attempts++;
      op.lastError = err instanceof Error ? err.message : String(err);
      addLog(db, `上传失败（已保留待传，可重试）：${describeOp(op)} — ${op.lastError}`);
      return { pushed, failed: true };
    }
  }
  return { pushed, failed: false };
}

export interface PullResult {
  pulled: number;
  paymentsAdded: number;
  conflictsFound: number;
}

/** 拉取云端账本并合并进站内账本 */
export function pullAndMerge(db: StationDb): PullResult {
  const cloud = loadCloud();
  const now = Date.now();
  const merged = mergeHandovers(db.handovers, cloud.handovers, db.conflicts, now);
  db.handovers = merged.handovers;
  db.conflicts = merged.conflicts;
  for (const c of merged.newConflicts) {
    const h = c.stationVersion;
    addLog(
      db,
      `冲突待核对：${h.shiftDate} ${h.shift} 两端各有改动，已保留两版；站内${h.status === "已复核" ? "已复核值保持权威，未被覆盖" : "版暂为当前值"}`
    );
  }
  const pm = mergePayments(db.payments, cloud.payments);
  db.payments = pm.payments;
  if (pm.added > 0) addLog(db, `合并收款流水：新增 ${pm.added} 笔（按幂等键去重）`);
  db.prices = mergePrices(db.prices, cloud.prices);
  return { pulled: merged.pulledFromRemote, paymentsAdded: pm.added, conflictsFound: merged.newConflicts.length };
}
