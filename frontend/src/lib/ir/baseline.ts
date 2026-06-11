// Full-spectrum baseline correction (§6). Every method operates in absorbance
// space and returns the *baseline* array; the correction is `absorbance −
// baseline` (done by the caller, e.g. shared.ts `displayY`). The methods are,
// in order: None, Offset, Linear (2-point), Rubberband.

import { convexHull, interp } from "./numerics";
import type { BaselineMethod, BaselinePoint } from "./types";

export { BASELINE_METHODS as METHODS } from "./types";

/** NaN-ignoring minimum; 0 if no finite value exists. */
function nanMin(values: number[]): number {
  let m = Infinity;
  for (const v of values) if (Number.isFinite(v) && v < m) m = v;
  return m === Infinity ? 0 : m;
}

/** NaN-ignoring maximum; 0 if no finite value exists. */
function nanMax(values: number[]): number {
  let m = -Infinity;
  for (const v of values) if (Number.isFinite(v) && v > m) m = v;
  return m === -Infinity ? 0 : m;
}

/** Index of the wavenumber nearest to `x`. */
function nearestIndex(wavenumber: number[], x: number): number {
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < wavenumber.length; i += 1) {
    const d = Math.abs(wavenumber[i] - x);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  return idx;
}

/** Mean of `absorbance[idx-3 .. idx+3]` (clamped to bounds), NaN-ignoring. */
function anchorValue(absorbance: number[], idx: number): number {
  const lo = Math.max(0, idx - 3);
  const hi = Math.min(absorbance.length - 1, idx + 3);
  let sum = 0;
  let count = 0;
  for (let i = lo; i <= hi; i += 1) {
    if (Number.isFinite(absorbance[i])) {
      sum += absorbance[i];
      count += 1;
    }
  }
  return count > 0 ? sum / count : absorbance[idx];
}

/** Linear (2-point): straight line between two anchor means. */
function linearBaseline(
  wavenumber: number[],
  absorbance: number[],
  p1?: number,
  p2?: number,
): number[] {
  const x1 = p1 ?? nanMax(wavenumber);
  const x2 = p2 ?? nanMin(wavenumber);
  const y1 = anchorValue(absorbance, nearestIndex(wavenumber, x1));
  const y2 = anchorValue(absorbance, nearestIndex(wavenumber, x2));
  if (x1 === x2) return new Array<number>(wavenumber.length).fill(y1);
  const slope = (y2 - y1) / (x2 - x1);
  return wavenumber.map((w) => y1 + slope * (w - x1));
}

/** Rubberband: lower convex-hull envelope, interpolated across all wavenumbers. */
function rubberbandBaseline(wavenumber: number[], absorbance: number[]): number[] {
  const n = wavenumber.length;
  const flat = () => new Array<number>(n).fill(nanMin(absorbance));
  if (n < 3) return flat();
  try {
    const points: [number, number][] = wavenumber.map((w, i) => [w, absorbance[i]]);
    const hull = convexHull(points);
    if (hull.length < 2) return flat();

    // Roll the hull so it starts at the lowest-x vertex, then keep the forward
    // run up to the highest-x vertex — that arc is the lower envelope.
    let iMin = 0;
    for (let i = 1; i < hull.length; i += 1) if (hull[i][0] < hull[iMin][0]) iMin = i;
    const rolled = hull.slice(iMin).concat(hull.slice(0, iMin));
    let iMax = 0;
    let maxX = -Infinity;
    for (let i = 0; i < rolled.length; i += 1) {
      if (rolled[i][0] > maxX) {
        maxX = rolled[i][0];
        iMax = i;
      }
    }
    const envelope = rolled.slice(0, iMax + 1);
    if (envelope.length < 2) return flat();
    const ex = envelope.map((p) => p[0]);
    const ey = envelope.map((p) => p[1]);
    return interp(wavenumber, ex, ey);
  } catch {
    return flat();
  }
}

/**
 * Manual (draw): a single user-drawn polyline, the same baseline for every
 * spectrum. The anchors (x = cm⁻¹, y = absorbance) are sorted by wavenumber and
 * linearly interpolated across the grid; `interp` clamps the ends flat. Fewer
 * than two anchors means "no baseline" (a flat zero), so an empty draw is a
 * no-op rather than a surprise.
 */
function manualBaseline(wavenumber: number[], anchors?: BaselinePoint[]): number[] {
  const pts = (anchors ?? [])
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
  if (pts.length < 2) return new Array<number>(wavenumber.length).fill(0);
  return interp(
    wavenumber,
    pts.map((p) => p.x),
    pts.map((p) => p.y),
  );
}

/**
 * Compute the baseline array for `method` over an absorbance spectrum. `p1`/`p2`
 * are the optional Linear (2-point) anchor wavenumbers (defaults: max / min wn);
 * `anchors` is the hand-drawn polyline used by "Manual (draw)".
 */
export function computeBaseline(
  method: BaselineMethod,
  wavenumber: number[],
  absorbance: number[],
  p1?: number,
  p2?: number,
  anchors?: BaselinePoint[],
): number[] {
  switch (method) {
    case "Offset":
      return new Array<number>(absorbance.length).fill(nanMin(absorbance));
    case "Linear (2-point)":
      return linearBaseline(wavenumber, absorbance, p1, p2);
    case "Rubberband":
      return rubberbandBaseline(wavenumber, absorbance);
    case "Manual (draw)":
      return manualBaseline(wavenumber, anchors);
    case "None":
    default:
      return new Array<number>(absorbance.length).fill(0);
  }
}

/** Convenience: baseline-corrected absorbance (`absorbance − baseline`). */
export function correctBaseline(
  method: BaselineMethod,
  wavenumber: number[],
  absorbance: number[],
  p1?: number,
  p2?: number,
  anchors?: BaselinePoint[],
): number[] {
  const baseline = computeBaseline(method, wavenumber, absorbance, p1, p2, anchors);
  return absorbance.map((a, i) => a - baseline[i]);
}
