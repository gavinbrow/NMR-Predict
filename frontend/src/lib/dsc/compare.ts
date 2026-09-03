// Cross-run comparison for the DSC workspace (§WP7).
//
// Two shapes come out of here: one summary row per run (what the summary
// table and the CSV/Excel exports print), and per-material mean ± SD for a
// chosen metric (what the bar chart draws). Both are pure functions over the
// store's analyzed runs, so the same numbers reach the table, the chart, and
// every export without a second derivation. Mirrors `lib/tga/compare.ts`
// structure exactly — see that file for the pattern this was cloned from.
//
// Unlike TGA's `tgaMetrics(tdThresholds)`, the DSC metric list is fixed (it
// doesn't depend on any user-editable threshold list), so `dscMetrics()`
// takes no arguments.

import type { DscMaterial } from "./types";
import type { DscRunAnalyzed } from "./store";

/** A comparable scalar, keyed by one of `dscMetrics()`'s fixed keys. */
export type DscMetricKey = string;

export interface DscMetric {
  key: DscMetricKey;
  /** Column header / axis label. */
  label: string;
  /** Unit shown on the chart's y-axis and after the mean in the table. */
  unit: string;
  decimals: number;
}

/** The fixed metric list, in display order — every column the summary table,
 *  the compare chart, and the CSV/Excel exports show. */
export function dscMetrics(): DscMetric[] {
  return [
    { key: "tgOnset", label: "Tg onset", unit: "°C", decimals: 1 },
    { key: "tgMid", label: "Tg midpoint", unit: "°C", decimals: 1 },
    { key: "tgEndset", label: "Tg endset", unit: "°C", decimals: 1 },
    { key: "deltaCp", label: "Δcp", unit: "J/(g·°C)", decimals: 3 },
    { key: "tm", label: "Tm", unit: "°C", decimals: 1 },
    { key: "dHm", label: "ΔHm", unit: "J/g", decimals: 1 },
    { key: "tmOnset", label: "Tm onset", unit: "°C", decimals: 1 },
    { key: "tc", label: "Tc", unit: "°C", decimals: 1 },
    { key: "dHc", label: "ΔHc", unit: "J/g", decimals: 1 },
    { key: "tcc", label: "Tcc", unit: "°C", decimals: 1 },
    { key: "dHcc", label: "ΔHcc", unit: "J/g", decimals: 1 },
    { key: "crystallinity", label: "Xc", unit: "%", decimals: 1 },
    { key: "dHcure", label: "ΔHcure", unit: "J/g", decimals: 1 },
    { key: "massMg", label: "Sample mass", unit: "mg", decimals: 2 },
  ];
}

/**
 * One run's value for a metric, or NaN when it has none (the feature was
 * never detected on the active segment, or the key is unrecognized).
 *
 * `massMg` mirrors `RunCard`'s own `effectiveMass` resolution
 * (`massOverrideMg ?? meta.sampleMassMg`) — deliberately `??`, not `||`, so a
 * genuine (if unusual) zero-mg override is not silently discarded in favour
 * of the parsed metadata.
 */
export function metricValue(run: DscRunAnalyzed, key: DscMetricKey): number {
  const a = run.analysis;
  switch (key) {
    case "tgOnset":
      return a.glass?.onsetC ?? NaN;
    case "tgMid":
      return a.glass?.midpointC ?? NaN;
    case "tgEndset":
      return a.glass?.endsetC ?? NaN;
    case "deltaCp":
      return a.glass?.deltaCp ?? NaN;
    case "tm":
      return a.melt?.peakC ?? NaN;
    case "dHm":
      return a.melt?.enthalpyJPerG ?? NaN;
    case "tmOnset":
      return a.melt?.onsetC ?? NaN;
    case "tc":
      return a.crystallization?.peakC ?? NaN;
    case "dHc":
      return a.crystallization?.enthalpyJPerG ?? NaN;
    case "tcc":
      return a.coldCrystallization?.peakC ?? NaN;
    case "dHcc":
      return a.coldCrystallization?.enthalpyJPerG ?? NaN;
    case "crystallinity":
      return a.crystallinityPct ?? NaN;
    case "dHcure":
      return a.cure?.enthalpyJPerG ?? NaN;
    case "massMg":
      return run.massOverrideMg ?? run.meta.sampleMassMg ?? NaN;
    default:
      return NaN;
  }
}

