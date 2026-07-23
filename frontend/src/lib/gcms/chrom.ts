// Chromatogram and spectrum builders for the GC/MS workspace.
//
// These operate on the CSR `MsRun` store (scan `i` occupies the half-open
// `[scanOffset[i], scanOffset[i+1])` slice of `mz`/`intensity`, with `mz`
// ASCENDING within every scan) using binary search — never a linear sweep of
// the whole point store. Every public function is total: it never throws and
// handles empty runs, out-of-range indices, and swapped ranges by clamping.

import type { ChromTrace, MassSpectrum, MsRun } from "./types";
import { lowerBound, nearestIndex, upperBound } from "./numerics";

// --- trace builders ---------------------------------------------------------

/** Total-ion chromatogram. Shares the run's arrays; never mutates them. */
export function buildTic(run: MsRun): ChromTrace {
  return {
    id: crypto.randomUUID(),
    runId: run.id,
    kind: "TIC",
    label: "TIC",
    rtMin: run.rtMin,
    intensity: run.tic,
    color: "",
    visible: true,
    offset: 0,
    scale: 1,
  };
}

/** Base-peak chromatogram. Shares the run's arrays; never mutates them. */
export function buildBpc(run: MsRun): ChromTrace {
  return {
    id: crypto.randomUUID(),
    runId: run.id,
    kind: "BPC",
    label: "BPC",
    rtMin: run.rtMin,
    intensity: run.basePeakIntensity,
    color: "",
    visible: true,
    offset: 0,
    scale: 1,
  };
}

/**
 * Extracted-ion chromatogram. For each scan, take all points whose m/z is
 * within `tol` of ANY value in `mzList` and reduce them with `mode`; "sum"
 * adds them, "max" takes the largest. Uses binary search per (scan, m/z).
 */
export function buildXic(
  run: MsRun,
  mzList: number[],
  tol: number,
  mode: "sum" | "max",
): ChromTrace {
  const n = run.scanCount;
  const rtMin = run.rtMin;
  const intensity = new Float64Array(n);
  if (n === 0 || mzList.length === 0) {
    return {
      id: crypto.randomUUID(),
      runId: run.id,
      kind: "XIC",
      label:
        "XIC " + mzList.map((m) => m.toFixed(2)).join(", ") + " ± " + tol.toFixed(2),
      rtMin,
      intensity,
      color: "",
      visible: true,
      offset: 0,
      scale: 1,
    };
  }

  for (let s = 0; s < n; s += 1) {
    const lo = run.scanOffset[s];
    const hi = run.scanOffset[s + 1];
    if (hi <= lo) continue;
    const scanMz = run.mz;
    let acc = 0;
    let seen = false;
    for (let m = 0; m < mzList.length; m += 1) {
      const target = mzList[m];
      // Inclusive match [target - tol, target + tol]. start = first index with
      // mz >= target - tol (upperBound semantics); end = first index with
      // mz > target + tol (lowerBound+1, since lowerBound returns last <= v).
      const a = upperBound(scanMz, target - tol, lo, hi);
      const bRaw = lowerBound(scanMz, target + tol, lo, hi);
      if (bRaw < 0) continue; // nothing <= target + tol in range
      const b = Math.min(hi, bRaw + 1);
      if (b <= a) continue;
      if (mode === "sum") {
        for (let i = a; i < b; i += 1) acc += run.intensity[i];
        if (b > a) seen = true;
      } else {
        for (let i = a; i < b; i += 1) {
          if (!seen || run.intensity[i] > acc) {
            acc = run.intensity[i];
            seen = true;
          }
        }
      }
    }
    intensity[s] = seen ? acc : 0;
  }

  return {
    id: crypto.randomUUID(),
    runId: run.id,
    kind: "XIC",
    label: "XIC " + mzList.map((m) => m.toFixed(2)).join(", ") + " ± " + tol.toFixed(2),
    rtMin,
    intensity,
    color: "",
    visible: true,
    offset: 0,
    scale: 1,
  };
}

// --- spectra ----------------------------------------------------------------

/** Find the index of the largest point in a spectrum slice, or -1 if empty. */
function argmax(mz: Float64Array, intensity: Float64Array, lo: number, hi: number): number {
  let best = -1;
  let bestV = -Infinity;
  for (let i = lo; i < hi; i += 1) {
    if (intensity[i] > bestV) {
      bestV = intensity[i];
      best = i;
    }
  }
  return best;
}

