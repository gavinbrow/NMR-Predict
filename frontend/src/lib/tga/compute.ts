// TGA compute engine — pure functions over Float64Arrays.
//
// Implements normalization, DTG on a non-uniform temperature grid, Td at
// thresholds, extrapolated onset/endset, step detection, and residue. It
// never mutates its inputs and never throws; all problems become warnings in
// the returned {@link TgaAnalysis}.

import { polyfitDeg1 } from "@/lib/ir/numerics";
import { smoothSG } from "@/lib/gcms/numerics";
import type { AnalysisParams, NormMode, Step, TgaAnalysis } from "./types";
import { applyBlankCorrection } from "./blank";
import { clampWindow, interp1d, lineIntersectionX } from "./numerics";

/** Epsilon used to guard isothermal segments and degenerate tangent fits. */
const EPS = 1e-12;

/** Normalization result: weight percent and the divisor used to obtain it. */
export interface NormalizationResult {
  weightPct: Float64Array;
  divisor: number;
}

/**
 * Convert recorded weight to weight percent. Returns both the percent array
 * and the divisor so the UI can report the normalization basis.
 *
 * - `"first"` (default): divisor = weightMg[0]. Matches TA Universal Analysis.
 * - `"sampleSize"`: divisor = metadata sampleSizeMg.
 * - `"max"`: divisor = maximum weight in the run.
 * - `"atTemperature"`: divisor = interpolated weight at `params.rezeroTempC`.
 */
export function normalize(
  weightMg: Float64Array,
  tempC: Float64Array,
  mode: NormMode,
  params: Pick<AnalysisParams, "rezeroTempC">,
  meta: { sampleSizeMg: number | null },
): NormalizationResult {
  if (weightMg.length === 0) {
    return { weightPct: new Float64Array(0), divisor: NaN };
  }

  let divisor: number;
  switch (mode) {
    case "first":
      divisor = weightMg[0];
      break;
    case "sampleSize":
      divisor = meta.sampleSizeMg ?? weightMg[0];
      break;
    case "max": {
      let maxW = -Infinity;
      for (let i = 0; i < weightMg.length; i += 1) {
        if (Number.isFinite(weightMg[i]) && weightMg[i] > maxW) maxW = weightMg[i];
      }
      divisor = maxW > 0 ? maxW : weightMg[0];
      break;
    }
    case "atTemperature": {
      const t = params.rezeroTempC;
      if (t === null || tempC.length === 0) {
        divisor = weightMg[0];
      } else {
        divisor = interp1d(t, tempC, weightMg);
      }
      break;
    }
    default: {
      const _exhaustive: never = mode;
      void _exhaustive;
      divisor = weightMg[0];
    }
  }

  if (!Number.isFinite(divisor) || divisor === 0) divisor = weightMg[0] || 1;

  const out = new Float64Array(weightMg.length);
  for (let i = 0; i < weightMg.length; i += 1) {
    out[i] = (weightMg[i] / divisor) * 100;
  }
  return { weightPct: out, divisor };
}

/** Result of DTG computation: both the per-°C and per-minute forms. */
export interface DtgResult {
  dtgPerDegC: Float64Array;
  dtgPerMin: Float64Array;
}

/** Median of |v| over the finite, non-zero entries — the run's typical
 *  per-point step. Median rather than mean so an isothermal hold (a long run of
 *  near-zeros) or a handful of spikes can't move it. Returns 0 when there is
 *  nothing to measure, which callers treat as "no guard available". */
function medianAbs(values: Float64Array): number {
  const mags: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const v = Math.abs(values[i]);
    if (Number.isFinite(v) && v > 0) mags.push(v);
  }
  if (mags.length === 0) return 0;
  mags.sort((a, b) => a - b);
  return mags[mags.length >> 1];
}

/**
 * Compute the derivative thermogravimetric curve. Weight is sampled on a
 * non-uniform temperature grid, so the derivative is taken with respect to
 * index and then divided by dT/di:
 *
 *   dW/dT = -(dW/di) / (dT/di)   (negative dW/di → positive DTG for mass loss)
 *
 * Isothermal segments where |dT/di| < eps produce NaN, which the renderer treats
 * as a gap.
 */
