// Per-run summary strip: one row per visible run, one column per metric.
//
// The columns come from `tgaMetrics(params.tdThresholds)` rather than a fixed
// T5/T10/T50 list, so editing the Td thresholds in Analysis parameters actually
// changes the table — and the table, the compare chart and every export all
// read the same metric definitions.

import { useMemo } from "react";
import { metricValue, tgaMetrics } from "@/lib/tga/compare";
import type { TgaRunAnalyzed } from "@/lib/tga/store";
import type { AnalysisParams } from "@/lib/tga/types";

/** Metrics the strip shows. `residueMg` and `massMg` are available in the
 *  compare chart and the exports but would make this table too wide. */
const OMITTED: ReadonlySet<string> = new Set(["residueMg", "massMg"]);

function fmt(v: number, decimals: number): string {
  return Number.isFinite(v) ? v.toFixed(decimals) : "—";
}

export function SummaryTable({
  runs,
  params,
}: {
  runs: TgaRunAnalyzed[];
  params: AnalysisParams;
}) {
  const metrics = useMemo(
    () => tgaMetrics(params.tdThresholds).filter((m) => !OMITTED.has(m.key)),
    [params.tdThresholds],
  );
  const visible = runs.filter((r) => r.visible);
  if (visible.length === 0) {
    return <p className="text-xs text-muted-foreground">No visible runs.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border/60 text-muted-foreground">
            <th className="py-1.5 pr-3 text-left font-medium">Run</th>
            {metrics.map((m) => (
              <th key={m.key} className="py-1.5 px-2 text-right font-medium">
                {m.label}
                <span className="ml-1 font-normal opacity-60">{m.unit}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.id} className="border-b border-border/30">
              <td className="py-1.5 pr-3">
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: r.color }}
                  />
                  <span className="truncate">{r.label}</span>
                </span>
              </td>
              {metrics.map((m) => (
                <td key={m.key} className="py-1.5 px-2 text-right tabular-nums">
                  {fmt(metricValue(r, m.key), m.decimals)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