function makeSpectrum(
  runId: string,
  mz: Float64Array,
  intensity: Float64Array,
  label: string,
  rtLo: number,
  rtHi: number,
  scanCount: number,
): MassSpectrum {
  let basePeak: { mz: number; intensity: number } | null = null;
  const idx = argmax(mz, intensity, 0, mz.length);
  if (idx >= 0) {
    basePeak = { mz: mz[idx], intensity: intensity[idx] };
  }
  return {
    runId,
    mz,
    intensity,
    label,
    rtLo,
    rtHi,
    scanCount,
    basePeak,
  };
}

/** The spectrum of one scan, copied out of the CSR store. */
export function scanSpectrum(run: MsRun, scanIndex: number): MassSpectrum {
  const n = run.scanCount;
  let idx = Math.floor(scanIndex);
  if (idx < 0) idx = 0;
  if (idx > n - 1) idx = n - 1;
  if (n === 0) {
    return makeSpectrum(run.id, new Float64Array(0), new Float64Array(0), "MS scan 0 · RT 0.000", 0, 0, 0);
  }
  const lo = run.scanOffset[idx];
  const hi = run.scanOffset[idx + 1];
  const len = hi - lo;
  const mz = new Float64Array(len);
  const intensity = new Float64Array(len);
  for (let i = 0; i < len; i += 1) {
    mz[i] = run.mz[lo + i];
    intensity[i] = run.intensity[lo + i];
  }
  const rt = run.rtMin[idx];
  return makeSpectrum(run.id, mz, intensity, `MS scan ${idx} · RT ${rt.toFixed(3)}`, rt, rt, 1);
}

/**
 * Combine every scan whose rtMin falls in [rtLo, rtHi] into one spectrum,
 * binning by m/z with `binTol` (default 0.02). "sum" adds intensities, "mean"
 * divides by the number of scans combined (including empty scans in the
 * window so the result is an average per scan).
 */
export function combineScans(
  run: MsRun,
  rtLo: number,
  rtHi: number,
  mode: "sum" | "mean",
  binTol = 0.02,
): MassSpectrum {
  let lo = rtLo;
  let hi = rtHi;
  if (lo > hi) {
    const t = lo;
    lo = hi;
    hi = t;
  }
  const n = run.scanCount;
  const rtMin = run.rtMin;
  if (n === 0 || binTol <= 0) {
    return makeSpectrum(
      run.id,
      new Float64Array(0),
      new Float64Array(0),
      mode === "sum"
        ? `MS + spectrum ${lo.toFixed(2)}..${hi.toFixed(2)}`
        : `MS avg spectrum ${lo.toFixed(2)}..${hi.toFixed(2)}`,
      lo,
      hi,
      0,
    );
  }

  // `startScan` is the FIRST scan with rtMin >= lo (inclusive lower bound), and
  // `endScan` is the FIRST scan with rtMin > hi (exclusive upper bound), so the
  // half-open slice [startScan, endScan) contains exactly the scans whose
  // rtMin is in the INCLUSIVE range [lo, hi]. This mirrors buildXic's
  // inclusive [target-tol, target+tol] match. A window entirely beyond the
  // run's RT range yields startScan >= n (or startScan >= endScan) and thus
  // zero scans. Note: the numerics `upperBound(arr, v)` returns the first index
  // with value >= v, so we use `lowerBound(arr, hi) + 1` to get the first index
  // with value strictly greater than hi.
  const startScan = upperBound(rtMin, lo);
  const hiBound = lowerBound(rtMin, hi);
  const endScan = hiBound < 0 ? 0 : hiBound + 1;

  // Bin by Math.round(mz / binTol). Accumulate intensity and the
  // intensity-weighted m/z so the output m/z is the centroid of its bin.
  const binKeys: number[] = [];
  const binIntensity = new Map<number, number>();
  const binMzWeight = new Map<number, number>();
  let scanCount = 0;
  for (let s = startScan; s < endScan && s < n; s += 1) {
    if (s < 0) continue;
    scanCount += 1;
    const plo = run.scanOffset[s];
    const phi = run.scanOffset[s + 1];
    for (let i = plo; i < phi; i += 1) {
      const mzVal = run.mz[i];
      const inten = run.intensity[i];
      const key = Math.round(mzVal / binTol);
      const prevI = binIntensity.get(key);
      if (prevI === undefined) {
        binKeys.push(key);
        binIntensity.set(key, inten);
        binMzWeight.set(key, mzVal * inten);
      } else {
        binIntensity.set(key, prevI + inten);
        binMzWeight.set(key, binMzWeight.get(key)! + mzVal * inten);
      }
    }
  }

  // Emit ASCENDING by m/z.
  binKeys.sort((a, b) => a - b);
  const outLen = binKeys.length;
  const outMz = new Float64Array(outLen);
  const outInten = new Float64Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const k = binKeys[i];
    const inten = binIntensity.get(k)!;
    outInten[i] = mode === "mean" && scanCount > 0 ? inten / scanCount : inten;
    outMz[i] = inten > 0 ? binMzWeight.get(k)! / inten : k * binTol;
  }

  const label =
    mode === "sum"
      ? `MS + spectrum ${lo.toFixed(2)}..${hi.toFixed(2)}`
      : `MS avg spectrum ${lo.toFixed(2)}..${hi.toFixed(2)}`;
  return makeSpectrum(run.id, outMz, outInten, label, lo, hi, scanCount);
}

