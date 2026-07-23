import { describe, expect, it } from "vitest";
import { matchPredictedSpectrumInRun, selectDiagnosticIons } from "../predictMatch";
import type { MassSpectrum, MsRun } from "../types";

function spectrum(mz: number[], intensity: number[]): MassSpectrum {
  return {
    runId: "predicted",
    mz: Float64Array.from(mz),
    intensity: Float64Array.from(intensity),
    label: "predicted",
    rtLo: 0,
    rtHi: 0,
    scanCount: 1,
    basePeak: null,
  };
}

function run(scans: Array<{ rt: number; mz: number[]; intensity: number[] }>): MsRun {
  const offsets = [0];
  const mz: number[] = [];
  const intensity: number[] = [];
  const baseMz: number[] = [];
  const baseIntensity: number[] = [];
  for (const scan of scans) {
    mz.push(...scan.mz);
    intensity.push(...scan.intensity);
    offsets.push(mz.length);
    let idx = 0;
    for (let i = 1; i < scan.intensity.length; i += 1) {
      if (scan.intensity[i] > scan.intensity[idx]) idx = i;
    }
    baseMz.push(scan.mz[idx] ?? NaN);
    baseIntensity.push(scan.intensity[idx] ?? 0);
  }
  return {
    id: "run",
    name: "run",
    sourcePath: "",
    format: "csv",
    detector: "ms",
    rtMin: Float64Array.from(scans.map((scan) => scan.rt)),
    tic: Float64Array.from(scans.map((scan) => scan.intensity.reduce((a, b) => a + b, 0))),
    basePeakMz: Float64Array.from(baseMz),
    basePeakIntensity: Float64Array.from(baseIntensity),
    msLevel: Uint8Array.from(scans.map(() => 1)),
    scanOffset: Uint32Array.from(offsets),
    mz: Float64Array.from(mz),
    intensity: Float32Array.from(intensity),
    scanCount: scans.length,
    pointCount: mz.length,
    mzRange: [40, 250],
    rtRange: [scans[0]?.rt ?? 0, scans.at(-1)?.rt ?? 0],
    ticRange: [0, 1],
    meta: {},
    warnings: [],
  };
}

describe("predicted spectrum matching", () => {
  const predicted = spectrum([51, 77, 105, 120, 150], [30, 100, 70, 50, 45]);

  it("selects strong separated ions inside the acquired range", () => {
    expect(selectDiagnosticIons(predicted, [70, 130]).map((ion) => ion.mz)).toEqual([
      77, 105, 120,
    ]);
  });

  it("accepts a scan supported by several predicted ions", () => {
    const result = matchPredictedSpectrumInRun(
      run([
        { rt: 1, mz: [43, 77], intensity: [100, 5] },
        { rt: 5, mz: [51, 77, 105, 120, 150], intensity: [30, 100, 70, 50, 45] },
        { rt: 8, mz: [57, 91], intensity: [100, 80] },
      ]),
      predicted,
    );
    expect(result.accepted).toBe(true);
    expect(result.best?.rtMin).toBe(5);
    expect(result.best?.matchedIons).toBe(5);
  });

  it("rejects a coincidental match to one common fragment", () => {
    const result = matchPredictedSpectrumInRun(
      run([
        { rt: 2, mz: [43, 77, 91], intensity: [80, 100, 60] },
        { rt: 4, mz: [55, 69], intensity: [100, 70] },
      ]),
      predicted,
    );
    expect(result.accepted).toBe(false);
    expect(result.best?.matchedIons).toBeLessThan(2);
    expect(result.reason).toContain("No confident match");
  });

  it("keeps a borderline partial overlap as a candidate, not an identification", () => {
    const result = matchPredictedSpectrumInRun(
      run([
        {
          rt: 3,
          mz: [43, 51, 77, 105, 120, 191],
          intensity: [100, 25, 55, 30, 20, 80],
        },
      ]),
      predicted,
    );
    expect(result.best).not.toBeNull();
    expect(result.accepted).toBe(false);
  });
});
