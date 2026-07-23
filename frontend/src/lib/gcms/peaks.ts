// Peak detection and spectrum similarity for the GC/MS workspace.
//
// `detectChromPeaks` works on a chromatogram trace (regularly sampled in RT):
// smooth with Savitzky-Golay, find local maxima, walk to enclosing valleys,
// reject on height/width, integrate the RAW (unsmoothed) trace with trapezoid.
//
// `pickSpectrumPeaks` works on a centroid-stick mass spectrum: adjacent points
// are unrelated ions, so NO local-maximum test over neighbours is used. Sticks
// are filtered by intensity, then greedily accepted subject to a minimum m/z
// separation.

import type { ChromPeak, ChromTrace, MassSpectrum, SpecPeak } from "./types";
import { nearestIndex, smoothSG, trapezoid } from "./numerics";

let peakCounter = 0;
function peakId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  peakCounter += 1;
  return `gcms-peak-${Date.now()}-${peakCounter}`;
}

// --- chromatogram peaks -----------------------------------------------------

export interface DetectChromPeaksOpts {
  smoothWindow: number;
  thresholdPct: number;
  minWidthScans: number;
  baseline: "none" | "valley" | "rolling";
}

/**
 * Detect chromatogram peaks. Smooth with Savitzky-Golay, find local maxima on
 * the smoothed trace, reject any whose ABSOLUTE height (measured from zero,
 * NOT from any local baseline — `baseline` only affects area integration) is
 * below `thresholdPct`% of the smoothed trace's GLOBAL maximum, walk left and
 * right to the enclosing
 * valleys (first point where the signal stops decreasing) for rtStart/rtEnd,
 * reject peaks narrower than `minWidthScans` points, integrate with
 * `trapezoid` on the RAW (unsmoothed) intensity, and fill `areaPct` = area /
 * total area of all detected peaks * 100. Sort by rtApex.
 */
export function detectChromPeaks(
  trace: ChromTrace,
  opts: DetectChromPeaksOpts,
): ChromPeak[] {
  const { smoothWindow, thresholdPct, minWidthScans, baseline } = opts;
  const rt = trace.rtMin;
  const raw = trace.intensity;
  const n = rt.length;
  if (n < 3 || minWidthScans <= 0) return [];

  const smoothed = smoothSG(raw, smoothWindow);
  // Trace max on the smoothed trace (for the relative threshold).
  let traceMax = -Infinity;
  for (let i = 0; i < n; i += 1) {
    if (smoothed[i] > traceMax) traceMax = smoothed[i];
  }
  if (!(traceMax > 0)) return [];

  const threshold = (thresholdPct / 100) * traceMax;

  // Find local maxima on the smoothed trace. A point is a max when it is >= its
  // neighbours and strictly > at least one (handles flat tops by taking the
  // centre). We collect apex indices.
  const apexes: number[] = [];
  for (let i = 1; i < n - 1; i += 1) {
    const v = smoothed[i];
    if (v < threshold) continue;
    if (v < smoothed[i - 1] || v < smoothed[i + 1]) continue;
    // Walk across a flat top.
    let lo = i;
    let hi = i;
    while (lo > 0 && smoothed[lo - 1] === v) lo -= 1;
    while (hi < n - 1 && smoothed[hi + 1] === v) hi += 1;
    // Apex is the centre of the plateau, but only if it is a local max:
    // neighbours just outside the plateau must be strictly lower.
    if (lo > 0 && smoothed[lo - 1] >= v) continue;
    if (hi < n - 1 && smoothed[hi + 1] >= v) continue;
    apexes.push((lo + hi) >> 1);
  }

  // Rolling minimum baseline (window = 4 * minWidthScans), computed once.
  const rollingMin = baseline === "rolling" ? computeRollingMin(raw, Math.max(1, 4 * minWidthScans)) : null;

  const peaks: ChromPeak[] = [];
  for (const apex of apexes) {
    const peak = integrateAt(trace, smoothed, apex, { minWidthScans, baseline }, rollingMin);
    if (peak) peaks.push(peak);
  }

  const normalized = normalizeAreaPct(peaks);
  normalized.sort((a, b) => a.rtApex - b.rtApex);
  return normalized;
}

