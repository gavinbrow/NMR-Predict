import { describe, expect, it } from "vitest";
import {
  buildXic,
  buildXics,
  combineScans,
  nearestScanIndex,
  scanSpectrum,
  subtractBackground,
  sumSpectra,
} from "../chrom";
import type { MsRun } from "../types";

// Build a small synthetic CSR MsRun. `scans` is a list of {rt, points} where
// points is an ascending-mz list of [mz, intensity]. TIC and basePeak arrays
// are derived from the points (matching the real decoder's behaviour).
interface ScanSpec {
  rt: number;
  points: Array<[number, number]>;
}

function makeRun(scans: ScanSpec[]): MsRun {
  const scanCount = scans.length;
  const rtMin = new Float64Array(scanCount);
  const tic = new Float64Array(scanCount);
  const basePeakMz = new Float64Array(scanCount);
  const basePeakIntensity = new Float64Array(scanCount);
  const msLevel = new Uint8Array(scanCount);
  const scanOffset = new Uint32Array(scanCount + 1);
  let total = 0;
  for (const s of scans) total += s.points.length;
  const mz = new Float64Array(total);
  const intensity = new Float32Array(total);
  let cursor = 0;
  for (let i = 0; i < scanCount; i += 1) {
    rtMin[i] = scans[i].rt;
    msLevel[i] = 1;
    scanOffset[i] = cursor;
    let sumTic = 0;
    let bpmz = 0;
    let bpint = -Infinity;
    for (const [m, inten] of scans[i].points) {
      mz[cursor] = m;
      intensity[cursor] = inten;
      sumTic += inten;
      if (inten > bpint) {
        bpint = inten;
        bpmz = m;
      }
      cursor += 1;
    }
    scanOffset[i + 1] = cursor;
    tic[i] = sumTic;
    basePeakMz[i] = bpmz;
    basePeakIntensity[i] = bpint;
  }
  let minMz = Infinity;
  let maxMz = -Infinity;
  let minRt = Infinity;
  let maxRt = -Infinity;
  let minTic = Infinity;
  let maxTic = -Infinity;
  for (let i = 0; i < scanCount; i += 1) {
    if (rtMin[i] < minRt) minRt = rtMin[i];
    if (rtMin[i] > maxRt) maxRt = rtMin[i];
    if (tic[i] < minTic) minTic = tic[i];
    if (tic[i] > maxTic) maxTic = tic[i];
  }
  for (let i = 0; i < total; i += 1) {
    if (mz[i] < minMz) minMz = mz[i];
    if (mz[i] > maxMz) maxMz = mz[i];
  }
  return {
    id: "test-run",
    name: "TEST.D",
    sourcePath: "",
    format: "agilent-ms",
    detector: "ms",
    rtMin,
    tic,
    basePeakMz,
    basePeakIntensity,
    msLevel,
    scanOffset,
    mz,
    intensity,
    scanCount,
    pointCount: total,
    mzRange: total > 0 ? [minMz, maxMz] : [Infinity, -Infinity],
    rtRange: scanCount > 0 ? [minRt, maxRt] : [Infinity, -Infinity],
    ticRange: scanCount > 0 ? [minTic, maxTic] : [Infinity, -Infinity],
    meta: {},
    warnings: [],
  };
}

function makeSpec(mzList: number[], intList: number[], runId = "r"): {
  runId: string;
  mz: Float64Array;
  intensity: Float64Array;
  label: string;
  rtLo: number;
  rtHi: number;
  scanCount: number;
  basePeak: { mz: number; intensity: number } | null;
} {
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
    runId,
    mz,
    intensity,
    label: "test",
    rtLo: 0,
    rtHi: 0,
    scanCount: 1,
    basePeak,
  };
}

