import { describe, expect, it } from "vitest";
import type { XYSeries } from "../types";
import {
  applyOffset,
  downsample,
  normalizeTrace,
  resampleOntoGappy,
  sliceRange,
  unionGrid,
  unionMzColumns,
} from "../view";

function series(x: number[], y: number[]): XYSeries {
  return { x: Float64Array.from(x), y: Float64Array.from(y) };
}

describe("sliceRange", () => {
  it("returns the samples inside the window (inclusive, binary-searched)", () => {
    const s = series([100, 200, 300, 400], [1, 2, 3, 4]);
    const out = sliceRange(s, 150, 350);
    expect(Array.from(out.x)).toEqual([200, 300]);
    expect(Array.from(out.y)).toEqual([2, 3]);
  });

  it("returns an empty series when the window matches nothing", () => {
    const s = series([100, 200, 300], [1, 2, 3]);
    const out = sliceRange(s, 400, 500);
    expect(out.x.length).toBe(0);
    expect(out.y.length).toBe(0);
  });

  it("returns the same object identity when the range covers everything", () => {
    const s = series([100, 200, 300], [1, 2, 3]);
    expect(sliceRange(s, 50, 500)).toBe(s);
    // exact bounds inclusive
    expect(sliceRange(s, 100, 300)).toBe(s);
  });

  it("returns the same object identity for an empty series", () => {
    const s = series([], []);
    expect(sliceRange(s, 0, 100)).toBe(s);
  });
});

describe("downsample", () => {
  it("returns the input unchanged when already small enough", () => {
    const s = series([1, 2, 3], [4, 5, 6]);
    expect(downsample(s, 100)).toBe(s);
  });

  it("preserves a 1-point spike that a stride sampler would drop", () => {
    // 200 points, all 1.0 except a single tall spike in the middle.
    const x = Array.from({ length: 200 }, (_, i) => i);
    const y = x.map((i) => (i === 97 ? 1000 : 1));
    const s = series(x, y);
    const out = downsample(s, 50);
    expect(out.x.length).toBeLessThanOrEqual(50);
    // The spike must survive the min/max bucketing.
    expect(Math.max(...Array.from(out.y))).toBe(1000);
  });
});

describe("resampleOntoGappy", () => {
  it("yields NaN outside the range and interpolates inside", () => {
    const s = series([100, 200, 300], [10, 20, 30]);
    const grid = Float64Array.from([50, 100, 150, 200, 250, 300, 350]);
    const out = resampleOntoGappy(s, grid, 1e9);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[1]).toBe(10);
    expect(out[2]).toBe(15);
    expect(out[3]).toBe(20);
    expect(out[4]).toBe(25);
    expect(out[5]).toBe(30);
    expect(Number.isNaN(out[6])).toBe(true);
  });

  it("yields NaN inside a gap wider than maxGap", () => {
    const s = series([0, 10, 100, 110], [1, 2, 3, 4]);
    // gap between 10 and 100 is 90 units; maxGap = 50 should break the line.
    const grid = Float64Array.from([5, 55, 105]);
    const out = resampleOntoGappy(s, grid, 50);
    expect(out[0]).toBeCloseTo(1.5);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBeCloseTo(3.5);
  });

  it("linearly interpolates correctly at a midpoint", () => {
    const s = series([0, 10], [0, 100]);
    const grid = Float64Array.from([5]);
    expect(resampleOntoGappy(s, grid, 100)[0]).toBeCloseTo(50);
  });

  it("returns all-NaN for an empty series", () => {
    const s = series([], []);
    const grid = Float64Array.from([0, 1, 2]);
    const out = resampleOntoGappy(s, grid, 1);
    expect(out.every(Number.isNaN)).toBe(true);
  });
});

