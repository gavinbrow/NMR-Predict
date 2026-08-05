import { describe, expect, it } from "vitest";
import {
  detectChromPeaks,
  integratePeakAt,
  integratePeakRange,
  normalizeAreaPct,
  pickSpectrumPeaks,
  spectrumSimilarity,
} from "../peaks";
import type { ChromTrace, MassSpectrum } from "../types";

// Build a synthetic trace on a regular RT grid (dt = 0.01 min) from a list of
// Gaussians. Each Gaussian: { centre (index), height, sigma (points) }.
function makeTrace(
  n: number,
  dt: number,
  gaussians: Array<{ c: number; h: number; s: number }>,
  noise = 0,
): ChromTrace {
  const rtMin = new Float64Array(n);
  const intensity = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    rtMin[i] = i * dt;
    let v = noise;
    for (const g of gaussians) {
      v += g.h * Math.exp(-((i - g.c) ** 2) / (2 * g.s * g.s));
    }
    intensity[i] = v;
  }
  return {
    id: "trace-1",
    runId: "run-1",
    kind: "TIC",
    label: "TIC",
    rtMin,
    intensity,
    color: "",
    visible: true,
    offset: 0,
    scale: 1,
  };
}

/** Build a small, exact trace for fixed-bound integration assertions. */
function makePointTrace(values: number[], dt = 1): ChromTrace {
  return {
    id: "trace-points",
    runId: "run-points",
    kind: "TIC",
    label: "TIC points",
    rtMin: Float64Array.from(values, (_value, i) => i * dt),
    intensity: Float64Array.from(values),
    color: "",
    visible: true,
    offset: 0,
    scale: 1,
  };
}

function makeSpec(mzList: number[], intList: number[]): MassSpectrum {
  const mz = Float64Array.from(mzList);
  const intensity = Float64Array.from(intList);
  let basePeak: { mz: number; intensity: number } | null = null;
  let bi = -1;
  let bv = -Infinity;
  for (let i = 0; i < intensity.length; i += 1) {
    if (intensity[i] > bv) {
      bv = intensity[i];
      bi = i;
    }
  }
  if (bi >= 0) basePeak = { mz: mz[bi], intensity: intensity[bi] };
  return {
    runId: "r",
    mz,
    intensity,
    label: "test",
    rtLo: 0,
    rtHi: 0,
    scanCount: 1,
    basePeak,
  };
}

describe("detectChromPeaks", () => {
  it("finds exactly 2 Gaussian peaks with correct apexes and areaPct summing to 100", () => {
    // Two well-separated peaks: apex at index 200 (RT 2.00) and 700 (RT 7.00).
    const trace = makeTrace(1000, 0.01, [
      { c: 200, h: 1000, s: 15 },
      { c: 700, h: 500, s: 20 },
    ]);
    const peaks = detectChromPeaks(trace, {
      smoothWindow: 11,
      thresholdPct: 5,
      minWidthScans: 5,
      baseline: "none",
    });
    expect(peaks.length).toBe(2);
    expect(peaks[0].scanApex).toBe(200);
    expect(peaks[1].scanApex).toBe(700);
    expect(peaks[0].rtApex).toBeCloseTo(2.0, 2);
    expect(peaks[1].rtApex).toBeCloseTo(7.0, 2);
    const sumPct = peaks.reduce((a, p) => a + p.areaPct, 0);
    expect(sumPct).toBeCloseTo(100, 6);
  });

  it("rejects a below-threshold third bump", () => {
    // Two tall peaks and one tiny bump.
    const trace = makeTrace(1000, 0.01, [
      { c: 200, h: 1000, s: 15 },
      { c: 500, h: 20, s: 15 }, // 2% of max -> below 5% threshold
      { c: 700, h: 500, s: 20 },
    ]);
    const peaks = detectChromPeaks(trace, {
      smoothWindow: 11,
      thresholdPct: 5,
      minWidthScans: 5,
      baseline: "none",
    });
    expect(peaks.length).toBe(2);
    expect(peaks.map((p) => p.scanApex)).not.toContain(500);
  });

  it("sorts by rtApex ascending", () => {
    const trace = makeTrace(1000, 0.01, [
      { c: 700, h: 500, s: 20 },
      { c: 200, h: 1000, s: 15 },
    ]);
    const peaks = detectChromPeaks(trace, {
      smoothWindow: 11,
      thresholdPct: 5,
      minWidthScans: 5,
      baseline: "none",
    });
    expect(peaks.length).toBe(2);
    expect(peaks[0].rtApex).toBeLessThan(peaks[1].rtApex);
  });
});