describe("buildXic", () => {
  it("sums points within tol of each mz across scans", () => {
    const run = makeRun([
      { rt: 1.0, points: [[100.0, 10], [200.0, 5]] },
      { rt: 2.0, points: [[100.05, 20], [200.0, 7]] },
      { rt: 3.0, points: [[50.0, 1]] },
    ]);
    const xic = buildXic(run, [100.0], 0.1, "sum");
    expect(xic.intensity.length).toBe(3);
    // scan 0: 100.0 within 0.1 of 100 -> 10
    // scan 1: 100.05 within 0.1 of 100 -> 20
    // scan 2: 50.0 not within 0.1 of 100 -> 0
    expect(xic.intensity[0]).toBe(10);
    expect(xic.intensity[1]).toBe(20);
    expect(xic.intensity[2]).toBe(0);
  });

  it("max mode takes the largest matching point per scan", () => {
    const run = makeRun([
      { rt: 1.0, points: [[100.0, 10], [100.08, 30], [100.09, 5]] },
    ]);
    const xic = buildXic(run, [100.0], 0.1, "max");
    expect(xic.intensity[0]).toBe(30);
  });

  it("includes a point exactly at tol (boundary)", () => {
    const run = makeRun([{ rt: 1.0, points: [[100.1, 42]] }]);
    // 100.1 is exactly 0.1 from 100.0 -> included.
    const xic = buildXic(run, [100.0], 0.1, "sum");
    expect(xic.intensity[0]).toBe(42);
  });

  it("an mz matched in no scan gives an all-zero trace", () => {
    const run = makeRun([
      { rt: 1.0, points: [[100.0, 10]] },
      { rt: 2.0, points: [[200.0, 20]] },
    ]);
    const xic = buildXic(run, [999.0], 0.1, "sum");
    expect(xic.intensity[0]).toBe(0);
    expect(xic.intensity[1]).toBe(0);
  });

  it("handles empty run and empty mzList", () => {
    const empty = makeRun([]);
    expect(buildXic(empty, [100], 0.1, "sum").intensity.length).toBe(0);
    const run = makeRun([{ rt: 1.0, points: [[100.0, 10]] }]);
    expect(buildXic(run, [], 0.1, "sum").intensity[0]).toBe(0);
  });
});

describe("buildXics", () => {
  it("returns one independently-profiled trace per m/z in input order", () => {
    const run = makeRun([
      { rt: 1.0, points: [[100.0, 10], [200.0, 1]] },
      { rt: 2.0, points: [[100.0, 20], [200.0, 2]] },
      { rt: 3.0, points: [[100.0, 3], [200.0, 30]] },
    ]);

    const traces = buildXics(run, [200.0, 100.0], 0.05);

    expect(traces).toHaveLength(2);
    expect(traces[0].label).toContain("200.00");
    expect(traces[1].label).toContain("100.00");
    expect(traces[0].id).not.toBe(traces[1].id);
    expect(Array.from(traces[0].intensity)).toEqual([1, 2, 30]);
    expect(Array.from(traces[1].intensity)).toEqual([10, 20, 3]);
  });
});

describe("scanSpectrum", () => {
  it("copies out the first scan", () => {
    const run = makeRun([
      { rt: 1.5, points: [[100.0, 10], [200.0, 5]] },
      { rt: 2.5, points: [[300.0, 1]] },
    ]);
    const s = scanSpectrum(run, 0);
    expect(s.mz.length).toBe(2);
    expect(s.mz[0]).toBe(100.0);
    expect(s.intensity[0]).toBe(10);
    expect(s.basePeak).toEqual({ mz: 100.0, intensity: 10 });
    expect(s.label).toBe("MS scan 0 · RT 1.500");
  });

  it("copies out the last scan", () => {
    const run = makeRun([
      { rt: 1.5, points: [[100.0, 10]] },
      { rt: 2.5, points: [[300.0, 1], [400.0, 8]] },
    ]);
    const s = scanSpectrum(run, 1);
    expect(s.mz.length).toBe(2);
    expect(s.basePeak).toEqual({ mz: 400.0, intensity: 8 });
    expect(s.label).toBe("MS scan 1 · RT 2.500");
  });

  it("clamps an out-of-range scan index", () => {
    const run = makeRun([{ rt: 1.5, points: [[100.0, 10]] }]);
    const sHi = scanSpectrum(run, 99);
    expect(sHi.mz[0]).toBe(100.0);
    const sLo = scanSpectrum(run, -5);
    expect(sLo.mz[0]).toBe(100.0);
  });

  it("handles an empty run without throwing", () => {
    const run = makeRun([]);
    const s = scanSpectrum(run, 0);
    expect(s.mz.length).toBe(0);
    expect(s.basePeak).toBeNull();
  });
});

