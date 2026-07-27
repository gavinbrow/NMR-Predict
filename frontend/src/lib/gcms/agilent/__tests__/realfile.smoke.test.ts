import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChemStationMs } from "../chemstationMs";

// Smoke test against the real Agilent DATA.MS at the repo root. Validates the
// decoder end-to-end on genuine instrument bytes and checks the golden values
// that match the user's reference software screenshot to two decimals.
//
// Keep the original standalone DATA.MS as a regression fixture while also
// validating the newer full ChemStation `.D` example below.
const FIXTURE = resolve(
  __dirname,
  "../../../../../public/__gcmstest/DATA.MS",
);
const present = existsSync(FIXTURE);
const NEW_FIXTURE = resolve(
  __dirname,
  "../../../../../../GCMS Example/ACSDCPD_50_1.D/DATA.MS",
);
const newPresent = existsSync(NEW_FIXTURE);

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

describe.skipIf(!newPresent)("real ACSDCPD_50_1.D DATA.MS file", () => {
  const buf = readFileSync(NEW_FIXTURE);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const run = parseChemStationMs(ab, { name: "ACSDCPD_50_1.D", sourcePath: NEW_FIXTURE });

  it("parses the complete 27 minute run", () => {
    expect(run.scanCount).toBe(20_330);
    expect(run.pointCount).toBe(542_034);
    expect(run.rtRange[0]).toBeCloseTo(3.0868333, 5);
    expect(run.rtRange[1]).toBeCloseTo(27.0026, 4);
  });

  it("preserves the mass and TIC ranges", () => {
    expect(run.mzRange[0]).toBeCloseTo(50, 5);
    expect(run.mzRange[1]).toBeCloseTo(550, 5);
    expect(run.ticRange[0]).toBe(0);
    expect(run.ticRange[1]).toBe(8_201_460);
  });

  it("reads the method metadata without parser warnings", () => {
    expect(run.meta.method).toBe("75476");
    expect(run.meta.inlet).toBe("GC");
    expect(run.warnings).toEqual([]);
  });
});
