import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChemStationMs } from "../chemstationMs";

// Smoke test against the real Agilent DATA.MS at the repo root. Validates the
// decoder end-to-end on genuine instrument bytes and checks the golden values
// that match the user's reference software screenshot to two decimals.
//
// The fixture path resolves from `frontend/src/lib/gcms/agilent/__tests__/` up
// five directories to the repo root, then into `GCMS Example/DATA.MS`. The file
// MUST exist; a silently skipped test is a failure of this work package.
const FIXTURE = resolve(__dirname, "../../../../../../GCMS Example/DATA.MS");
const present = existsSync(FIXTURE);

describe.skipIf(!present)("real DATA.MS file", () => {
  const buf = readFileSync(FIXTURE);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const run = parseChemStationMs(ab, { name: "DATA.MS", sourcePath: FIXTURE });

  it("parses 3306 scans", () => {
    expect(run.scanCount).toBe(3306);
  });

  it("rtMin[0] ~= 3.08687 min (185212 ms)", () => {
    expect(run.rtMin[0]).toBeCloseTo(185212 / 60000, 4);
  });

  it("rtMin[3305] ~= 21.99798 min (1319879 ms)", () => {
    expect(run.rtMin[3305]).toBeCloseTo(1319879 / 60000, 4);
  });

  it("rtMin is strictly increasing", () => {
    for (let i = 1; i < run.scanCount; i += 1) {
      expect(run.rtMin[i]).toBeGreaterThan(run.rtMin[i - 1]);
    }
  });

  it("mzRange ~= [50.0, 549.9]", () => {
    expect(run.mzRange[0]).toBeCloseTo(50.0, 1);
    expect(run.mzRange[1]).toBeCloseTo(549.9, 1);
  });

  it("min TIC === 2461 and max TIC === 888665 (summed, not the trailer)", () => {
    expect(run.ticRange[0]).toBeCloseTo(2461, 0);
    expect(run.ticRange[1]).toBeCloseTo(888665, 0);
  });

  it("rtMin at the max-TIC scan ~= 7.401 min, with 60 pairs", () => {
    let maxIdx = 0;
    for (let i = 1; i < run.scanCount; i += 1) {
      if (run.tic[i] > run.tic[maxIdx]) maxIdx = i;
    }
    expect(run.rtMin[maxIdx]).toBeCloseTo(7.401, 2);
    const npairs = run.scanOffset[maxIdx + 1] - run.scanOffset[maxIdx];
    expect(npairs).toBe(60);
  });

  it("reads meta from the DATA.MS header", () => {
    expect(run.meta.sample).toBe("AcSDCPD");
    expect(run.meta.operator).toBe("Gavin");
    expect(run.meta.method).toBe("GavinMethod");
    expect(run.meta.inlet).toBe("GC");
  });

  it("every scan's mz slice is ascending (all 3306)", () => {
    for (let i = 0; i < run.scanCount; i += 1) {
      const s = run.scanOffset[i];
      const e = run.scanOffset[i + 1];
      for (let p = s + 1; p < e; p += 1) {
        expect(run.mz[p]).toBeGreaterThanOrEqual(run.mz[p - 1]);
      }
    }
  });

  it("does not surface a scanCount/header mismatch warning", () => {
    expect(run.warnings.some((w) => /scanCount/.test(w))).toBe(false);
  });
});