describe("combineScans", () => {
  it("keeps 100.00 and 100.01 separate at binTol 0.005", () => {
    const run = makeRun([
      { rt: 1.0, points: [[100.0, 10]] },
      { rt: 2.0, points: [[100.01, 20]] },
    ]);
    const spec = combineScans(run, 0.5, 2.5, "sum", 0.005);
    expect(spec.mz.length).toBe(2);
    expect(spec.mz[0]).toBeCloseTo(100.0, 6);
    expect(spec.mz[1]).toBeCloseTo(100.01, 6);
    expect(spec.intensity[0]).toBe(10);
    expect(spec.intensity[1]).toBe(20);
    expect(spec.scanCount).toBe(2);
  });

  it("merges 100.00 and 100.009 at binTol 0.02", () => {
    // Both Math.round(100.0/0.02)=5000 and Math.round(100.009/0.02)=5000.
    const run = makeRun([
      { rt: 1.0, points: [[100.0, 10]] },
      { rt: 2.0, points: [[100.009, 20]] },
    ]);
    const spec = combineScans(run, 0.5, 2.5, "sum", 0.02);
    expect(spec.mz.length).toBe(1);
    // Centroid: (100*10 + 100.009*20)/30 = 100.006...
    expect(spec.mz[0]).toBeCloseTo(100.006, 3);
    expect(spec.intensity[0]).toBe(30);
  });

  it("mean mode divides by scanCount", () => {
    const run = makeRun([
      { rt: 1.0, points: [[100.0, 10]] },
      { rt: 2.0, points: [[100.0, 30]] },
    ]);
    const spec = combineScans(run, 0.5, 2.5, "mean", 0.02);
    expect(spec.intensity[0]).toBeCloseTo((10 + 30) / 2, 6);
  });

  it("uses default binTol 0.02", () => {
    const run = makeRun([{ rt: 1.0, points: [[100.0, 10]] }]);
    const spec = combineScans(run, 0.5, 1.5, "sum");
    expect(spec.mz[0]).toBeCloseTo(100.0, 6);
  });

  it("swaps rtLo > rtHi", () => {
    const run = makeRun([{ rt: 1.0, points: [[100.0, 10]] }]);
    const spec = combineScans(run, 2.5, 0.5, "sum", 0.02);
    expect(spec.scanCount).toBe(1);
  });

  it("labels sum vs mean correctly", () => {
    const run = makeRun([{ rt: 1.0, points: [[100.0, 10]] }]);
    expect(combineScans(run, 0.5, 1.5, "sum").label).toBe("MS + spectrum 0.50..1.50");
    expect(combineScans(run, 0.5, 1.5, "mean").label).toBe("MS avg spectrum 0.50..1.50");
  });

  it("RT window [2,4] combines exactly scans at RT 2, 3 and 4 (not 1)", () => {
    // Each scan has a unique m/z equal to its RT*100 so we can tell which
    // scans contributed: scan RT 1 -> mz 100, RT 2 -> mz 200, etc.
    const run = makeRun([
      { rt: 1.0, points: [[100.0, 1]] },
      { rt: 2.0, points: [[200.0, 1]] },
      { rt: 3.0, points: [[300.0, 1]] },
      { rt: 4.0, points: [[400.0, 1]] },
      { rt: 5.0, points: [[500.0, 1]] },
    ]);
    const spec = combineScans(run, 2, 4, "sum");
    expect(spec.scanCount).toBe(3);
    expect(spec.mz.length).toBe(3);
    // m/z sorted ascending: 200, 300, 400 (NOT 100)
    expect(spec.mz[0]).toBeCloseTo(200.0, 6);
    expect(spec.mz[1]).toBeCloseTo(300.0, 6);
    expect(spec.mz[2]).toBeCloseTo(400.0, 6);
    expect(spec.intensity[0]).toBe(1);
    expect(spec.intensity[1]).toBe(1);
    expect(spec.intensity[2]).toBe(1);
  });

  it("RT window entirely beyond the run's RT range returns an empty spectrum", () => {
    const run = makeRun([
      { rt: 1.0, points: [[100.0, 1]] },
      { rt: 2.0, points: [[200.0, 1]] },
      { rt: 3.0, points: [[300.0, 1]] },
      { rt: 4.0, points: [[400.0, 1]] },
      { rt: 5.0, points: [[500.0, 1]] },
    ]);
    const spec = combineScans(run, 90, 100, "sum");
    expect(spec.scanCount).toBe(0);
    expect(spec.mz.length).toBe(0);
    expect(spec.intensity.length).toBe(0);
    expect(spec.basePeak).toBeNull();
  });
});

