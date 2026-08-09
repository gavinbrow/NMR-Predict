import { describe, expect, it } from "vitest";
import { BUILTIN_ADDUCTS } from "../adducts";
import {
  assignSeries,
  detectRepeatUnits,
  fitLadder,
  mergeSeriesGroup,
  peaksForRepeat,
  positionalMembers,
  seriesDisplayLabel,
  seriesForRepeat,
  splitMergedSeries,
  stripLegacyAutoLabels,
} from "../polymers";
import type { Peak, Series } from "../types";
import { pickPegPeaks, PEG_REPEAT } from "./fixtures";

const pegPeaks = pickPegPeaks;

describe("detectRepeatUnits", () => {
  it("identifies the ~44 Da ethylene-oxide repeat as the top candidate", () => {
    const { peaks } = pegPeaks();
    const candidates = detectRepeatUnits(peaks);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].repeatMass).toBeCloseTo(PEG_REPEAT, 1);
    expect(candidates[0].score).toBe(1); // normalized top score
  });

  // A ladder whose isotope satellites survive into the analysis produces three
  // near-identical spacings: repeat (mono→mono) and repeat ± one ¹³C step
  // (mono→A+1 of the next oligomer, and vice-versa). These are NOT distinct
  // repeat units — they are the same repeat measured between isotopologues.
  function isotopeContaminatedLadder(): Peak[] {
    const repeat = 100;
    const end = 200;
    const step = 1.0033548;
    const peaks: Peak[] = [];
    let id = 0;
    for (let n = 0; n <= 10; n += 1) {
      const base = end + n * repeat;
      peaks.push({ id: `m${id++}`, mz: base, intensity: 1000, accepted: true });
      peaks.push({ id: `i${id++}`, mz: base + step, intensity: 350, accepted: true });
    }
    return peaks;
  }

  it("folds isotope-shifted spacings into one repeat unit when isotope-aware (default)", () => {
    const cands = detectRepeatUnits(isotopeContaminatedLadder(), { isotopeAware: true });
    const inBand = cands.filter((c) => Math.abs(c.repeatMass - 100) < 1.5);
    expect(inBand.length).toBe(1);
    expect(inBand[0].repeatMass).toBeCloseTo(100, 1);
  });

  it("keeps the isotope-shifted spacings separate when isotope-awareness is off", () => {
    const cands = detectRepeatUnits(isotopeContaminatedLadder(), { isotopeAware: false });
    const inBand = cands.filter((c) => Math.abs(c.repeatMass - 100) < 1.5);
    expect(inBand.length).toBeGreaterThanOrEqual(2);
  });
});

describe("peaksForRepeat", () => {
  it("highlights the oligomer peaks spaced by the repeat unit", () => {
    const { peaks } = pegPeaks();
    const ids = peaksForRepeat(peaks, PEG_REPEAT);
    // The PEG ladder is long, so most analyzable peaks have a ±repeat neighbour.
    expect(ids.size).toBeGreaterThanOrEqual(10);
    const na = BUILTIN_ADDUCTS.find((a) => a.id === "Na")!;
    const seriesIds = new Set(assignSeries(peaks, PEG_REPEAT, [na])[0].members.map((m) => m.peakId));
    // Every assigned-series member is part of the highlighted preview set.
    for (const id of seriesIds) expect(ids.has(id)).toBe(true);
  });

  it("returns nothing for a repeat unit absent from the spectrum", () => {
    const { peaks } = pegPeaks();
    expect(peaksForRepeat(peaks, 13.37).size).toBe(0);
  });
});

describe("seriesForRepeat", () => {
  it("groups the PEG ladder into a single distinct series", () => {
    const { peaks } = pegPeaks();
    const groups = seriesForRepeat(peaks, PEG_REPEAT);
    // The fixture is one +Na ladder, so one connected ladder is expected.
    expect(groups.length).toBe(1);
    expect(groups[0].peakIds.length).toBeGreaterThanOrEqual(10);

    // Every grouped peak is part of the lumped ±repeat preview set.
    const preview = peaksForRepeat(peaks, PEG_REPEAT);
    for (const id of groups[0].peakIds) expect(preview.has(id)).toBe(true);

    // The ladder's offset is the H2O end group modulo the repeat (PEG is +Na).
    const na = BUILTIN_ADDUCTS.find((a) => a.id === "Na")!;
    const naSeries = assignSeries(peaks, PEG_REPEAT, [na])[0];
    for (const m of naSeries.members) expect(groups[0].peakIds).toContain(m.peakId);
  });

  it("separates interleaved ladders that share a repeat but differ in offset", () => {
    // Two clean ladders with the same ~44 Da repeat but well-separated offsets
    // (15.7 Da apart, clear of any k·repeat) — e.g. two different end groups.
    const mk = (id: string, mz: number): Peak => ({ id, mz, intensity: 1000, accepted: true });
    const a = Array.from({ length: 8 }, (_, n) => mk(`a-${n}`, 1000 + n * PEG_REPEAT));
    const b = Array.from({ length: 8 }, (_, n) => mk(`b-${n}`, 1015.7 + n * PEG_REPEAT));
    const groups = seriesForRepeat([...a, ...b], PEG_REPEAT);

    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.peakIds.length).sort()).toEqual([8, 8]);
    // Each ladder stays pure — never mixing the two id spaces.
    for (const g of groups) {
      const fromB = g.peakIds.filter((id) => id.startsWith("b-")).length;
      expect(fromB === 0 || fromB === g.peakIds.length).toBe(true);
    }
  });

  it("returns nothing for a repeat unit absent from the spectrum", () => {
    const { peaks } = pegPeaks();
    expect(seriesForRepeat(peaks, 13.37)).toEqual([]);
  });
});

