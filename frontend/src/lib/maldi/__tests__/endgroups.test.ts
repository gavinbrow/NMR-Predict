import { describe, expect, it } from "vitest";
import { BUILTIN_ADDUCTS, ionMz } from "../adducts";
import { END_GROUP_LIBRARY, solveEndGroups } from "../endgroups";
import { pickPegPeaks, PEG_REPEAT } from "./fixtures";
import type { Peak } from "../types";

describe("solveEndGroups", () => {
  it("solves the H/OH end group for the Na series and matches the library", () => {
    const { peaks } = pickPegPeaks();
    const na = BUILTIN_ADDUCTS.find((a) => a.id === "Na")!;

    const candidates = solveEndGroups(peaks, PEG_REPEAT, [na]);
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    const best = candidates[0];
    expect(best.adductId).toBe("Na");
    expect(best.residualMass).toBeCloseTo(18.0106, 1);

    // Y-intercept reading: the regression intercept is the end-group neutral mass
    // and the fit is essentially perfect for a clean ladder.
    expect(best.endGroupFit).toBeCloseTo(18.0106, 0);
    expect(best.r2).toBeGreaterThan(0.999);
    expect(best.matchedOligomers).toBeGreaterThanOrEqual(10);
    expect(best.libraryMatch).toMatch(/H \/ OH/);
    expect(best.confidence).toBeGreaterThan(0.5);

    // The candidate carries its member peaks (with oligomer n) so the ladder can
    // be highlighted and regressed (mass vs n) in the report.
    expect(best.members.length).toBeGreaterThanOrEqual(10);
    const ids = new Set(peaks.map((p) => p.id));
    for (const m of best.members) {
      expect(ids.has(m.peakId)).toBe(true);
      expect(Number.isInteger(m.n)).toBe(true);
    }
    // n increases monotonically with member m/z order (a clean ladder).
    const ns = best.members.map((m) => m.n);
    expect([...ns].sort((a, b) => a - b)).toEqual(ns);
  });

  it("includes alkoxide-base end groups (KOtBu) in the library", () => {
    const tbu = END_GROUP_LIBRARY.find((e) => e.id === "tbuoh");
    expect(tbu).toBeDefined();
    expect(tbu!.mass).toBeCloseTo(74.0732, 3);
    expect(tbu!.label).toMatch(/KOtBu/);
  });

  it("matches a KOtBu-initiated PEG series to the tBuO end group", () => {
    const na = BUILTIN_ADDUCTS.find((a) => a.id === "Na")!;
    const tBuOH = 74.0732;
    const peaks: Peak[] = [];
    for (let n = 6; n <= 18; n += 1) {
      const neutral = tBuOH + n * PEG_REPEAT;
      peaks.push({ id: `p${n}`, mz: ionMz(neutral, na), intensity: 100, accepted: true });
    }
    const candidates = solveEndGroups(peaks, PEG_REPEAT, [na]);
    const best = candidates[0];
    // 74.0732 mod 44.0262 ≈ 30.047
    expect(best.residualMass).toBeCloseTo(30.047, 1);
    expect(best.libraryMatch).toMatch(/tBuO/);
  });
});