describe("subtractBackground", () => {
  it("subtracts matched points and clamps at 0", () => {
    const spec = makeSpec([100.0, 200.0], [10, 5]);
    const bg = makeSpec([100.0, 200.0], [4, 9]);
    const out = subtractBackground(spec, bg, 0.01);
    expect(out.intensity[0]).toBe(6);
    expect(out.intensity[1]).toBe(0); // 5 - 9 clamped
    expect(out.mz[0]).toBe(100.0);
  });

  it("passes unmatched spec points through unchanged", () => {
    const spec = makeSpec([100.0, 200.0], [10, 5]);
    const bg = makeSpec([300.0], [99]);
    const out = subtractBackground(spec, bg, 0.01);
    expect(out.intensity[0]).toBe(10);
    expect(out.intensity[1]).toBe(5);
  });
});

describe("sumSpectra", () => {
  it("returns the input unchanged for 0 or 1 spectra", () => {
    expect(sumSpectra([]).mz.length).toBe(0);
    const one = makeSpec([100.0], [10]);
    expect(sumSpectra([one])).toBe(one);
  });

  it("sums matching m/z bins across spectra", () => {
    const a = makeSpec([100.0, 200.0], [10, 5]);
    const b = makeSpec([100.0, 300.0], [1, 40]);
    const out = sumSpectra([a, b], 0.02);
    expect(out.mz.length).toBe(3);
    const at = (mz: number) => {
      const i = Array.from(out.mz).findIndex((m) => Math.abs(m - mz) < 0.01);
      return out.intensity[i];
    };
    expect(at(100)).toBeCloseTo(11, 6);
    expect(at(200)).toBeCloseTo(5, 6);
    expect(at(300)).toBeCloseTo(40, 6);
  });

  it("bins nearby m/z together within binTol like combineScans", () => {
    const a = makeSpec([100.0], [10]);
    const b = makeSpec([100.009], [20]);
    const out = sumSpectra([a, b], 0.02);
    expect(out.mz.length).toBe(1);
    expect(out.mz[0]).toBeCloseTo(100.006, 3);
    expect(out.intensity[0]).toBe(30);
  });

  it("sums scanCount and spans rtLo/rtHi across inputs", () => {
    const a = { ...makeSpec([100.0], [10]), rtLo: 1.0, rtHi: 2.0, scanCount: 2 };
    const b = { ...makeSpec([200.0], [5]), rtLo: 3.0, rtHi: 4.0, scanCount: 3 };
    const out = sumSpectra([a, b], 0.02);
    expect(out.scanCount).toBe(5);
    expect(out.rtLo).toBe(1.0);
    expect(out.rtHi).toBe(4.0);
  });
});

describe("nearestScanIndex", () => {
  it("finds the nearest scan by rt", () => {
    const run = makeRun([
      { rt: 1.0, points: [[100.0, 1]] },
      { rt: 2.0, points: [[100.0, 1]] },
      { rt: 3.0, points: [[100.0, 1]] },
      { rt: 5.0, points: [[100.0, 1]] },
    ]);
    expect(nearestScanIndex(run, 1.0)).toBe(0);
    expect(nearestScanIndex(run, 0.5)).toBe(0); // below
    expect(nearestScanIndex(run, 6.0)).toBe(3); // above
    expect(nearestScanIndex(run, 2.4)).toBe(1); // between, closer to 2.0
    expect(nearestScanIndex(run, 2.6)).toBe(2); // between, closer to 3.0
    expect(nearestScanIndex(run, 4.0)).toBe(2); // between 3 and 5, equidistant->lower
  });

  it("returns -1 for an empty run", () => {
    const run = makeRun([]);
    expect(nearestScanIndex(run, 1.0)).toBe(-1);
  });
});
