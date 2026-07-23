import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChemStationMs } from "../agilent/chemstationMs";
import { buildTic, combineScans } from "../chrom";

// Acceptance test against the real Agilent DATA.MS fixture. The fixture lives
// at the repo root in "GCMS Example/DATA.MS"; from this test directory that is
// five `..` segments up (this dir -> gcms -> lib -> src -> frontend -> root).
// The path is verified to resolve to the real file (a silently skipped test
// is a failure of this package), so we resolve explicitly and assert.
const FIXTURE = resolve(
  __dirname,
  "../../../../../GCMS Example/DATA.MS",
);
const present = existsSync(FIXTURE);

describe.skipIf(!present)("real DATA.MS file", () => {
  it("parses and combineScans(3.09, 7.09, sum) matches the reference values", () => {
    const buf = readFileSync(FIXTURE);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const run = parseChemStationMs(ab, { name: "DATA.MS" });

    // Sanity: the decoder produced scans.
    expect(run.scanCount).toBeGreaterThan(0);
    expect(run.pointCount).toBeGreaterThan(0);

    const spec = combineScans(run, 3.09, 7.09, "sum");
    expect(spec.basePeak).not.toBeNull();
    // Base peak: m/z 201.100, intensity 1478437 (±0.05 m/z, ±1 intensity).
    expect(spec.basePeak!.mz).toBeGreaterThanOrEqual(201.05);
    expect(spec.basePeak!.mz).toBeLessThanOrEqual(201.15);
    expect(spec.basePeak!.intensity).toBeGreaterThanOrEqual(1478436);
    expect(spec.basePeak!.intensity).toBeLessThanOrEqual(1478438);

    // Relative abundances, each ±0.02 percentage points, relative to the base
    // peak intensity.
    const bp = spec.basePeak!.intensity;
    const expected: Array<[number, number]> = [
      [162.3, 96.95],
      [201.2, 80.44],
      [203.1, 66.3],
      [162.2, 64.76],
      [162.4, 50.63],
      [121.5, 31.87],
      [121.6, 29.84],
      [121.4, 29.04],
    ];
    for (const [mzTarget, relPctTarget] of expected) {
      // Find the spectrum point with m/z within ±0.05 of the target.
      let bestIdx = -1;
      let bestDiff = Infinity;
      for (let i = 0; i < spec.mz.length; i += 1) {
        const d = Math.abs(spec.mz[i] - mzTarget);
        if (d < bestDiff) {
          bestDiff = d;
          bestIdx = i;
        }
      }
      expect(bestIdx).not.toBe(-1);
      expect(bestDiff).toBeLessThanOrEqual(0.05);
      const relPct = (spec.intensity[bestIdx] / bp) * 100;
      expect(relPct).toBeGreaterThanOrEqual(relPctTarget - 0.02);
      expect(relPct).toBeLessThanOrEqual(relPctTarget + 0.02);
    }
  });

  it("buildTic has its maximum 888665 at RT ~7.401 min", () => {
    const buf = readFileSync(FIXTURE);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const run = parseChemStationMs(ab, { name: "DATA.MS" });
    const tic = buildTic(run);
    let maxIdx = -1;
    let maxV = -Infinity;
    for (let i = 0; i < tic.intensity.length; i += 1) {
      if (tic.intensity[i] > maxV) {
        maxV = tic.intensity[i];
        maxIdx = i;
      }
    }
    expect(maxIdx).not.toBe(-1);
    expect(maxV).toBeGreaterThanOrEqual(888664);
    expect(maxV).toBeLessThanOrEqual(888666);
    const rt = tic.rtMin[maxIdx];
    expect(rt).toBeGreaterThanOrEqual(7.4);
    expect(rt).toBeLessThanOrEqual(7.402);
  });
});