// The detected degradation steps for every run currently on the plot: onset,
// Tmax, endset, the window they were fitted over, and the mass lost across
// each. Purely a readout of what `stepDetection` found — the parameters that
// drive it (the DTG window and the step threshold) live in ParamControls.
//
// It follows the PLOT, not the left rail's selection: the point of the table is
// to read the numbers off the curves you are looking at, and having to click
// each run in turn to compare four samples defeats that. The selected run is
// highlighted rather than being the only one shown.

import type { TgaRunAnalyzed } from "@/lib/tga/store";

function fmt(v: number | null | undefined, decimals = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(decimals);
}

export function StepTable({
  runs,
  selectedRunId,
}: {
  runs: TgaRunAnalyzed[];
  selectedRunId?: string | null;
}) {
  const visible = runs.filter((r) => r.visible);
  if (visible.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No visible runs — enable one in Files / Runs to see its degradation steps.
      </p>
    );
  }
  const total = visible.reduce((n, r) => n + r.analysis.steps.length, 0);
  if (total === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No steps detected in the {visible.length} visible run{visible.length === 1 ? "" : "s"} —
        lower “Min step loss” in Analysis parameters to pick up smaller events.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="pb-2 text-left text-[11px] text-muted-foreground">
          {total} step{total === 1 ? "" : "s"} across {visible.length} visible run
          {visible.length === 1 ? "" : "s"}
        </caption>
        <thead>
          <tr className="border-b border-border/60 text-muted-foreground">
            <th className="py-1.5 pr-3 text-left font-medium">Run</th>
            <th className="py-1.5 px-2 text-right font-medium">#</th>
            <th className="py-1.5 px-2 text-right font-medium">Onset (°C)</th>
            <th className="py-1.5 px-2 text-right font-medium">Tmax (°C)</th>
            <th className="py-1.5 px-2 text-right font-medium">Endset (°C)</th>
            <th className="py-1.5 px-2 text-right font-medium">Window (°C)</th>
            <th className="py-1.5 px-2 text-right font-medium">Loss (%)</th>
            <th className="py-1.5 pl-2 text-right font-medium">Loss (mg)</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((run) =>
            run.analysis.steps.length === 0 ? (
              <tr key={run.id} className="border-b border-border/30">
                <td className="py-1.5 pr-3">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: run.color }}
                    />
                    <span className="truncate">{run.label}</span>
                  </span>
                </td>
                <td className="py-1.5 px-2 text-right text-muted-foreground" colSpan={7}>
                  no steps detected
                </td>
              </tr>
            ) : (
              run.analysis.steps.map((s, i) => (
                <tr
                  key={`${run.id}:${s.index}`}
                  className={`border-b border-border/30 ${
                    run.id === selectedRunId ? "bg-primary/5" : ""
                  }`}
                >
                  {/* The run is named once per group; the rows under it are
                      indented by the blank cell so the grouping reads at a
                      glance without a nested table. */}
                  <td className="py-1.5 pr-3">
                    {i === 0 && (
                      <span className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                          style={{ backgroundColor: run.color }}
                        />
                        <span className="truncate">{run.label}</span>
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{s.index + 1}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{fmt(s.tOnset)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{fmt(s.tMax)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{fmt(s.tEndset)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">
                    {fmt(s.tRange[0], 0)}–{fmt(s.tRange[1], 0)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{fmt(s.lossPct, 2)}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums">{fmt(s.lossMg, 4)}</td>
                </tr>
              ))
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