export function computeDtg(
  weightPct: Float64Array,
  tempC: Float64Array,
  timeMin: Float64Array,
  dtgWindow: number,
): DtgResult {
  const n = Math.min(weightPct.length, tempC.length, timeMin.length);
  const window = clampWindow(dtgWindow, n);

  // Compute index-derivatives via Savitzky-Golay. The GC/MS helper pads endpoints
  // so the output length matches the input length, which keeps all arrays aligned.
  const dWdi = smoothSG(weightPct.subarray(0, n), window, 2, 1);
  const dTdi = smoothSG(tempC.subarray(0, n), window, 2, 1);
  const dtdi = smoothSG(timeMin.subarray(0, n), window, 2, 1);

  // Guard the division by the run's OWN typical step, not by an absolute epsilon.
  // dW/dT explodes wherever dT/di approaches zero, and that is not a rare corner:
  // a procedure that holds isothermally before ramping records thousands of points
  // at a constant temperature, and even inside a ramp the recorded temperature
  // wobbles. With only an `EPS`-sized guard, a TRIOS run whose real peak is about
  // 1 %/°C reported a maximum of 148 %/°C — spikes that swamped every threshold
  // downstream and left step detection with nothing to find. Masking anything
  // below 5 % of the median step turns those points into the gaps they are.
  const tFloor = Math.max(EPS, 0.05 * medianAbs(dTdi));
  const timeFloor = Math.max(EPS, 0.05 * medianAbs(dtdi));

  // A run that never heats has no dW/dT at all, and a purely relative guard
  // cannot see that: it scales itself down to whatever tiny wobble the run does
  // have and passes it through, which is how a 0.02 °C equilibration hold came
  // out reporting a -250 %/°C "derivative" and stretched the figure's right-hand
  // axis by two orders of magnitude. Below a degree of total span, dW/dT is a
  // gap everywhere. dW/dt is still perfectly well defined and is left alone.
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const T = tempC[i];
    if (!Number.isFinite(T)) continue;
    if (T < tMin) tMin = T;
    if (T > tMax) tMax = T;
  }
  const isothermal = !(tMax - tMin >= 1);

  const dtgPerDegC = new Float64Array(n);
  const dtgPerMin = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    dtgPerDegC[i] =
      isothermal || Math.abs(dTdi[i]) < tFloor ? NaN : -(dWdi[i] / dTdi[i]);
    // dW/dt = (dW/di) / (dt/di) in %/min. The sign convention for per-minute
    // keeps positive for mass loss because dW/di is negative and dt/di is positive.
    dtgPerMin[i] =
      Number.isFinite(dtdi[i]) && Math.abs(dtdi[i]) >= timeFloor
        ? -(dWdi[i] / dtdi[i])
        : NaN;
  }
  return { dtgPerDegC, dtgPerMin };
}

/**
 * First temperature where `weightPct` drops below `100 − threshold`, linearly
 * interpolated between the bracketing points. Returns null when the curve
 * never crosses the level.
 */
export function tdAt(
  tempC: Float64Array,
  weightPct: Float64Array,
  threshold: number,
): number | null {
  const target = 100 - threshold;
  const n = Math.min(tempC.length, weightPct.length);
  if (n === 0) return null;
  if (weightPct[0] < target) return tempC[0];
  for (let i = 1; i < n; i += 1) {
    const prev = weightPct[i - 1];
    const curr = weightPct[i];
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;
    if (prev >= target && curr < target) {
      const t = (prev - target) / (prev - curr);
      return tempC[i - 1] + t * (tempC[i] - tempC[i - 1]);
    }
  }
  return null;
}

/**
 * Weight % and mg at a requested temperature, defaulting to the run's final
 * temperature when `tempC` is null.
 */
