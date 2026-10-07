import type { ReconRow } from "./reconcile";
import { round2 } from "./reconcile";

const HEADER = ["日期", "班次", "交班人", "销量(L)", "销售额(元)", "收款合计(元)", "差额(元)", "对账状态"];

function cell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 导出与列表/汇总使用同一批 ReconRow，状态与收入口径一致 */
export function toCsv(rows: ReconRow[]): string {
  const lines = [HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.handover.shiftDate,
        r.handover.shift,
        r.handover.operator,
        r.volume,
        r.salesAmount.toFixed(2),
        r.received.toFixed(2),
        r.diff.toFixed(2),
        r.status
      ]
        .map(cell)
        .join(",")
    );
  }
  const sum = (f: (r: ReconRow) => number) => round2(rows.reduce((a, r) => a + f(r), 0)).toFixed(2);
  lines.push(["合计", "", "", sum((r) => r.volume), sum((r) => r.salesAmount), sum((r) => r.received), sum((r) => r.diff), ""].map(cell).join(","));
  return "\uFEFF" + lines.join("\n");
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