describe("assignSeries", () => {
  it("builds a consecutive Na series with the correct end group and low error", () => {
    const { peaks } = pegPeaks();
    const na = BUILTIN_ADDUCTS.find((a) => a.id === "Na")!;
    const series = assignSeries(peaks, PEG_REPEAT, [na]);
    expect(series.length).toBeGreaterThanOrEqual(1);

    const best = series[0];
    expect(best.adductId).toBe("Na");
    expect(best.members.length).toBeGreaterThanOrEqual(10);
    expect(best.meanErrorDa).toBeLessThan(0.3);
    // PEG H/OH end groups → residual ≈ H2O (18.0106) modulo the repeat.
    expect(best.endGroupMass).toBeCloseTo(18.0106, 1);
    // A long, unbroken oligomer run is the strongest evidence.
    expect(best.score).toBeGreaterThan(0.5);
  });

  it("returns a separate series for each candidate adduct (overlapping series)", () => {
    const { peaks } = pegPeaks();
    const subset = BUILTIN_ADDUCTS.filter((a) => ["H", "Na", "K"].includes(a.id));
    const series = assignSeries(peaks, PEG_REPEAT, subset);
    const adductIds = new Set(series.map((s) => s.adductId));
    expect(adductIds.size).toBeGreaterThanOrEqual(2);
  });

  it("returns nothing for an implausible repeat with no consecutive run", () => {
    const { peaks } = pegPeaks();
    const series = assignSeries(peaks, 13.37, BUILTIN_ADDUCTS, { minConsecutive: 5 });
    expect(series.length).toBe(0);
  });
});

// Linear-mode MALDI polymers are often exported at unit (integer) m/z resolution.
// The ±0.5 Da rounding makes a single 224-spacing ladder drift across a ~1 Da
// residual band (adjacent rungs differ by 224 or 225 Da), which the tight 0.5 Da
// high-res tolerance would split into fragments and drop — the "obvious series
// members being ignored" bug. Tolerance is widened automatically for such data.
describe("unit-resolution (integer m/z) ladders", () => {
  const H = BUILTIN_ADDUCTS.find((a) => a.id === "H")!;
  const REPEAT = 224;
  const ladder = [695, 919, 1143, 1368, 1592, 1816, 2040, 2264, 2488];
  const mk = (mz: number): Peak => ({ id: `p${mz}`, mz, intensity: 1000, accepted: true });

  it("links a rounding-drifted ladder into one series via seriesForRepeat", () => {
    const groups = seriesForRepeat(ladder.map(mk), REPEAT);
    expect(groups.length).toBe(1);
    expect(groups[0].peakIds.length).toBe(ladder.length);
  });

  it("assigns every member of the drifted ladder to one series (none ignored)", () => {
    const series = assignSeries(ladder.map(mk), REPEAT, [H]);
    expect(series.length).toBeGreaterThanOrEqual(1);
    expect(series[0].members.length).toBe(ladder.length);
  });

  it("keeps two interleaved unit-resolution ladders separate", () => {
    const a = [695, 919, 1143, 1368, 1592].map(mk);
    const b = [978, 1202, 1426, 1650, 1874].map((m) => ({ ...mk(m), id: `b${m}` }));
    const groups = seriesForRepeat([...a, ...b], REPEAT);
    expect(groups.length).toBe(2);
    for (const g of groups) {
      const fromB = g.peakIds.filter((id) => id.startsWith("b")).length;
      expect(fromB === 0 || fromB === g.peakIds.length).toBe(true);
    }
  });
});