export function residueAt(
  tempC: Float64Array,
  weightPct: Float64Array,
  weightMg: Float64Array,
  residueTempC: number | null,
): { tempC: number; pct: number; mg: number } {
  const T = residueTempC ?? tempC[tempC.length - 1];
  const pct = interp1d(T, tempC, weightPct);
  const mg = interp1d(T, tempC, weightMg);
  return { tempC: T, pct, mg };
}

/**
 * Auto-fitted onset/endset for a single degradation step.
 *
 * - Baseline tangent: line fit over the pre-loss window from the step start to
 *   where the mass loss first exceeds 0.5 % of the step's total loss.
 * - Inflection tangent: line fit over a window centred on the DTG extremum,
 *   spanning ±25 % of the step's half-width, min 5 points.
 * - Onset = x-intersection of the baseline and inflection tangents.
 * - Endset = intersection of the inflection tangent with the post-step plateau
 *   line (fitted from the step end).
 */
export function extrapolatedOnset(
  tempC: Float64Array,
  weightPct: Float64Array,
  dtg: Float64Array,
  iStart: number,
  iPeak: number,
  iEnd: number,
): { tOnset: number | null; tEndset: number | null; tMax: number } {
  const tMax = tempC[iPeak];
  const lossTotal = weightPct[iStart] - weightPct[iEnd];
  const halfLoss = 0.5 * lossTotal;
  const midpointTarget = weightPct[iStart] - halfLoss;

  // Locate the midpoint index by crossing the 50% mass-loss level.
  let iMid = iPeak;
  for (let i = iStart; i <= iEnd; i += 1) {
    if (weightPct[iStart] - weightPct[i] >= halfLoss) {
      iMid = i;
      break;
    }
  }

  // Baseline window: from step start until loss exceeds 0.5% of the step total.
  let iBaselineEnd = iMid;
  const earlyLossThreshold = 0.005 * lossTotal;
  for (let i = iStart; i <= iEnd; i += 1) {
    if (weightPct[iStart] - weightPct[i] > earlyLossThreshold) {
      iBaselineEnd = Math.max(iStart + 1, Math.min(i - 1, iMid));
      break;
    }
  }
  iBaselineEnd = Math.max(iStart + 1, Math.min(iBaselineEnd, iMid, iPeak));

  // Post-step plateau window: from midpoint/peak to the step end.
  const iPlateauStart = Math.min(
    Math.max(iPeak + 1, iMid + 1),
    Math.max(iEnd - 1, iPeak + 1),
  );

  const baseFit = polyfitWindow(tempC, weightPct, iStart, iBaselineEnd);
  const inflFit = inflectionTangent(tempC, weightPct, dtg, iPeak, iStart, iEnd);
  const plateauFit = polyfitWindow(tempC, weightPct, iPlateauStart, iEnd);

  let tOnset: number | null = null;
  if (
    Number.isFinite(baseFit.slope) &&
    Number.isFinite(inflFit.slope) &&
    Math.abs(inflFit.slope - baseFit.slope) > EPS
  ) {
    tOnset = lineIntersectionX(baseFit.slope, baseFit.intercept, inflFit.slope, inflFit.intercept);
  }

  let tEndset: number | null = null;
  if (
    Number.isFinite(plateauFit.slope) &&
    Number.isFinite(inflFit.slope) &&
    Math.abs(plateauFit.slope - inflFit.slope) > EPS
  ) {
    tEndset = lineIntersectionX(inflFit.slope, inflFit.intercept, plateauFit.slope, plateauFit.intercept);
  }

  // Clamp to physical reality: onset should not lie far before the start, and
  // endset should not lie far after the end. A small margin accounts for noisy
  // extrapolations.
  if (Number.isFinite(tOnset) && tOnset !== null) {
    const tStart = tempC[iStart];
    const tLo = tStart - 0.5 * (tempC[iEnd] - tStart);
    if (tOnset < tLo) tOnset = null;
  }
  if (Number.isFinite(tEndset) && tEndset !== null) {
    const tEnd = tempC[iEnd];
    const tHi = tEnd + 0.5 * (tEnd - tempC[iStart]);
    if (tEndset > tHi) tEndset = null;
  }

  return { tOnset, tEndset, tMax };
}

