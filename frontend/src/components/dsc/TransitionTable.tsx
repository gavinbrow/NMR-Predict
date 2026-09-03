// The detected/placed transitions on every visible run's ACTIVE segment: one
// row per feature — Run, Segment, Kind, Label, window, onset, midpoint/peak,
// endset, ΔH (J/g), Δcp, FWHM. Purely a readout of `run.analysis.results`;
// editing lives in `FeaturePanel` (left rail). Follows the plot rather than
// the left rail's selection, mirroring `components/tga/StepTable.tsx` — the
// selected run is highlighted rather than being the only one shown.

import type { DscFeatureResult } from "@/lib/dsc/compute";
import type { DscRunAnalyzed } from "@/lib/dsc/store";
import type { DscFeature, DscFeatureKind } from "@/lib/dsc/types";

const KIND_LABEL: Record<DscFeatureKind, string> = {
  glass: "Glass",
  melt: "Melt",
  crystallization: "Crystallization",
  coldCrystallization: "Cold cryst.",
  cure: "Cure",
  oit: "OIT",
  custom: "Custom",
};

function fmt(v: number | null | undefined, decimals = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(decimals);
}

interface Row {
  onset: number | null;
  mid: number | null;
  endset: number | null;
  dH: number | null;
  dCp: number | null;
  fwhm: number | null;
}

function rowFor(result: DscFeatureResult | undefined): Row {
  if (!result) return { onset: null, mid: null, endset: null, dH: null, dCp: null, fwhm: null };
  if (result.kind === "glass") {
    const g = result.glass;
    return { onset: g.onsetC, mid: g.midpointC, endset: g.endsetC, dH: null, dCp: g.deltaCp, fwhm: null };
  }
  if (result.kind === "oit") {
    return { onset: result.oit.onsetMin, mid: null, endset: null, dH: null, dCp: null, fwhm: null };
  }
  const p = result.peak;
  return { onset: p.onsetC, mid: p.peakC, endset: p.endsetC, dH: p.enthalpyJPerG, dCp: null, fwhm: p.fwhmC };
}

export function TransitionTable({ runs }: { runs: DscRunAnalyzed[] }) {
  const visible = runs.filter((r) => r.visible);
  if (visible.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No visible runs — enable one in Files / Runs to see its transitions.
      </p>
    );
  }

  type Entry = { run: DscRunAnalyzed; feature: DscFeature; row: Row; unit: string };
  const entries: Entry[] = [];
  for (const run of visible) {
    const segment = run.segments.find((s) => s.id === run.analysis.segmentId);
    const isIso = segment?.kind === "isothermal";
    const features = run.features.filter((f) => f.segmentId === run.analysis.segmentId);
    for (const feature of features) {
      entries.push({
        run,
        feature,
        row: rowFor(run.analysis.results[feature.id]),
        unit: feature.kind === "oit" || isIso ? "min" : "°C",
      });
    }
  }

  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No transitions on the {visible.length === 1 ? "visible run's" : "visible runs'"} active
        segment.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border/60 text-muted-foreground">
            <th className="py-1.5 pr-3 text-left font-medium">Run</th>
            <th className="py-1.5 px-2 text-left font-medium">Segment</th>
            <th className="py-1.5 px-2 text-left font-medium">Kind</th>
            <th className="py-1.5 px-2 text-left font-medium">Label</th>
            <th className="py-1.5 px-2 text-right font-medium">Window</th>
            <th className="py-1.5 px-2 text-right font-medium">Onset</th>
            <th className="py-1.5 px-2 text-right font-medium">Mid/Peak</th>
            <th className="py-1.5 px-2 text-right font-medium">Endset</th>
            <th className="py-1.5 px-2 text-right font-medium">ΔH (J/g)</th>
            <th className="py-1.5 px-2 text-right font-medium">Δcp</th>
            <th className="py-1.5 pl-2 text-right font-medium">FWHM</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(({ run, feature, row, unit }, i) => {
            const prevRun = i > 0 ? entries[i - 1].run.id : null;
            const segment = run.segments.find((s) => s.id === run.analysis.segmentId);
            return (
              // Feature ids are derived from the segment id, which is built
              // from the run's sample name (not a globally-unique run id) —
              // two runs sharing a sample name (e.g. a .tri and .xls export
              // of the same run, or replicate samples) can legitimately
              // produce the same feature id. Qualify the key with run.id so
              // React never conflates rows across different runs.
              <tr key={`${run.id}:${feature.id}`} className="border-b border-border/30">
                <td className="py-1.5 pr-3">
                  {run.id !== prevRun && (
                    <span className="flex items-center gap-1.5">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: run.color }}
                      />
                      <span className="truncate">{run.label}</span>
                    </span>
                  )}
                </td>
                <td className="py-1.5 px-2 text-muted-foreground">
                  {run.id !== prevRun ? (segment?.label ?? "—") : ""}
                </td>
                <td className="py-1.5 px-2">{KIND_LABEL[feature.kind]}</td>
                <td className="py-1.5 px-2 truncate" title={feature.label}>
                  {feature.label}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">
                  {fmt(feature.window[0], 0)}–{fmt(feature.window[1], 0)} {unit}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(row.onset)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(row.mid)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(row.endset)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(row.dH)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(row.dCp, 3)}</td>
                <td className="py-1.5 pl-2 text-right tabular-nums">{fmt(row.fwhm)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
