// Adapter from the TGA store model to the on-screen plot's props (WP4).
//
// The sibling of `figure.ts`: where that one shapes the publication figure,
// this one shapes what `TgaPlot` draws. Keeping it out of the component means
// the x/y-mode switching, the gain/offset application, and the marker list are
// pure and unit-testable, and — more importantly — that the screen and the
// figure derive their numbers the same way, so the figure really is WYSIWYG.

import type { TgaPlotMarker, TgaPlotTrace } from "@/components/tga/TgaPlot";
import type { TgaXAxis, TgaYAxis, TgaMarkerToggles } from "./figure";
import type { TgaRunAnalyzed } from "./store";

export interface BuildTgaPlotArgs {
  runs: TgaRunAnalyzed[];
  xAxis: TgaXAxis;
  yAxis: TgaYAxis;
  markers: TgaMarkerToggles;
}

/** Apply a run's display gain exactly as `lib/tga/figure.ts` does. */
function applyGain(src: Float64Array, scale: number, offset: number): Float64Array {
  if (scale === 1 && offset === 0) return src;
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i += 1) out[i] = src[i] * scale + offset;
  return out;
}

/**
 * The curve's y at `xv`, linearly interpolated on a monotone x grid — what a
 * vertical marker's label is anchored to, so a callout visibly belongs to one
 * run rather than floating at the top of the plot.
 *
 * Outside the recorded range it clamps to the nearest end rather than giving
 * up: an extrapolated onset can legitimately land below the first recorded
 * temperature, and that is still a number worth reporting.
 */
function valueAt(x: Float64Array, y: Float64Array, xv: number, scale: number, offset: number): number | null {
  const n = x.length;
  if (n === 0 || !Number.isFinite(xv)) return null;
  const ascending = n < 2 || x[n - 1] >= x[0];
  const lo = ascending ? x[0] : x[n - 1];
  const hi = ascending ? x[n - 1] : x[0];
  if (xv <= lo || xv >= hi) {
    const end = xv <= lo ? (ascending ? y[0] : y[n - 1]) : ascending ? y[n - 1] : y[0];
    return Number.isFinite(end) ? end * scale + offset : null;
  }
  let a = 0;
  let b = n - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (ascending ? x[m] <= xv : x[m] >= xv) a = m;
    else b = m;
  }
  const raw =
    Number.isFinite(y[a]) && Number.isFinite(y[b]) && x[b] !== x[a]
      ? y[a] + ((y[b] - y[a]) * (xv - x[a])) / (x[b] - x[a])
      : Number.isFinite(y[a])
        ? y[a]
        : Number.isFinite(y[b])
          ? y[b]
          : null;
  return raw == null ? null : raw * scale + offset;
}

/** X-axis label for the current mode. */
export function plotXLabel(xAxis: TgaXAxis): string {
  return xAxis === "temperature" ? "Temperature (°C)" : "Time (min)";
}

/** Primary y-axis label for the current mode. */
export function plotYLabel(yAxis: TgaYAxis): string {
  return yAxis === "weightPct" ? "Weight (%)" : "Weight (mg)";
}

/** Secondary y-axis label — the DTG unit the params selected. */
export function plotY2Label(dtgUnit: string): string {
  return `Deriv. weight (${dtgUnit})`;
}

/** One plot trace per run, in store order. Hidden runs are included with
 *  `visible: false` so the plot's legend order stays stable as they toggle. */
export function buildTgaPlotTraces(args: Pick<BuildTgaPlotArgs, "runs" | "xAxis" | "yAxis">): TgaPlotTrace[] {
  const { runs, xAxis, yAxis } = args;
  return runs.map((run) => {
    const a = run.analysis;
    const x = xAxis === "temperature" ? run.tempC : run.timeMin;
    const rawY = yAxis === "weightPct" ? a.weightPct : run.weightMg;
    return {
      id: run.id,
      label: run.label,
      color: run.color,
      visible: run.visible,
      x,
      y: applyGain(rawY, run.scale, run.offset),
      // The run's gain carries into its derivative — d/dT of a scaled curve is
      // scaled by the same factor — but not its offset, whose derivative is
      // zero. Matches `lib/tga/figure.ts`, so the screen and the figure agree.
      dtg: a.dtg.length > 0 ? applyGain(a.dtg, run.scale, 0) : null,
    };
  });
}

/**
 * The analysis markers for the plot overlay. Only drawn on the temperature
 * x-axis: onset, endset, Tmax and Td are all *temperatures*, so plotting them
 * as verticals against time would put them at meaningless positions. The
 * residue level is horizontal and therefore valid in both modes.
 */
export function buildTgaPlotMarkers(args: BuildTgaPlotArgs): TgaPlotMarker[] {
  const { runs, xAxis, yAxis, markers } = args;
  const out: TgaPlotMarker[] = [];
  const onTemperature = xAxis === "temperature";
  for (const run of runs) {
    if (!run.visible) continue;
    const a = run.analysis;
    const curveY = yAxis === "weightPct" ? a.weightPct : run.weightMg;
    /** Anchor a vertical marker's label on this run's own curve. */
    const anchor = (t: number) => valueAt(run.tempC, curveY, t, run.scale, run.offset) ?? undefined;
    if (onTemperature) {
      for (const step of a.steps) {
        if (markers.onset && step.tOnset != null) {
          out.push({
            id: `onset:${run.id}:${step.index}`,
            kind: "onset",
            color: run.color,
            label: `onset ${step.tOnset.toFixed(1)}`,
            x: step.tOnset,
            y: anchor(step.tOnset),
          });
        }
        if (markers.endset && step.tEndset != null) {
          out.push({
            id: `endset:${run.id}:${step.index}`,
            kind: "endset",
            color: run.color,
            label: `endset ${step.tEndset.toFixed(1)}`,
            x: step.tEndset,
            y: anchor(step.tEndset),
          });
        }
        if (markers.tmax && Number.isFinite(step.tMax)) {
          out.push({
            id: `tmax:${run.id}:${step.index}`,
            kind: "tmax",
            color: run.color,
            label: `Tmax ${step.tMax.toFixed(1)}`,
            x: step.tMax,
            y: anchor(step.tMax),
          });
        }
      }
      if (markers.td) {
        for (const [thresholdStr, tVal] of Object.entries(a.td)) {
          if (tVal == null || !Number.isFinite(tVal)) continue;
          out.push({
            id: `td:${run.id}:${thresholdStr}`,
            kind: "td",
            color: run.color,
            label: `T${thresholdStr}% ${tVal.toFixed(1)}`,
            x: tVal,
            y: anchor(tVal),
          });
        }
      }
    }
    // The residue level is a weight, so it only lands on the primary axis when
    // that axis is showing weight %. In mg mode we draw the mg value instead.
    if (markers.residue) {
      const level = yAxis === "weightPct" ? a.residue.pct : a.residue.mg;
      if (Number.isFinite(level)) {
        out.push({
          id: `residue:${run.id}`,
          kind: "residue",
          color: run.color,
          label: `residue ${level.toFixed(1)}${yAxis === "weightPct" ? " %" : " mg"}`,
          y: level * run.scale + run.offset,
        });
      }
    }
  }
  return out;
}