/** Fit a least-squares line over xs/ys from index `lo` to `hi` inclusive. */
function polyfitWindow(
  xs: Float64Array,
  ys: Float64Array,
  lo: number,
  hi: number,
): { slope: number; intercept: number } {
  const n = Math.min(xs.length, ys.length);
  const a = Math.max(0, Math.min(lo, n - 1));
  let b = Math.max(0, Math.min(hi, n - 1));
  if (b < a) b = a;
  const x: number[] = [];
  const y: number[] = [];
  for (let i = a; i <= b; i += 1) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      x.push(xs[i]);
      y.push(ys[i]);
    }
  }
  if (x.length < 2) return { slope: NaN, intercept: NaN };
  return polyfitDeg1(x, y);
}

/**
 * Inflection tangent: least-squares line over a window centred on the DTG peak,
 * spanning ±25% of the step half-width, with a minimum of 5 points.
 */
function inflectionTangent(
  tempC: Float64Array,
  weightPct: Float64Array,
  dtg: Float64Array,
  iPeak: number,
  iStart: number,
  iEnd: number,
): { slope: number; intercept: number } {
  const halfWidth = Math.min(iPeak - iStart, iEnd - iPeak);
  const span = Math.max(2, Math.floor(0.25 * halfWidth));
  let lo = Math.max(iStart, iPeak - span);
  let hi = Math.min(iEnd, iPeak + span);
  if (hi - lo + 1 < 5) {
    const mid = (lo + hi) >>> 1;
    lo = Math.max(iStart, mid - 2);
    hi = Math.min(iEnd, mid + 2);
  }
  return polyfitWindow(tempC, weightPct, lo, hi);
}

