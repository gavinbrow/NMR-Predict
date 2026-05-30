import { describe, expect, it } from "vitest";
import {
  applyProcessing,
  buildCalibration,
  downsample,
  snipBaseline,
  alsBaseline,
} from "../processing";
import type { ProcessingStep, SpectrumData } from "../types";

/** A clean spectrum: sloping baseline + one Gaussian peak, no noise. */
function rampWithPeak(): { spectrum: SpectrumData; peakIndex: number; baseIndex: number } {
  const n = 600;
  const mz = new Float64Array(n);
  const intensity = new Float64Array(n);
  const peakIndex = 300;
  const baseIndex = 50;
  for (let i = 0; i < n; i += 1) {
    mz[i] = 100 + i * 0.5;
    const baseline = 50 + 0.08 * i; // slowly rising
    const peak = 1000 * Math.exp(-((i - peakIndex) ** 2) / (2 * 4 * 4));
    intensity[i] = baseline + peak;
  }
  return { spectrum: { mz, intensity }, peakIndex, baseIndex };
}

describe("baseline correction", () => {
  it("SNIP removes a sloping baseline while preserving the peak", () => {
    const { spectrum, peakIndex, baseIndex } = rampWithPeak();
    const baseline = snipBaseline(spectrum.intensity, 40);
    const corrected = spectrum.intensity.map((v, i) => Math.max(0, v - baseline[i]));
    // Baseline-only region collapses toward zero…
    expect(corrected[baseIndex]).toBeLessThan(spectrum.intensity[baseIndex] * 0.2);
    // …while the peak is largely retained.
    expect(corrected[peakIndex]).toBeGreaterThan(800);
  });

  it("ALS estimates a smooth baseline under the peak", () => {
    const { spectrum, peakIndex, baseIndex } = rampWithPeak();
    const baseline = alsBaseline(spectrum.intensity, 1e4, 0.01, 10);
    // Baseline tracks the ramp at a peak-free point…
    expect(Math.abs(baseline[baseIndex] - spectrum.intensity[baseIndex])).toBeLessThan(5);
    // …and stays well below the peak apex.
    expect(baseline[peakIndex]).toBeLessThan(spectrum.intensity[peakIndex] * 0.5);
  });
});

describe("applyProcessing", () => {
  it("never mutates the raw spectrum", () => {
    const { spectrum } = rampWithPeak();
    const rawCopy = Float64Array.from(spectrum.intensity);
    const steps: ProcessingStep[] = [
      { id: "1", kind: "baseline", enabled: true, params: { method: "snip", iterations: 30 } },
      { id: "2", kind: "normalize", enabled: true, params: { method: "basePeak" } },
    ];
    applyProcessing(spectrum, steps);
    expect(Array.from(spectrum.intensity)).toEqual(Array.from(rawCopy));
  });

  it("base-peak normalization scales the max to 100", () => {
    const { spectrum } = rampWithPeak();
    const out = applyProcessing(spectrum, [
      { id: "1", kind: "normalize", enabled: true, params: { method: "basePeak" } },
    ]);
    const max = Math.max(...Array.from(out.intensity));
    expect(max).toBeCloseTo(100, 5);
  });

  it("TIC normalization makes the intensities sum to the target", () => {
    const { spectrum } = rampWithPeak();
    const out = applyProcessing(spectrum, [
      { id: "1", kind: "normalize", enabled: true, params: { method: "tic", target: 1 } },
    ]);
    const sum = Array.from(out.intensity).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("crop keeps only the requested m/z window", () => {
    const { spectrum } = rampWithPeak();
    const out = applyProcessing(spectrum, [
      { id: "1", kind: "crop", enabled: true, params: { min: 150, max: 200 } },
    ]);
    expect(out.mz.length).toBeGreaterThan(0);
    expect(Math.min(...Array.from(out.mz))).toBeGreaterThanOrEqual(150);
    expect(Math.max(...Array.from(out.mz))).toBeLessThanOrEqual(200);
  });

  it("skips disabled steps", () => {
    const { spectrum } = rampWithPeak();
    const out = applyProcessing(spectrum, [
      { id: "1", kind: "normalize", enabled: false, params: { method: "basePeak" } },
    ]);
    expect(Array.from(out.intensity)).toEqual(Array.from(spectrum.intensity));
  });
});

describe("calibration", () => {
  it("applies a constant shift from a single calibrant", () => {
    const transform = buildCalibration([{ measured: 1000, reference: 1000.1 }], 1);
    expect(transform(500)).toBeCloseTo(500.1, 6);
  });

  it("fits a linear correction from two calibrants", () => {
    const transform = buildCalibration(
      [
        { measured: 100, reference: 100.1 },
        { measured: 300, reference: 300.1 },
      ],
      1,
    );
    expect(transform(200)).toBeCloseTo(200.1, 4);
  });
});

describe("downsample", () => {
  it("reduces point count while preserving the tallest peak", () => {
    const n = 20000;
    const mz = new Float64Array(n);
    const intensity = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      mz[i] = i;
      intensity[i] = 1;
    }
    intensity[12345] = 9999; // a single tall spike
    const out = downsample({ mz, intensity }, 2000);
    expect(out.mz.length).toBeLessThan(n);
    expect(Math.max(...Array.from(out.intensity))).toBe(9999);
  });

  it("returns the input unchanged when already small", () => {
    const small: SpectrumData = { mz: new Float64Array([1, 2, 3]), intensity: new Float64Array([1, 2, 3]) };
    expect(downsample(small, 4000)).toBe(small);
  });
});