/**
 * `spec` minus `bg`, matched by m/z within `binTol`, clamped at 0. Points of
 * `spec` with no match in `bg` pass through unchanged.
 */
export function subtractBackground(
  spec: MassSpectrum,
  bg: MassSpectrum,
  binTol: number,
): MassSpectrum {
  const n = spec.mz.length;
  const outMz = new Float64Array(n);
  const outInten = new Float64Array(n);
  const bgMz = bg.mz;
  const bgInten = bg.intensity;
  for (let i = 0; i < n; i += 1) {
    outMz[i] = spec.mz[i];
    // Find a bg point within binTol of spec.mz[i]. Use nearest of the two
    // bracketing entries.
    const m = spec.mz[i];
    const up = upperBound(bgMz, m);
    let matched = -1;
    let bestDiff = binTol;
    if (up < bgMz.length && Math.abs(bgMz[up] - m) <= bestDiff) {
      bestDiff = Math.abs(bgMz[up] - m);
      matched = up;
    }
    if (up > 0 && Math.abs(bgMz[up - 1] - m) <= bestDiff) {
      matched = up - 1;
    }
    let v = spec.intensity[i];
    if (matched >= 0) {
      v -= bgInten[matched];
      if (v < 0) v = 0;
    }
    outInten[i] = v;
  }
  return makeSpectrum(spec.runId, outMz, outInten, spec.label, spec.rtLo, spec.rtHi, spec.scanCount);
}

/**
 * Binary search over run.rtMin: index of the scan whose rtMin is closest to
 * `rt`. -1 when the run has no scans.
 */
export function nearestScanIndex(run: MsRun, rt: number): number {
  return nearestIndex(run.rtMin, rt);
}

/**
 * Sum N already-combined spectra into one, using the SAME centroid-weighted
 * m/z binning `combineScans` uses internally (bin key = `Math.round(mz /
 * binTol)`, output m/z = the intensity-weighted mean within a bin) so
 * summing spectra whose bin grids don't land on identical m/z values still
 * produces sane output. Used for multi-region spectrum slots (Phase 4 tasks
 * A/D): each selected RT window is combined independently via `combineScans`
 * (so the existing scan-combination logic is never duplicated), and the
 * resulting per-region spectra are summed HERE — a distinct, smaller
 * operation over already-produced `MassSpectrum`s rather than raw scans.
 */
export function sumSpectra(specs: MassSpectrum[], binTol = 0.02): MassSpectrum {
  if (specs.length === 0) {
    return makeSpectrum("", new Float64Array(0), new Float64Array(0), "", 0, 0, 0);
  }
  if (specs.length === 1) return specs[0];

  const binKeys: number[] = [];
  const binIntensity = new Map<number, number>();
  const binMzWeight = new Map<number, number>();
  let rtLo = Infinity;
  let rtHi = -Infinity;
  let scanCount = 0;
  for (const s of specs) {
    if (s.rtLo < rtLo) rtLo = s.rtLo;
    if (s.rtHi > rtHi) rtHi = s.rtHi;
    scanCount += s.scanCount;
    for (let i = 0; i < s.mz.length; i += 1) {
      const mzVal = s.mz[i];
      const inten = s.intensity[i];
      const key = Math.round(mzVal / binTol);
      const prevI = binIntensity.get(key);
      if (prevI === undefined) {
        binKeys.push(key);
        binIntensity.set(key, inten);
        binMzWeight.set(key, mzVal * inten);
      } else {
        binIntensity.set(key, prevI + inten);
        binMzWeight.set(key, binMzWeight.get(key)! + mzVal * inten);
      }
    }
  }

  binKeys.sort((a, b) => a - b);
  const outLen = binKeys.length;
  const outMz = new Float64Array(outLen);
  const outInten = new Float64Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const k = binKeys[i];
    const inten = binIntensity.get(k)!;
    outInten[i] = inten;
    outMz[i] = inten > 0 ? binMzWeight.get(k)! / inten : k * binTol;
  }

  if (!Number.isFinite(rtLo)) rtLo = 0;
  if (!Number.isFinite(rtHi)) rtHi = 0;
  return makeSpectrum(specs[0].runId, outMz, outInten, specs[0].label, rtLo, rtHi, scanCount);
}