/** Detect degradation steps from DTG extrema. */
export function stepDetection(
  tempC: Float64Array,
  weightPct: Float64Array,
  weightMg: Float64Array,
  dtg: Float64Array,
  stepMinLossPct: number,
): Step[] {
  const n = Math.min(tempC.length, weightPct.length, weightMg.length, dtg.length);
  if (n < 5) return [];

  const minLossAbsolute = stepMinLossPct; // threshold is already in percent

  // The tallest DTG peak in the run sets the scale everything below is judged
  // against. An absolute cutoff cannot work across instruments: DAC1's whole
  // curve peaks near 0.09 %/°C while a TRIOS run peaks above 1 %/°C, so a fixed
  // 1e-3 floor is "essentially zero" for one file and "well inside the noise"
  // for the other.
  let maxDtg = 0;
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(dtg[i]) && dtg[i] > maxDtg) maxDtg = dtg[i];
  }

  // Step detection is driven by contiguous positive regions of the DTG curve.
  // On real data each degradation step produces a bell-shaped peak; on a
  // synthetic piecewise-linear ramp the SG derivative is flat, but the ramps
  // are still separated by near-zero plateaus. We therefore partition the curve
  // into components where DTG exceeds a threshold, then keep the highest point
  // in each component as a candidate step. The threshold is 2 % of the run's own
  // peak (with the old absolute value as a floor), which is below any real
  // shoulder and above the baseline wobble that would otherwise register as a
  // "step" on a densely sampled run.
  const threshold = Math.max(1e-3, 0.02 * maxDtg);
  const minRegionWidth = Math.max(5, Math.floor(n * 0.03));
  const components: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(dtg[i]) && dtg[i] > threshold) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      if (i - 1 - start + 1 >= minRegionWidth) {
        components.push([start, i - 1]);
      }
      start = -1;
    }
  }
  if (start !== -1 && n - 1 - start + 1 >= minRegionWidth) {
    components.push([start, n - 1]);
  }

  // If the whole curve collapses to a single positive component but contains
  // a long near-zero run in the middle, split it at the midpoint of that run.
  // This preserves two distinct steps on synthetic piecewise-linear curves where
  // SG padding would otherwise bridge the plateau.
  if (components.length === 1) {
    const [lo, hi] = components[0];
    let bestGapStart = -1;
    let bestGapLen = 0;
    let curStart = -1;
    let curLen = 0;
    for (let i = lo; i <= hi; i += 1) {
      if (Number.isFinite(dtg[i]) && dtg[i] <= threshold) {
        if (curStart === -1) curStart = i;
        curLen += 1;
      } else {
        if (curLen > bestGapLen) {
          bestGapLen = curLen;
          bestGapStart = curStart;
        }
        curStart = -1;
        curLen = 0;
      }
    }
    if (curLen > bestGapLen) {
      bestGapLen = curLen;
      bestGapStart = curStart;
    }
    const minGap = Math.max(5, Math.floor((hi - lo + 1) * 0.1));
    if (bestGapStart !== -1 && bestGapLen >= minGap) {
      const split = Math.min(hi - 1, Math.max(lo + 1, bestGapStart + Math.floor(bestGapLen / 2)));
      components.length = 0;
      components.push([lo, split - 1]);
      components.push([split, hi]);
    }
  }

  const candidates: { i: number; approxLossPct: number }[] = [];
  for (const [lo, hi] of components) {
    if (hi - lo + 1 < 5) continue;
    let iPeak = lo;
    let peakV = dtg[lo];
    for (let i = lo + 1; i <= hi; i += 1) {
      if (dtg[i] > peakV) {
        peakV = dtg[i];
        iPeak = i;
      }
    }

    // Prominence measured against the lowest value in the component and a few
    // points beyond each edge. On synthetic flat ramps the left/right minima
    // inside the component are the same as the peak, so the prominence would
    // collapse to zero. We therefore fall back to the peak value itself as the
    // mass-loss signal when the local minima are essentially flat.
    let leftMin = peakV;
    let rightMin = peakV;
    const leftScanLo = Math.max(0, lo - 3);
    const rightScanHi = Math.min(n - 1, hi + 3);
    for (let j = leftScanLo; j <= iPeak; j += 1) leftMin = Math.min(leftMin, dtg[j]);
    for (let j = iPeak; j <= rightScanHi; j += 1) rightMin = Math.min(rightMin, dtg[j]);
    const prominence =
      peakV - Math.max(leftMin, rightMin, 0) > peakV * 1e-6
        ? peakV - Math.max(leftMin, rightMin, 0)
        : peakV;

    // Approximate mass loss from the peak: area ≈ prominence × half-width
    // (in index units), converted from %/°C to a percent-of-sample proxy.
    let hw = 1;
    for (let j = iPeak; j > lo; j -= 1) {
      if (dtg[j] < peakV / 2) break;
      hw += 1;
    }
    for (let j = iPeak; j < hi; j += 1) {
      if (dtg[j] < peakV / 2) break;
      hw += 1;
    }
    const approxLossPct = prominence * hw * 2;
    // A genuine degradation step is not 3 % as fast as the main one. This gate
    // is on the RATE (the DTG peak height), which is what distinguishes a real
    // shoulder from baseline drift; the mass-loss gate at the end of this
    // function is the separate, user-facing `stepMinLossPct` check.
    const tallEnough = maxDtg <= 0 || peakV >= 0.05 * maxDtg;
    if (tallEnough && approxLossPct >= minLossAbsolute) {
      candidates.push({ i: iPeak, approxLossPct });
    }
  }

  if (candidates.length === 0) return [];

  // Sort by descending prominence and greedily enforce a minimum separation so
  // broad, noisy shoulders don't fragment one real step.
  candidates.sort((a, b) => b.approxLossPct - a.approxLossPct);
  const chosen: number[] = [];
  for (const { i } of candidates) {
    let ok = true;
    for (const j of chosen) {
      if (Math.abs(i - j) < Math.max(5, Math.floor(n * 0.02))) {
        ok = false;
        break;
      }
    }
    if (ok) chosen.push(i);
  }
  chosen.sort((a, b) => a - b);

  const steps: Step[] = [];
  for (let p = 0; p < chosen.length; p += 1) {
    const iPeak = chosen[p];
    const iStart = p === 0
      ? 0
      : Math.min(iPeak - 1, chosen[p - 1] + Math.floor((iPeak - chosen[p - 1]) / 2));
    const iEnd = p === chosen.length - 1
      ? n - 1
      : Math.max(iPeak + 1, chosen[p + 1] - Math.floor((chosen[p + 1] - iPeak) / 2));

    const startT = tempC[iStart];
    const endT = tempC[iEnd];
    const lossPct = weightPct[iStart] - weightPct[iEnd];
    const lossMg = weightMg[iStart] - weightMg[iEnd];

    const { tOnset, tEndset, tMax } = extrapolatedOnset(
      tempC,
      weightPct,
      dtg,
      iStart,
      iPeak,
      iEnd,
    );

    steps.push({
      index: p,
      tMax,
      tOnset,
      tEndset,
      lossPct,
      lossMg,
      tRange: [startT, endT],
    });
  }

  // Final gate on the REAL mass loss across each step's window. The candidate
  // filter above works from a peak-area proxy (prominence x half-width in INDEX
  // units), which scales with how densely the instrument sampled — a 35 000-point
  // TRIOS run inflates it enough that noise shoulders survive as "steps". The
  // parameter is defined as a percentage of the initial mass, so apply it to the
  // quantity it actually names, and renumber what's left so `index` stays dense.
  const kept = steps.filter(
    (step) => !Number.isFinite(step.lossPct) || step.lossPct >= stepMinLossPct,
  );
  return kept.map((step, i) => (step.index === i ? step : { ...step, index: i }));
}