describe("normalizeTrace", () => {
  it("scales the max to exactly 100", () => {
    const s = series([1, 2, 3], [0, 5, 10]);
    const out = normalizeTrace(s);
    expect(out.y[2]).toBe(100);
    expect(out.y[1]).toBeCloseTo(50);
    expect(out.y[0]).toBe(0);
  });

  it("returns the input unchanged when the max is already 100", () => {
    const s = series([1, 2, 3], [0, 50, 100]);
    expect(normalizeTrace(s)).toBe(s);
  });

  it("does not produce NaN/Inf for an all-zero series", () => {
    const s = series([1, 2, 3], [0, 0, 0]);
    const out = normalizeTrace(s);
    expect(out).toBe(s);
    for (let i = 0; i < out.y.length; i += 1) {
      expect(Number.isFinite(out.y[i])).toBe(true);
    }
  });

  it("returns the input unchanged for an empty series", () => {
    const s = series([], []);
    expect(normalizeTrace(s)).toBe(s);
  });
});

describe("applyOffset", () => {
  it("returns the input unchanged for a zero offset", () => {
    const s = series([1, 2, 3], [1, 2, 3]);
    expect(applyOffset(s, 0)).toBe(s);
  });

  it("adds a constant shift", () => {
    const s = series([1, 2, 3], [1, 2, 3]);
    const out = applyOffset(s, 10);
    expect(Array.from(out.y)).toEqual([11, 12, 13]);
    // x is shared, not copied.
    expect(out.x).toBe(s.x);
  });
});

describe("unionGrid", () => {
  it("merges within tolerance, stays sorted, de-duplicates", () => {
    const a = series([100, 200.0000001, 300], [1, 2, 3]);
    const b = series([200.0000002, 400], [4, 5]);
    const grid = unionGrid([a, b], 1e-3);
    expect(Array.from(grid)).toEqual([100, 200.0000001, 300, 400]);
  });

  it("returns an empty grid when no series has samples", () => {
    expect(unionGrid([series([], [])]).length).toBe(0);
    expect(unionGrid([]).length).toBe(0);
  });

  it("de-duplicates exact duplicates", () => {
    const a = series([1, 2, 3], [0, 0, 0]);
    const b = series([1, 2, 3], [0, 0, 0]);
    const grid = unionGrid([a, b], 0);
    expect(Array.from(grid)).toEqual([1, 2, 3]);
  });
});

describe("unionMzColumns", () => {
  it("builds one shared grid and NaN-gaps per spectrum", () => {
    const a = series([100, 200, 300], [10, 20, 30]);
    const b = series([200, 300, 400], [5, 6, 7]);
    const { grid, columns } = unionMzColumns([a, b], 1e-6);
    expect(Array.from(grid)).toEqual([100, 200, 300, 400]);
    expect(columns.length).toBe(2);
    // a occupies 100/200/300, NaN at 400.
    expect(Array.from(columns[0])).toEqual([10, 20, 30, NaN]);
    // b occupies 200/300/400, NaN at 100.
    expect(Number.isNaN(columns[1][0])).toBe(true);
    expect(columns[1][1]).toBe(5);
    expect(columns[1][2]).toBe(6);
    expect(columns[1][3]).toBe(7);
  });

  it("sums duplicate points within one spectrum that land in the same bucket", () => {
    // Two points at m/z ~100 (within tolerance) in one spectrum -> summed.
    const a = series([100, 100.0000001], [10, 5]);
    const { grid, columns } = unionMzColumns([a], 1e-3);
    expect(grid.length).toBe(1);
    expect(columns[0][0]).toBe(15);
  });

  it("handles empty input gracefully", () => {
    const { grid, columns } = unionMzColumns([], 1e-6);
    expect(grid.length).toBe(0);
    expect(columns.length).toBe(0);
  });

  it("handles a series with no points", () => {
    const a = series([100, 200], [1, 2]);
    const empty = series([], []);
    const { grid, columns } = unionMzColumns([a, empty], 1e-6);
    expect(Array.from(grid)).toEqual([100, 200]);
    expect(columns.length).toBe(2);
    expect(columns[1].every(Number.isNaN)).toBe(true);
  });
});