describe("fitLadder", () => {
  const H = BUILTIN_ADDUCTS.find((a) => a.id === "H")!;
  const REPEAT = 224;
  const ladder = [695, 919, 1143, 1368, 1592, 1816, 2040, 2264, 2488];

  it("reads the end group as the Y-intercept of neutral mass vs n", () => {
    const peaks: Peak[] = ladder.map((mz) => ({ id: `p${mz}`, mz, intensity: 1000, accepted: true }));
    const fit = fitLadder(peaks, peaks.map((p) => p.id), REPEAT, H);
    expect(fit).not.toBeNull();
    expect(fit!.members.length).toBe(ladder.length);
    // Consecutive, ascending oligomer numbers.
    const ns = fit!.members.map((m) => m.n);
    expect(ns).toEqual([...ns].sort((x, y) => x - y));
    expect(ns[ns.length - 1] - ns[0]).toBe(ladder.length - 1);
    // End group ≈ 22–23 Da (mod the 224 repeat) for this ladder.
    expect(fit!.endGroupMass).toBeGreaterThan(20);
    expect(fit!.endGroupMass).toBeLessThan(24);
  });

  it("returns null when no member resolves to a positive neutral mass", () => {
    expect(fitLadder([], [], REPEAT, H)).toBeNull();
  });
});

