import { describe, expect, it } from "vitest";
import type { SpectrumData } from "../types";
import {
  applyOffset,
  downsample,
  normalizeTrace,
  peakMarkerScale,
  resampleOnto,
  resampleOntoGappy,
  sliceRange,
  unionGrid,
} from "../view";

function spectrum(mz: number[], intensity: number[]): SpectrumData {
  return { mz: Float64Array.from(mz), intensity: Float64Array.from(intensity) };
}

describe("sliceRange", () => {
  it("returns the samples inside the window (inclusive)", () => {
    const s = spectrum([100, 200, 300, 400], [1, 2, 3, 4]);
    const out = sliceRange(s, 150, 350);
    expect(Array.from(out.mz)).toEqual([200, 300]);
    expect(Array.from(out.intensity)).toEqual([2, 3]);
  });

  it("treats lo/hi either-way-round", () => {
    const s = spectrum([100, 200, 300], [1, 2, 3]);
    const out = sliceRange(s, 300, 100);
    expect(Array.from(out.mz)).toEqual([100, 200, 300]);
  });
});

describe("downsample", () => {
  it("returns the input unchanged when already small enough", () => {
    const s = spectrum([1, 2, 3], [4, 5, 6]);
    expect(downsample(s, 100)).toBe(s);
  });

  it("preserves the visual envelope (min and max of each bucket)", () => {
    const mz = Array.from({ length: 200 }, (_, i) => i);
    const intensity = mz.map((x) => (x % 50 === 0 ? 1000 : 1));
    const s = spectrum(mz, intensity);
    const out = downsample(s, 20);
    // The tall peaks (every 50) must survive the min/max bucketing.
    expect(Math.max(...Array.from(out.intensity))).toBe(1000);
    expect(out.mz.length).toBeLessThan(mz.length);
  });
});

describe("resampleOnto", () => {
  it("interpolates between samples and yields 0 outside the range", () => {
    const s = spectrum([100, 200, 300], [10, 20, 30]);
    const grid = Float64Array.from([50, 100, 150, 200, 250, 300, 350]);
    const out = resampleOnto(grid, s);
    expect(Array.from(out)).toEqual([0, 10, 15, 20, 25, 30, 0]);
  });

  it("returns all-zero for an empty spectrum", () => {
    const s = spectrum([], []);
    const grid = Float64Array.from([0, 1, 2]);
    const out = resampleOnto(grid, s);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});

describe("resampleOntoGappy", () => {
  it("interpolates between samples and yields NaN outside the range", () => {
    const s = spectrum([100, 200, 300], [10, 20, 30]);
    const grid = Float64Array.from([50, 100, 150, 200, 250, 300, 350]);
    const out = resampleOntoGappy(grid, s);
    expect(Number.isNaN(out[0])).toBe(true); // before the spectrum
    expect(out[1]).toBe(10); // exact at the start
    expect(out[2]).toBe(15); // midpoint interpolation
    expect(out[3]).toBe(20);
    expect(out[4]).toBe(25);
    expect(out[5]).toBe(30); // exact at the end
    expect(Number.isNaN(out[6])).toBe(true); // after the spectrum
  });

  it("returns all-NaN for an empty spectrum", () => {
    const s = spectrum([], []);
    const grid = Float64Array.from([0, 1, 2]);
    const out = resampleOntoGappy(grid, s);
    expect(out.every(Number.isNaN)).toBe(true);
  });

  it("gaps a grid narrower than the spectrum on both sides", () => {
    const s = spectrum([200, 300, 400], [2, 3, 4]);
    const grid = Float64Array.from([100, 250, 300, 350, 500]);
    const out = resampleOntoGappy(grid, s);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[1]).toBe(2.5);
    expect(out[2]).toBe(3);
    expect(out[3]).toBe(3.5);
    expect(Number.isNaN(out[4])).toBe(true);
  });
});

describe("normalizeTrace", () => {
  it("scales the max to 100", () => {
    const arr = Float64Array.from([0, 5, 10, 4]);
    const out = normalizeTrace(arr);
    expect(Array.from(out)).toEqual([0, 50, 100, 40]);
  });

  it("returns the input unchanged when the max is ≤ 0", () => {
    const arr = Float64Array.from([-1, 0, 0]);
    expect(normalizeTrace(arr)).toBe(arr);
  });

  it("ignores NaN values when finding the max", () => {
    const arr = Float64Array.from([NaN, 5, 10, NaN]);
    const out = normalizeTrace(arr);
    expect(out[2]).toBe(100);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(Number.isNaN(out[3])).toBe(true);
  });
});

describe("applyOffset", () => {
  it("returns the input unchanged for a zero offset", () => {
    const arr = Float64Array.from([1, 2, 3]);
    expect(applyOffset(arr, 0)).toBe(arr);
  });

  it("adds a constant shift", () => {
    const arr = Float64Array.from([1, 2, 3]);
    const out = applyOffset(arr, 10);
    expect(Array.from(out)).toEqual([11, 12, 13]);
  });
});

describe("unionGrid", () => {
  it("spans the union m/z range of every supplied spectrum", () => {
    const a = spectrum([100, 200, 300], [1, 2, 3]);
    const b = spectrum([400, 500, 600], [4, 5, 6]);
    const grid = unionGrid([a, b], undefined, undefined, 5);
    expect(grid.length).toBe(5);
    expect(grid[0]).toBeCloseTo(100);
    expect(grid[grid.length - 1]).toBeCloseTo(600);
    const step = grid[1] - grid[0];
    for (let i = 1; i < grid.length; i += 1) {
      expect(grid[i] - grid[i - 1]).toBeCloseTo(step, 5);
    }
  });

  it("intersects with the [lo, hi] zoom window when narrower than the union", () => {
    const a = spectrum([100, 200, 300], [1, 2, 3]);
    const b = spectrum([400, 500, 600], [4, 5, 6]);
    const grid = unionGrid([a, b], 200, 500, 4);
    expect(grid.length).toBe(4);
    expect(grid[0]).toBeCloseTo(200);
    expect(grid[grid.length - 1]).toBeCloseTo(500);
  });

  it("returns an empty grid when no spectra have samples", () => {
    expect(unionGrid([spectrum([], [])]).length).toBe(0);
  });
});

describe("resampleOntoGappy on a union grid", () => {
  it("gaps a trace whose range is narrower than the union on both sides", () => {
    const a = spectrum([100, 200, 300], [10, 20, 30]);
    const b = spectrum([400, 500, 600], [40, 50, 60]);
    const grid = unionGrid([a, b], undefined, undefined, 7);
    const aOut = resampleOntoGappy(grid, a);
    // First/last land inside a; the b-only tail is NaN.
    expect(Number.isNaN(aOut[0])).toBe(false);
    expect(Number.isNaN(aOut[aOut.length - 1])).toBe(true);
    const bOut = resampleOntoGappy(grid, b);
    expect(Number.isNaN(bOut[0])).toBe(true);
    expect(Number.isNaN(bOut[bOut.length - 1])).toBe(false);
  });
});

describe("peakMarkerScale", () => {
  it("returns 1 when normalize is off", () => {
    expect(peakMarkerScale(false, 1000)).toBe(1);
  });

  it("returns 100 / windowMax when normalize is on and the window is positive", () => {
    expect(peakMarkerScale(true, 1000)).toBeCloseTo(0.1);
    expect(peakMarkerScale(true, 50)).toBeCloseTo(2);
  });

  it("returns 1 when normalize is on but the window max is non-positive", () => {
    expect(peakMarkerScale(true, 0)).toBe(1);
    expect(peakMarkerScale(true, -5)).toBe(1);
  });
});