/**
 * Sliding-window minimum of `raw` over a trailing window of `win` samples
 * (index `i` gets `min(raw[max(0, i - win + 1) .. i])`), via a monotonic
 * deque so the whole array is O(n). Shared by `detectChromPeaks`'s
 * once-per-trace "rolling" baseline and `integratePeakAt`'s single-peak one.
 */
function computeRollingMin(raw: Float64Array, win: number): Float64Array {
  const n = raw.length;
  const out = new Float64Array(n);
  const deque: number[] = [];
  for (let i = 0; i < n; i += 1) {
    while (deque.length && raw[deque[deque.length - 1]] >= raw[i]) deque.pop();
    deque.push(i);
    while (deque.length && deque[0] <= i - win) deque.shift();
    out[i] = raw[deque[0]];
  }
  return out;
}

/**
 * Given an APEX INDEX already known to be a local max on `smoothed` (or at
 * least the point to integrate around), walk left/right to the enclosing
 * valleys, reject if narrower than `minWidthScans`, and integrate the RAW
 * trace between the valleys with the requested baseline. Returns `null` on a
 * too-narrow result — including the degenerate case where `apex` sits on a
 * dead-flat (or all-zero) stretch, where the valley walk can't move at all
 * and width comes out as 1.
 *
 * Shared by `detectChromPeaks` (called once per detected apex, with a
 * pre-computed `rollingMin` reused across the whole trace) and
 * `integratePeakAt` (called once for a single hand-picked apex) so a
 * hand-added peak is integrated BYTE-FOR-BYTE the same way as a detected one.
 */
function integrateAt(
  trace: ChromTrace,
  smoothed: Float64Array,
  apex: number,
  opts: { minWidthScans: number; baseline: DetectChromPeaksOpts["baseline"] },
  rollingMin: Float64Array | null,
): ChromPeak | null {
  const { minWidthScans, baseline } = opts;
  const rt = trace.rtMin;
  const raw = trace.intensity;
  const n = rt.length;

  // Walk left to the first valley: stop where the signal stops decreasing
  // (i.e. the next point is >= the current point) or at the boundary.
  let left = apex;
  while (left > 0 && smoothed[left - 1] < smoothed[left]) left -= 1;
  // Walk right similarly.
  let right = apex;
  while (right < n - 1 && smoothed[right + 1] < smoothed[right]) right += 1;

  const width = right - left + 1;
  if (width < minWidthScans) return null;

  const height = raw[apex];
  // Compute the baseline-subtracted area on the RAW trace.
  let area: number;
  if (baseline === "valley") {
    // Straight line joining the two valley points.
    const y0 = raw[left];
    const y1 = raw[right];
    const corrected = new Float64Array(width);
    for (let k = 0; k < width; k += 1) {
      const t = width > 1 ? k / (width - 1) : 0;
      const base = y0 + t * (y1 - y0);
      corrected[k] = Math.max(0, raw[left + k] - base);
    }
    // Integrate corrected over rt[left..right].
    area = trapezoid(rt.subarray(left, right + 1), corrected, 0, width - 1);
  } else if (baseline === "rolling" && rollingMin) {
    const corrected = new Float64Array(width);
    for (let k = 0; k < width; k += 1) {
      corrected[k] = Math.max(0, raw[left + k] - rollingMin[left + k]);
    }
    area = trapezoid(rt.subarray(left, right + 1), corrected, 0, width - 1);
  } else {
    // "none" integrates to zero.
    area = trapezoid(rt.subarray(left, right + 1), raw.subarray(left, right + 1), 0, width - 1);
  }

  return {
    id: peakId(),
    runId: trace.runId,
    traceId: trace.id,
    rtApex: rt[apex],
    rtStart: rt[left],
    rtEnd: rt[right],
    scanApex: apex,
    height,
    area,
    areaPct: 0, // filled by normalizeAreaPct once the full set is known
    basePeakMz: null,
  };
}