describe("mergeSeriesGroup / splitMergedSeries", () => {
  const H = BUILTIN_ADDUCTS.find((a) => a.id === "H")!;
  const REPEAT = 224;
  // One polymer whose ladder the automatic assignment split in two: the upper
  // half drifted ~0.6 Da off the ideal spacing (instrument calibration), which is
  // enough for linkByRepeat to stop bridging the two halves.
  const lowMz = [695, 919, 1143, 1368];
  const highMz = [2040.6, 2264.6, 2488.6, 2712.6];
  const peaks: Peak[] = [...lowMz, ...highMz].map((mz) => ({
    id: `p${mz}`,
    mz,
    intensity: 1000,
    accepted: true,
  }));
  const mkSeries = (id: string, mzs: number[]): Series => {
    const fit = fitLadder(peaks, mzs.map((m) => `p${m}`), REPEAT, H)!;
    return {
      id,
      label: id,
      repeatMass: REPEAT,
      endGroupMass: fit.endGroupMass,
      adductId: H.id,
      members: fit.members,
      score: fit.score,
      meanErrorDa: fit.meanErrorDa,
      r2: fit.r2,
    };
  };

  it("unions the members and re-fits the combined ladder", () => {
    const a = mkSeries("a", lowMz);
    const b = mkSeries("b", highMz);
    const merged = mergeSeriesGroup([a, b], peaks, BUILTIN_ADDUCTS)!;
    expect(merged).not.toBeNull();
    expect(merged.members.length).toBe(lowMz.length + highMz.length);
    // n runs across the whole ladder, including the gap the split created.
    const ns = merged.members.map((m) => m.n);
    expect(ns).toEqual([...ns].sort((x, y) => x - y));
    expect(new Set(ns).size).toBe(ns.length);
    expect(merged.mergedFrom).toHaveLength(2);
  });

  it("keeps the larger ladder's identity and rejects a group of one", () => {
    const big = mkSeries("big", [...lowMz, 1592]);
    const small = mkSeries("small", highMz.slice(0, 3));
    const merged = mergeSeriesGroup([small, big], peaks, BUILTIN_ADDUCTS)!;
    expect(merged.id).toBe("big");
    expect(mergeSeriesGroup([big], peaks, BUILTIN_ADDUCTS)).toBeNull();
  });

  it("round-trips: splitting a merge restores the originals", () => {
    const a = mkSeries("a", lowMz);
    const b = mkSeries("b", highMz);
    const merged = mergeSeriesGroup([a, b], peaks, BUILTIN_ADDUCTS)!;
    const parts = splitMergedSeries(merged)!;
    expect(parts.map((p) => p.id).sort()).toEqual(["a", "b"]);
    for (const original of [a, b]) {
      const restored = parts.find((p) => p.id === original.id)!;
      expect(restored.members).toEqual(original.members);
      expect(restored.endGroupMass).toBe(original.endGroupMass);
      expect(restored.mergedFrom).toBeUndefined();
    }
    expect(splitMergedSeries(a)).toBeNull();
  });

  it("flattens nested merges so one split fully un-merges", () => {
    const a = mkSeries("a", lowMz.slice(0, 2));
    const b = mkSeries("b", lowMz.slice(2));
    const c = mkSeries("c", highMz);
    const first = mergeSeriesGroup([a, b], peaks, BUILTIN_ADDUCTS)!;
    const second = mergeSeriesGroup([first, c], peaks, BUILTIN_ADDUCTS)!;
    expect(second.mergedFrom).toHaveLength(3);
    expect(splitMergedSeries(second)!.map((p) => p.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("preserves a locked end group across the merge", () => {
    // `a` leads the merge (more members), so its confirmed end group must survive.
    const a = { ...mkSeries("a", lowMz), endGroupLocked: true, endGroupMass: 42 };
    const b = mkSeries("b", highMz.slice(0, 3));
    const merged = mergeSeriesGroup([a, b], peaks, BUILTIN_ADDUCTS)!;
    expect(merged.id).toBe("a");
    expect(merged.endGroupMass).toBe(42);
  });
});

describe("seriesDisplayLabel", () => {
  /** Two ladders of ONE repeat unit: same backbone, end groups 20 Da apart (not a
   *  multiple of the repeat, so `linkByRepeat` keeps them as separate components).
   *  This is the two-polymer sample that made every peak read as one series. */
  function twoLadderPeaks(): Peak[] {
    const repeat = 44.0262;
    const na = 21.98922;
    const peaks: Peak[] = [];
    let id = 0;
    for (const end of [18.0106, 38.0106]) {
      for (let n = 8; n <= 16; n += 1) {
        peaks.push({ id: `p${id++}`, mz: end + n * repeat + na, intensity: 1000, accepted: true });
      }
    }
    return peaks.sort((a, b) => a.mz - b.mz);
  }

  const na = BUILTIN_ADDUCTS.filter((a) => a.id === "Na");

  it("names the ladders of one repeat unit distinctly", () => {
    const series = assignSeries(twoLadderPeaks(), 44.0262, na);
    expect(series.length).toBe(2);
    const labels = series.map((s) => seriesDisplayLabel(s, BUILTIN_ADDUCTS));
    // Both carry the adduct and the repeat unit; the end group tells them apart.
    for (const l of labels) expect(l).toContain("[M+Na]+ · 44.03 Da");
    expect(new Set(labels).size).toBe(2);
  });

  it("prefers the analyst's own name, then the end-group name, then its mass", () => {
    const [s] = assignSeries(twoLadderPeaks(), 44.0262, na);
    expect(seriesDisplayLabel(s, BUILTIN_ADDUCTS)).toContain(`EG ${s.endGroupMass.toFixed(3)}`);
    expect(seriesDisplayLabel({ ...s, endGroupLabel: "H/OH" }, BUILTIN_ADDUCTS)).toBe(
      `[M+Na]+ · 44.03 Da · H/OH`,
    );
    expect(seriesDisplayLabel({ ...s, endGroupLabel: "H/OH", label: "PEG" }, BUILTIN_ADDUCTS)).toBe("PEG");
    // Whitespace is not a name.
    expect(seriesDisplayLabel({ ...s, label: "  " }, BUILTIN_ADDUCTS)).toContain("[M+Na]+");
  });

  it("assignSeries leaves the name to the analyst", () => {
    for (const s of assignSeries(twoLadderPeaks(), 44.0262, na)) expect(s.label).toBeUndefined();
  });
});

describe("stripLegacyAutoLabels", () => {
  const base: Series = {
    id: "s1",
    repeatMass: 44.0262,
    endGroupMass: 18.0106,
    adductId: "Na",
    members: [],
    score: 1,
  };

  it("drops the frozen '<adduct> · <repeat> Da' name older projects carry", () => {
    const [out] = stripLegacyAutoLabels([{ ...base, label: "[M+Na]+ · 44.03 Da" }]);
    expect(out.label).toBeUndefined();
  });

  it("keeps a name the analyst typed, including one that only looks similar", () => {
    const kept = stripLegacyAutoLabels([
      { ...base, label: "PEG-OH" },
      // Right shape, wrong repeat unit — not something this app generated.
      { ...base, label: "[M+Na]+ · 74.04 Da" },
    ]);
    expect(kept.map((s) => s.label)).toEqual(["PEG-OH", "[M+Na]+ · 74.04 Da"]);
  });
});

describe("positionalMembers", () => {
  const peak = (id: string, mz: number): Peak => ({ id, mz, intensity: 1 });

  it("numbers a hand-made group by ascending m/z, whatever order it arrives in", () => {
    const peaks = [peak("c", 300), peak("a", 100), peak("b", 200)];
    expect(positionalMembers(peaks, ["c", "a", "b"])).toEqual([
      { peakId: "a", n: 0 },
      { peakId: "b", n: 1 },
      { peakId: "c", n: 2 },
    ]);
  });

  it("prefers the centroid over the raw m/z, like the rest of the module", () => {
    const peaks: Peak[] = [
      { id: "a", mz: 100, centroid: 400, intensity: 1 },
      { id: "b", mz: 200, centroid: 200.5, intensity: 1 },
    ];
    expect(positionalMembers(peaks, ["a", "b"]).map((m) => m.peakId)).toEqual(["b", "a"]);
  });

  it("drops ids that no longer name a peak", () => {
    expect(positionalMembers([peak("a", 100)], ["a", "gone"])).toEqual([{ peakId: "a", n: 0 }]);
  });

  it("returns nothing for an empty selection", () => {
    expect(positionalMembers([peak("a", 100)], [])).toEqual([]);
  });
});