/**
 * Top-level analysis of a single TGA run. Applies optional blank correction,
 * normalization, DTG, Td thresholds, step detection, and residue.
 */
export function computeAnalysis(
  weightMg: Float64Array,
  tempC: Float64Array,
  timeMin: Float64Array,
  params: AnalysisParams,
  meta: { sampleSizeMg: number | null },
  blank?: { tempC: Float64Array; weightMg: Float64Array } | null,
): TgaAnalysis {
  const warnings: string[] = [];

  // 1. Optional blank correction (non-destructive).
  let workingWeightMg = weightMg;
  let workingTempC = tempC;
  if (blank) {
    const correction = applyBlankCorrection(tempC, weightMg, blank.tempC, blank.weightMg);
    warnings.push(...correction.warnings);
    workingWeightMg = correction.correctedWeightMg;
    workingTempC = correction.tempC;
  }

  const n = Math.min(workingWeightMg.length, workingTempC.length, timeMin.length);
  if (n === 0) {
    warnings.push("Run contains no data; analysis empty.");
    return {
      weightPct: new Float64Array(0),
      dtg: new Float64Array(0),
      td: {},
      steps: [],
      residue: { tempC: NaN, pct: NaN, mg: NaN },
      normDivisor: NaN,
      warnings,
    };
  }

  // Slice to the common length so downstream helpers never see misaligned arrays.
  const w = workingWeightMg.subarray(0, n);
  const t = workingTempC.subarray(0, n);
  const time = timeMin.subarray(0, n);

  // 2. Normalize.
  const { weightPct, divisor } = normalize(w, t, params.normMode, params, meta);

  // 3. DTG.
  const { dtgPerDegC, dtgPerMin } = computeDtg(weightPct, t, time, params.dtgWindow);
  const dtg = params.dtgUnit === "%/min" ? dtgPerMin : dtgPerDegC;

  // 4. Td at thresholds.
  const td: Record<number, number | null> = {};
  for (const threshold of params.tdThresholds) {
    td[threshold] = tdAt(t, weightPct, threshold);
  }

  // 5. Step detection.
  const steps = stepDetection(t, weightPct, w, dtgPerDegC, params.stepMinLossPct);

  // 6. Residue.
  const residue = residueAt(t, weightPct, w, params.residueTempC);

  return {
    weightPct,
    dtg,
    td,
    steps,
    residue,
    normDivisor: divisor,
    warnings,
  };
}

/** Convenience re-export of the default parameters. */
export { DEFAULT_PARAMS } from "./types";
