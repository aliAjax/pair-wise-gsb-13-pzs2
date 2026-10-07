import type { CloudDb, Handover, OutboxOp, Payment } from "../domain/types";
import { loadCloud, saveCloud } from "./persistence";

/** 模拟“云端已应用但确认丢失”的网络故障，客户端稍后会重放同一操作 */
export class AckLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AckLostError";
  }
}

function applyPayload(cloud: CloudDb, op: OutboxOp): void {
  const p = op.payload;
  if (p.kind === "upsert-handover") {
    const idx = cloud.handovers.findIndex((h) => h.id === p.handover.id);
    if (idx >= 0) cloud.handovers[idx] = p.handover;
    else cloud.handovers.push(p.handover);
  } else if (p.kind === "add-payment") {
    // 双保险：除操作幂等键外，流水本身也按 id 去重
    if (!cloud.payments.some((x) => x.id === p.payment.id)) cloud.payments.push(p.payment);
  } else if (p.kind === "price-change") {
    const dup = cloud.prices.some(
      (x) => x.fuelType === p.record.fuelType && x.effectiveAt === p.record.effectiveAt
    );
    if (!dup) cloud.prices.push(p.record);
  }
}

/**
 * 云端应用一个待传操作。
 * 幂等：opId 已应用过则直接返回 replayed，不再入账 —— 重放不会多出收款流水。
 * flaky 模式下先落库再抛 AckLostError，模拟“应用成功但确认丢失”。
 */
export function pushOpToCloud(op: OutboxOp, opts: { flaky: boolean }): "applied" | "replayed" {
  const cloud = loadCloud();
  if (cloud.appliedOpIds.includes(op.opId)) return "replayed";
  applyPayload(cloud, op);
  cloud.appliedOpIds.push(op.opId);
  saveCloud(cloud);
  if (opts.flaky) throw new AckLostError("网络抖动：云端已应用但确认丢失，待重试");
  return "applied";
}

/** 模拟中心端/另一终端直接改云端交接单（用于演示两端各有改动时的合并） */
export function cloudEditHandover(id: string, patch: Partial<Pick<Handover, "salesAmount" | "notes" | "status">>): Handover | null {
  const cloud = loadCloud();
  const h = cloud.handovers.find((x) => x.id === id);
  if (!h) return null;
  const next: Handover = {
    ...h,
    ...patch,
    rev: h.rev + 1,
    updatedAt: Date.now(),
    origin: "cloud"
  };
  cloud.handovers[cloud.handovers.indexOf(h)] = next;
  saveCloud(cloud);
  return next;
}

/** 模拟中心端补登一笔收款 */
export function cloudAddPayment(payment: Payment): void {
  const cloud = loadCloud();
  if (!cloud.payments.some((p) => p.id === payment.id)) {
    cloud.payments.push(payment);
    saveCloud(cloud);
  }
}