describe("integratePeakAt", () => {
  it("integrates a normal apex identically to detectChromPeaks", () => {
    const trace = makeTrace(1000, 0.01, [
      { c: 200, h: 1000, s: 15 },
      { c: 700, h: 500, s: 20 },
    ]);
    const opts = { smoothWindow: 11, minWidthScans: 5, baseline: "valley" as const };
    const detected = detectChromPeaks(trace, { ...opts, thresholdPct: 5 });
    const first = detected[0];
    // Click a little off the true apex (RT 2.03 instead of 2.00) — the climb
    // step should still land on the same apex/valleys as detection did.
    const manual = integratePeakAt(trace, 2.03, opts);
    expect(manual).not.toBeNull();
    expect(manual!.scanApex).toBe(first.scanApex);
    expect(manual!.rtStart).toBeCloseTo(first.rtStart, 9);
    expect(manual!.rtEnd).toBeCloseTo(first.rtEnd, 9);
    expect(manual!.area).toBeCloseTo(first.area, 6);
    expect(manual!.height).toBeCloseTo(first.height, 6);
  });

  it("returns null on a flat/zero region", () => {
    const trace = makeTrace(200, 0.01, []); // all zero, no Gaussians
    const result = integratePeakAt(trace, 1.0, {
      smoothWindow: 11,
      minWidthScans: 5,
      baseline: "none",
    });
    expect(result).toBeNull();
  });
});

describe("integratePeakRange", () => {
  const opts = { smoothWindow: 11, minWidthScans: 13, baseline: "none" as const };

  it("preserves the two nearest selected samples as exact bounds", () => {
    const trace = makePointTrace([0, 2, 1, 5, 1, 2, 0]);
    // 1.6 -> sample 2; 4.4 -> sample 4. No valley expansion to samples 1/5.
    const peak = integratePeakRange(trace, 1.6, 4.4, opts);

    expect(peak).not.toBeNull();
    expect(peak!.rtStart).toBe(2);
    expect(peak!.rtEnd).toBe(4);
    expect(peak!.scanApex).toBe(3);
    expect(peak!.rtApex).toBe(3);
    expect(peak!.height).toBe(5);
    expect(peak!.area).toBe(6);
  });

  it("chooses the apex only inside the selected range", () => {
    const trace = makePointTrace([0, 100, 2, 8, 3, 200, 0]);
    const peak = integratePeakRange(trace, 2, 4, opts);

    expect(peak).not.toBeNull();
    expect(peak!.scanApex).toBe(3);
    expect(peak!.height).toBe(8);
  });

  it("orders reversed endpoints and clamps them to the trace", () => {
    const trace = makePointTrace([1, 3, 2, 7, 1]);
    const peak = integratePeakRange(trace, 99, -99, opts);

    expect(peak).not.toBeNull();
    expect(peak!.rtStart).toBe(0);
    expect(peak!.rtEnd).toBe(4);
    expect(peak!.scanApex).toBe(3);
  });

  it("accepts a two-sample flat range regardless of minWidthScans", () => {
    const trace = makePointTrace([0, 7, 7, 0]);
    const peak = integratePeakRange(trace, 1, 2, {
      smoothWindow: 99,
      minWidthScans: 999,
      baseline: "valley",
    });

    expect(peak).not.toBeNull();
    expect(peak!.rtStart).toBe(1);
    expect(peak!.rtEnd).toBe(2);
    expect(peak!.scanApex).toBe(1); // flat-top ties choose the earlier sample
    expect(peak!.height).toBe(7);
    expect(peak!.area).toBe(0);
  });

  it("retains none, valley, and rolling baseline area behavior", () => {
    const trace = makePointTrace([1, 3, 1]);
    const none = integratePeakRange(trace, 0, 2, { ...opts, minWidthScans: 1 });
    const valley = integratePeakRange(trace, 0, 2, {
      ...opts,
      minWidthScans: 1,
      baseline: "valley",
    });
    const rolling = integratePeakRange(trace, 0, 2, {
      ...opts,
      minWidthScans: 1,
      baseline: "rolling",
    });

    expect(none!.area).toBe(4);
    expect(valley!.area).toBe(2);
    expect(rolling!.area).toBe(2);
  });

  it("rejects selections that resolve to fewer than two samples", () => {
    const trace = makePointTrace([0, 5, 0]);
    expect(integratePeakRange(trace, 1.01, 1.1, opts)).toBeNull();
    expect(integratePeakRange(makePointTrace([5]), -10, 10, opts)).toBeNull();
    expect(integratePeakRange(trace, Number.NaN, 2, opts)).toBeNull();
  });
});

