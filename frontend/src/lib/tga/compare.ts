// Cross-run comparison for the TGA workspace (WP7).
//
// Two shapes come out of here: one summary row per run (what the summary table
// and the CSV/Excel exports print), and per-material mean ± SD for a chosen
// metric (what the bar chart draws). Both are pure functions over the store's
// analyzed runs, so the same numbers reach the table, the chart, and every
// export without a second derivation.
//
// The metric list is built from the analysis params rather than hardcoded,
// because the Td thresholds are user-editable: adding T2% in the parameters
// must add a T2% column and a T2% bar, not silently do nothing.

import type { TgaMaterial } from "./types";
import type { TgaRunAnalyzed } from "./store";

/** A comparable scalar. `td:<threshold>` keys are generated from the params. */
export type TgaMetricKey = string;

export interface TgaMetric {
  key: TgaMetricKey;
  /** Column header / axis label. */
  label: string;
  /** Unit shown on the chart's y-axis and after the mean in the table. */
  unit: string;
  decimals: number;
}

/** The metric list for a given set of Td thresholds, in display order. */
export function tgaMetrics(tdThresholds: number[]): TgaMetric[] {
  const td = [...tdThresholds]
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)
    .map<TgaMetric>((t) => ({ key: `td:${t}`, label: `T${t}%`, unit: "°C", decimals: 1 }));
  return [
    ...td,
    { key: "onset", label: "Onset", unit: "°C", decimals: 1 },
    { key: "tmax", label: "Tmax", unit: "°C", decimals: 1 },
    { key: "residuePct", label: "Residue", unit: "%", decimals: 2 },
    { key: "residueMg", label: "Residue", unit: "mg", decimals: 4 },
    { key: "massMg", label: "Sample mass", unit: "mg", decimals: 4 },
  ];
}

/**
 * One run's value for a metric, or NaN when it has none.
 *
 * `onset` and `tmax` report the FIRST step's values: a multi-step run has one
 * of each per step, and the per-step numbers live in the steps table. Comparing
 * materials on "the first thing that happens" is the question this chart
 * answers; per-step comparison would need a step-alignment story that TGA data
 * doesn't reliably support across different formulations.
 */
export function metricValue(run: TgaRunAnalyzed, key: TgaMetricKey): number {
  const a = run.analysis;
  if (key.startsWith("td:")) {
    const threshold = Number(key.slice(3));
    const v = a.td[threshold];
    return v == null ? NaN : v;
  }
  switch (key) {
    case "onset": {
      const s = a.steps.find((st) => st.tOnset != null);
      return s?.tOnset ?? NaN;
    }
    case "tmax":
      return a.steps[0]?.tMax ?? NaN;
    case "residuePct":
      return a.residue.pct;
    case "residueMg":
      return a.residue.mg;
    case "massMg":
      return run.meta.sampleSizeMg ?? (run.weightMg.length > 0 ? run.weightMg[0] : NaN);
    default:
      return NaN;
  }
}

/** One row of the cross-run summary table. `values` is keyed by metric key. */
export interface TgaSummaryRow {
  runId: string;
  label: string;
  color: string;
  fileName: string;
  materialName: string;
  values: Record<TgaMetricKey, number>;
  stepCount: number;
}

/** Build one summary row per run, in store order. */
export function buildSummaryRows(
  runs: TgaRunAnalyzed[],
  materials: TgaMaterial[],
  metrics: TgaMetric[],
): TgaSummaryRow[] {
  const materialName = new Map<string, string>();
  for (const m of materials) for (const id of m.runIds) materialName.set(id, m.name);
  return runs.map((run) => {
    const values: Record<TgaMetricKey, number> = {};
    for (const m of metrics) values[m.key] = metricValue(run, m.key);
    return {
      runId: run.id,
      label: run.label,
      color: run.color,
      fileName: run.fileName,
      materialName: materialName.get(run.id) ?? "—",
      values,
      stepCount: run.analysis.steps.length,
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
export interface TgaBarDatum {
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
  runs: TgaRunAnalyzed[],
  materials: TgaMaterial[],
  key: TgaMetricKey,
): TgaBarDatum[] {
  const byId = new Map(runs.map((r) => [r.id, r] as const));
  const out: TgaBarDatum[] = [];
  for (const m of materials) {
    const members = m.runIds.map((id) => byId.get(id)).filter((r): r is TgaRunAnalyzed => !!r);
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
export function buildRunBars(runs: TgaRunAnalyzed[], key: TgaMetricKey): TgaBarDatum[] {
  return runs
    .map<TgaBarDatum>((r) => {
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