/**
 * Recompute `areaPct = area / totalArea * 100` (0 when the total is <= 0)
 * across a peak SET. Pure — returns a new array of shallow copies rather than
 * mutating the input, so it's safe to call on peaks that are also held in
 * React state. Used both by `detectChromPeaks` (a fresh detection run) and by
 * the GC/MS page (re-normalising after a derived + manual peak set is
 * merged for display, since a hand-added peak changes the total).
 */
export function normalizeAreaPct(peaks: ChromPeak[]): ChromPeak[] {
  let total = 0;
  for (const p of peaks) total += p.area;
  if (total > 0) return peaks.map((p) => ({ ...p, areaPct: (p.area / total) * 100 }));
  return peaks.map((p) => ({ ...p, areaPct: 0 }));
}

export interface IntegratePeakAtOpts {
  smoothWindow: number;
  minWidthScans: number;
  baseline: DetectChromPeaksOpts["baseline"];
}

/**
 * Integrate a single HAND-PICKED peak at `rtApex` on `trace`, using exactly
 * the same valley-walk + baseline/area logic as `detectChromPeaks` (via the
 * shared `integrateAt`) so a manually-added peak is never distinguishable
 * from a detected one by its numbers. Unlike `detectChromPeaks`, there is no
 * `thresholdPct` gate — the user's click IS the "detection" — so this only
 * rejects on `minWidthScans` (via `integrateAt`), which doubles as the
 * "not a sensible peak here" check: a click on a flat or all-zero stretch of
 * the trace can't climb to a real local maximum, leaving a 1-wide "peak"
 * that's rejected.
 *
 * `areaPct` on the returned peak is a placeholder (0) — same contract as
 * `detectChromPeaks`'s pre-normalisation peaks; the caller must run the
 * result through `normalizeAreaPct` together with whatever other peaks it
 * will be shown alongside.
 */
export function integratePeakAt(
  trace: ChromTrace,
  rtApex: number,
  opts: IntegratePeakAtOpts,
): ChromPeak | null {
  const { smoothWindow, minWidthScans, baseline } = opts;
  const rt = trace.rtMin;
  const raw = trace.intensity;
  const n = rt.length;
  if (n < 3 || minWidthScans <= 0) return null;

  const nearest = nearestIndex(rt, rtApex);
  if (nearest < 0) return null;

  const smoothed = smoothSG(raw, smoothWindow);

  // Climb from the clicked sample to the enclosing local maximum on the
  // smoothed trace: a click rarely lands exactly on the apex sample, and
  // integrating from an arbitrary non-apex point (rather than the peak's own
  // summit) would under-walk one side of the valley search below. At each
  // step, move toward whichever neighbour is strictly higher (ties don't
  // count as "higher", so this always terminates: each move strictly
  // increases the value, and the array is finite).
  let apex = nearest;
  for (;;) {
    const leftV = apex > 0 ? smoothed[apex - 1] : -Infinity;
    const rightV = apex < n - 1 ? smoothed[apex + 1] : -Infinity;
    if (leftV <= smoothed[apex] && rightV <= smoothed[apex]) break;
    apex = leftV >= rightV ? apex - 1 : apex + 1;
  }
  // Centre on a flat top, same as detectChromPeaks's apex search, so a click
  // anywhere on a plateau integrates the same peak.
  let lo = apex;
  let hi = apex;
  while (lo > 0 && smoothed[lo - 1] === smoothed[lo]) lo -= 1;
  while (hi < n - 1 && smoothed[hi + 1] === smoothed[hi]) hi += 1;
  apex = (lo + hi) >> 1;

  const rollingMin = baseline === "rolling" ? computeRollingMin(raw, Math.max(1, 4 * minWidthScans)) : null;
  return integrateAt(trace, smoothed, apex, { minWidthScans, baseline }, rollingMin);
}