describe("normalizeAreaPct", () => {
  it("recomputes areaPct as a fraction of the combined total without mutating the input", () => {
    const trace = makeTrace(1000, 0.01, [{ c: 200, h: 1000, s: 15 }]);
    const peaks = detectChromPeaks(trace, {
      smoothWindow: 11,
      thresholdPct: 5,
      minWidthScans: 5,
      baseline: "none",
    });
    expect(peaks[0].areaPct).toBeCloseTo(100, 6);
    const original = peaks[0];
    const withExtra = normalizeAreaPct([...peaks, { ...peaks[0], id: "extra", area: peaks[0].area }]);
    // Two equal-area peaks -> 50/50, and the original array/objects untouched.
    expect(withExtra[0].areaPct).toBeCloseTo(50, 6);
    expect(withExtra[1].areaPct).toBeCloseTo(50, 6);
    expect(original.areaPct).toBeCloseTo(100, 6);
  });
});

describe("pickSpectrumPeaks", () => {
  it("minSeparationMz suppresses a neighbouring stick", () => {
    // base peak at 200, neighbour at 200.05 (50%), far peak at 500 (30%).
    const spec = makeSpec([100.0, 200.0, 200.05, 500.0], [10, 1000, 500, 300]);
    const peaks = pickSpectrumPeaks(spec, {
      thresholdPct: 1,
      maxPeaks: 10,
      minSeparationMz: 0.1,
    });
    // 200.05 is within 0.1 of 200.0 -> suppressed.
    const mzs = peaks.map((p) => p.mz);
    expect(mzs).toContain(200.0);
    expect(mzs).not.toContain(200.05);
    expect(mzs).toContain(500.0);
  });

  it("maxPeaks caps the count", () => {
    const spec = makeSpec([100.0, 200.0, 300.0, 400.0], [400, 300, 200, 100]);
    const peaks = pickSpectrumPeaks(spec, {
      thresholdPct: 1,
      maxPeaks: 2,
      minSeparationMz: 0.0,
    });
    expect(peaks.length).toBe(2);
    // Sorted by m/z ascending; the two strongest are 100 and 200.
    expect(peaks[0].mz).toBe(100.0);
    expect(peaks[1].mz).toBe(200.0);
  });

  it("relPct of the base peak is exactly 100", () => {
    const spec = makeSpec([100.0, 200.0], [500, 1000]);
    const peaks = pickSpectrumPeaks(spec, {
      thresholdPct: 1,
      maxPeaks: 10,
      minSeparationMz: 0.0,
    });
    const base = peaks.find((p) => p.mz === 200.0)!;
    expect(base.relPct).toBe(100);
  });

  it("returns sorted by m/z ascending", () => {
    const spec = makeSpec([500.0, 100.0, 300.0], [100, 1000, 500]);
    const peaks = pickSpectrumPeaks(spec, {
      thresholdPct: 1,
      maxPeaks: 10,
      minSeparationMz: 0.0,
    });
    for (let i = 1; i < peaks.length; i += 1) {
      expect(peaks[i].mz).toBeGreaterThan(peaks[i - 1].mz);
    }
  });

  it("handles an empty spectrum", () => {
    const spec = makeSpec([], []);
    expect(pickSpectrumPeaks(spec, { thresholdPct: 1, maxPeaks: 10, minSeparationMz: 0 })).toEqual([]);
  });
});

describe("spectrumSimilarity", () => {
  it("identical spectra -> 1", () => {
    const a = makeSpec([100.0, 200.0], [10, 20]);
    expect(spectrumSimilarity(a, a, 0.01)).toBeCloseTo(1, 10);
  });

  it("disjoint spectra -> 0", () => {
    const a = makeSpec([100.0], [10]);
    const b = makeSpec([200.0], [10]);
    expect(spectrumSimilarity(a, b, 0.01)).toBe(0);
  });

  it("overlapping spectra give a value in (0,1)", () => {
    const a = makeSpec([100.0, 200.0], [10, 0]);
    const b = makeSpec([100.0, 300.0], [10, 5]);
    const sim = spectrumSimilarity(a, b, 0.01);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});
