// Small pure numeric helpers for the DSC compute engine. Re-exports the
// generic Float64Array helpers TGA already built (index/extremum/statistics —
// they are unit-agnostic, so DSC reuses them rather than duplicating), plus
// two DSC-only helpers: `ascendingView` (a cooling segment's arrays need
// reversing so one code path serves heating and cooling, §3.1) and `fwhm`
// (full width at half max, used by the peak integrator, §3.5.6).

export {
  monotoneDedupeIndices,
  interp1d,
  lowerBound,
  upperBound,
  clampWindow,
  argmax,
  argmin,
  localMinimumIndex,
  localMaximumIndex,
  lineIntersectionX,
  mean,
  sd,
} from "@/lib/tga/numerics";

/**
 * Slice `arr[start, end)`, reversed when `reverse` is true. Used to give a
 * cooling segment's temperature/time/heat-flow arrays the same
 * ascending-temperature shape as a heating segment's (`SegmentView.reversed`,
 * §3.1) — `reverse` is decided once (by comparing `tempC[start]` to
 * `tempC[end-1]`) and applied in lockstep to every parallel array, so the
 * caller must pass the SAME `reverse` flag to each call for one segment.
 * Returns a subarray VIEW (no copy) when `reverse` is false.
 */
export function ascendingView(
  arr: Float64Array,
  start: number,
  end: number,
  reverse: boolean,
): Float64Array {
  if (!reverse) return arr.subarray(start, end);
  const n = end - start;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = arr[end - 1 - i];
  return out;
}

/**
 * Full width at half max: walk outward from `peakIdx` in both directions
 * within `[lo, hi)` and linearly interpolate the first point where `y`
 * crosses `halfHeight`. Works for a peak of either sign — a crossing is
 * detected as a sign change of `(y - halfHeight)` between consecutive
 * samples, which is symmetric whether the peak (and so `halfHeight`) is
 * positive (exothermic) or negative (endothermic). Returns `null` when
 * `peakIdx` is out of range or either side never crosses within the window
 * (a shoulder, or a peak that runs off the window edge).
 */
export function fwhm(
  x: Float64Array,
  y: Float64Array,
  peakIdx: number,
  halfHeight: number,
  lo: number,
  hi: number,
): number | null {
  if (peakIdx < lo || peakIdx >= hi || peakIdx < 0 || peakIdx >= x.length) return null;
  const left = crossingLeft(x, y, peakIdx, halfHeight, lo);
  const right = crossingRight(x, y, peakIdx, halfHeight, hi);
  if (left == null || right == null) return null;
  return Math.abs(right - left);
}

/** Walk from `peakIdx` down to `lo`, returning the interpolated x of the
 *  first crossing of `level`, or null if none is found. */
function crossingLeft(
  x: Float64Array,
  y: Float64Array,
  peakIdx: number,
  level: number,
  lo: number,
): number | null {
  for (let i = peakIdx; i > lo; i--) {
    const y0 = y[i];
    const y1 = y[i - 1];
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    if ((y0 - level) * (y1 - level) <= 0 && y0 !== y1) {
      const t = (level - y0) / (y1 - y0);
      return x[i] + t * (x[i - 1] - x[i]);
    }
  }
  return null;
}

/** Walk from `peakIdx` up to `hi - 1`, returning the interpolated x of the
 *  first crossing of `level`, or null if none is found. */
function crossingRight(
  x: Float64Array,
  y: Float64Array,
  peakIdx: number,
  level: number,
  hi: number,
): number | null {
  const last = hi - 1;
  for (let i = peakIdx; i < last; i++) {
    const y0 = y[i];
    const y1 = y[i + 1];
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    if ((y0 - level) * (y1 - level) <= 0 && y0 !== y1) {
      const t = (level - y0) / (y1 - y0);
      return x[i] + t * (x[i + 1] - x[i]);
    }
  }
  return null;
}