/** One row of the cross-run summary table. `values` is keyed by metric key. */
export interface DscSummaryRow {
  runId: string;
  label: string;
  color: string;
  fileName: string;
  materialName: string;
  /** The active segment's own label (e.g. "Ramp 10.00 °C/min to 280.00 °C")
   *  — the WP8 Summary CSV/Excel sheet carries a `Segment` column alongside
   *  `Run`/`Material`/`File`, and the table benefits from the same context. */
  segmentLabel: string;
  values: Record<DscMetricKey, number>;
}

/** Build one summary row per run, in store order. */
export function buildSummaryRows(
  runs: DscRunAnalyzed[],
  materials: DscMaterial[],
  metrics: DscMetric[],
): DscSummaryRow[] {
  const materialName = new Map<string, string>();
  for (const m of materials) for (const id of m.runIds) materialName.set(id, m.name);
  return runs.map((run) => {
    const values: Record<DscMetricKey, number> = {};
    for (const m of metrics) values[m.key] = metricValue(run, m.key);
    const segment = run.segments.find((s) => s.id === run.analysis.segmentId);
    return {
      runId: run.id,
      label: run.label,
      color: run.color,
      fileName: run.fileName,
      materialName: materialName.get(run.id) ?? "—",
      segmentLabel: segment?.label ?? "—",
      values,
    };
  });
}

/** Mean and sample SD (ddof = 1) of the finite values. SD is NaN below two
 *  values — the chart renders that as a zero-length error bar. */
export function summarize(values: number[]): { mean: number; sd: number; n: number } {
  const finite = values.filter((v) => Number.isFinite(v));
  const n = finite.length;
  if (n === 0) return { mean: NaN, sd: NaN, n: 0 };
  const mean = finite.reduce((s, v) => s + v, 0) / n;
  if (n < 2) return { mean, sd: NaN, n };
  const ss = finite.reduce((s, v) => s + (v - mean) ** 2, 0);
  return { mean, sd: Math.sqrt(ss / (n - 1)), n };
}

/** One bar: a material's mean ± SD for the chosen metric, plus its runs' own
 *  values so the chart can overlay the individual points. */
export interface DscBarDatum {
  id: string;
  name: string;
  color: string;
  mean: number;
  sd: number;
  n: number;
  points: { label: string; value: number }[];
}

/**
 * Per-material mean ± SD for one metric. A material's colour is its first
 * member run's colour, so the bar matches the curve the user already knows.
 * Materials with no visible runs are dropped rather than drawn as a gap.
 */
export function buildMaterialBars(
  runs: DscRunAnalyzed[],
  materials: DscMaterial[],
  key: DscMetricKey,
): DscBarDatum[] {
  const byId = new Map(runs.map((r) => [r.id, r] as const));
  const out: DscBarDatum[] = [];
  for (const m of materials) {
    const members = m.runIds.map((id) => byId.get(id)).filter((r): r is DscRunAnalyzed => !!r);
    const points = members
      .map((r) => ({ label: r.label, value: metricValue(r, key) }))
      .filter((p) => Number.isFinite(p.value));
    if (points.length === 0) continue;
    const { mean, sd, n } = summarize(points.map((p) => p.value));
    out.push({
      id: m.id,
      name: m.name,
      color: members[0]?.color ?? "#64748b",
      mean,
      sd: Number.isFinite(sd) ? sd : 0,
      n,
      points,
    });
  }
  return out;
}

/** Per-run bars, for comparing individual runs rather than grouped materials.
 *  Each bar carries a zero SD — a single run has no spread to show. */
export function buildRunBars(runs: DscRunAnalyzed[], key: DscMetricKey): DscBarDatum[] {
  return runs
    .map<DscBarDatum>((r) => {
      const value = metricValue(r, key);
      return {
        id: r.id,
        name: r.label,
        color: r.color,
        mean: value,
        sd: 0,
        n: 1,
        points: [{ label: r.label, value }],
      };
    })
    .filter((b) => Number.isFinite(b.mean));
}