// --- spectrum peaks ---------------------------------------------------------

export interface PickSpectrumPeaksOpts {
  thresholdPct: number;
  maxPeaks: number;
  minSeparationMz: number;
}

/**
 * Pick peaks from a centroid-stick mass spectrum. Adjacent points are
 * unrelated ions, so NO local-maximum-over-neighbours test is used. Every
 * point at or above `thresholdPct`% of the base peak is a candidate; sort by
 * intensity descending, greedily accept while skipping any within
 * `minSeparationMz` of an already-accepted one, stop at `maxPeaks`. Return
 * sorted by m/z ascending with `relPct = intensity / basePeak.intensity * 100`.
 */
export function pickSpectrumPeaks(
  spec: MassSpectrum,
  opts: PickSpectrumPeaksOpts,
): SpecPeak[] {
  const { thresholdPct, maxPeaks, minSeparationMz } = opts;
  const mz = spec.mz;
  const intensity = spec.intensity;
  const n = mz.length;
  if (n === 0 || maxPeaks <= 0) return [];

  let baseIdx = -1;
  let baseV = -Infinity;
  for (let i = 0; i < n; i += 1) {
    if (intensity[i] > baseV) {
      baseV = intensity[i];
      baseIdx = i;
    }
  }
  if (baseIdx < 0 || !(baseV > 0)) return [];

  const threshold = (thresholdPct / 100) * baseV;

  // Candidates: indices at or above threshold.
  const cands: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (intensity[i] >= threshold) cands.push(i);
  }
  // Sort by intensity descending (stable: ties keep ascending-mz order).
  cands.sort((a, b) => {
    const d = intensity[b] - intensity[a];
    if (d !== 0) return d;
    return mz[a] - mz[b];
  });

  const accepted: number[] = [];
  for (const idx of cands) {
    if (accepted.length >= maxPeaks) break;
    let ok = true;
    for (const a of accepted) {
      if (Math.abs(mz[idx] - mz[a]) < minSeparationMz) {
        ok = false;
        break;
      }
    }
    if (ok) accepted.push(idx);
  }

  // Sort accepted by m/z ascending for output.
  accepted.sort((a, b) => mz[a] - mz[b]);

  const out: SpecPeak[] = accepted.map((idx) => ({
    id: peakId(),
    mz: mz[idx],
    intensity: intensity[idx],
    relPct: (intensity[idx] / baseV) * 100,
  }));
  return out;
}

// --- similarity -------------------------------------------------------------

/**
 * 0..1 cosine (dot-product) similarity of two spectra after binning to
 * `binTol`. Empty spectra return 0.
 */
export function spectrumSimilarity(
  a: MassSpectrum,
  b: MassSpectrum,
  binTol: number,
): number {
  if (binTol <= 0) return 0;
  const am = binSpectrum(a, binTol);
  const bm = binSpectrum(b, binTol);
  // Dot product over the union of bins.
  let dot = 0;
  let na = 0;
  let nb = 0;
  // Iterate the smaller map.
  const [small, large] = am.size <= bm.size ? [am, bm] : [bm, am];
  for (const [k, v] of small) {
    const w = large.get(k);
    if (w !== undefined) dot += v * w;
  }
  for (const v of am.values()) na += v * v;
  for (const v of bm.values()) nb += v * v;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom <= 0) return 0;
  return dot / denom;
}

/** Bin a spectrum into a Map<binKey, summedIntensity>. */
function binSpectrum(spec: MassSpectrum, binTol: number): Map<number, number> {
  const m = new Map<number, number>();
  const mz = spec.mz;
  const intensity = spec.intensity;
  for (let i = 0; i < mz.length; i += 1) {
    const key = Math.round(mz[i] / binTol);
    m.set(key, (m.get(key) ?? 0) + intensity[i]);
  }
  return m;
}