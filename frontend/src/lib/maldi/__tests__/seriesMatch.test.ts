import { describe, expect, it } from "vitest";
import type { EndGroupCandidate } from "@/lib/maldi/endgroups";
import type { Peak, Series } from "@/lib/maldi/types";
import {
  explainedPeakIds,
  matchSeriesForEndGroup,
  sameLadderSiblings,
  seriesMemberOverlap,
  unexplainedPeaks,
} from "@/lib/maldi/seriesMatch";

const peak = (id: string, mz: number, extra: Partial<Peak> = {}): Peak => ({
  id,
  mz,
  intensity: 100,
  ...extra,
});

const series = (id: string, adductId: string, memberIds: string[], extra: Partial<Series> = {}): Series => ({
  id,
  label: id,
  repeatMass: 44,
  endGroupMass: 18,
  adductId,
  members: memberIds.map((peakId, i) => ({ peakId, n: i })),
  score: 0.9,
  ...extra,
});

const candidate = (id: string, adductId: string, memberIds: string[], extra: Partial<EndGroupCandidate> = {}): EndGroupCandidate => ({
  id,
  residualMass: 18,
  adductId,
  matchedOligomers: memberIds.length,
  meanErrorDa: 0.01,
  confidence: 0.9,
  members: memberIds.map((peakId, i) => ({ peakId, n: i })),
  ...extra,
});

describe("explainedPeakIds", () => {
  it("collects every member peak of every series", () => {
    const s = [series("s1", "Na", ["a", "b"]), series("s2", "K", ["c"])];
    expect([...explainedPeakIds(s)].sort()).toEqual(["a", "b", "c"]);
  });

  it("is empty when no series have members", () => {
    expect(explainedPeakIds([series("s1", "Na", [])]).size).toBe(0);
  });
});

describe("unexplainedPeaks", () => {
  it("keeps accepted, unflagged peaks not in any series", () => {
    const peaks = [
      peak("a", 100), // explained
      peak("b", 144), // explained
      peak("c", 200), // unexplained
      peak("d", 300, { accepted: false }), // rejected
      peak("e", 310, { ignored: true }), // ignored
      peak("f", 320, { flag: "matrix" }), // flagged
    ];
    const s = [series("s1", "Na", ["a", "b"])];
    expect(unexplainedPeaks(peaks, s).map((p) => p.id)).toEqual(["c"]);
  });
});

describe("matchSeriesForEndGroup", () => {
  it("matches the series with the same adduct and an overlapping member", () => {
    const s = [series("s1", "Na", ["a", "b"]), series("s2", "K", ["c"])];
    const c = candidate("c1", "Na", ["b", "x"]);
    expect(matchSeriesForEndGroup(s, c)?.id).toBe("s1");
  });

  it("returns null when adducts differ", () => {
    const s = [series("s1", "Na", ["a", "b"])];
    expect(matchSeriesForEndGroup(s, candidate("c1", "K", ["a"]))).toBeNull();
  });

  it("returns null when no members overlap", () => {
    const s = [series("s1", "Na", ["a", "b"])];
    expect(matchSeriesForEndGroup(s, candidate("c1", "Na", ["z"]))).toBeNull();
  });
});

describe("seriesMemberOverlap", () => {
  it("is 1 for identical member sets (same ladder, different adduct)", () => {
    const a = series("na", "Na", ["a", "b", "c"]);
    const b = series("k", "K", ["a", "b", "c"]);
    expect(seriesMemberOverlap(a, b)).toBe(1);
  });

  it("is 0 for disjoint ladders", () => {
    const a = series("s1", "Na", ["a", "b", "c"]);
    const b = series("s2", "Na", ["x", "y", "z"]);
    expect(seriesMemberOverlap(a, b)).toBe(0);
  });

  it("is the fraction of the smaller set that overlaps", () => {
    const a = series("s1", "Na", ["a", "b", "c", "d"]);
    const b = series("s2", "Na", ["c", "d"]); // both shared, smaller set size 2
    expect(seriesMemberOverlap(a, b)).toBe(1);
    const c = series("s3", "Na", ["c", "z"]); // 1 of 2 shared
    expect(seriesMemberOverlap(a, c)).toBe(0.5);
  });

  it("is 0 when a set is empty", () => {
    expect(seriesMemberOverlap(series("s1", "Na", []), series("s2", "Na", ["a"]))).toBe(0);
  });
});

describe("sameLadderSiblings", () => {
  // The same peak ladder read as three adducts, plus an unrelated ladder.
  const na = series("na", "Na", ["a", "b", "c", "d"]);
  const k = series("k", "K", ["a", "b", "c", "d"]);
  const h = series("h", "H", ["a", "b", "c", "d"]);
  const other = series("other", "Na", ["w", "x", "y", "z"]);

  it("finds the other adduct readings of the same peaks, excluding the target", () => {
    const ids = sameLadderSiblings([na, k, h, other], na).map((s) => s.id).sort();
    expect(ids).toEqual(["h", "k"]);
  });

  it("excludes ladders that do not share enough peaks", () => {
    expect(sameLadderSiblings([na, other], na)).toEqual([]);
  });

  it("excludes already-confirmed (endGroupLocked) series", () => {
    const kLocked = series("k", "K", ["a", "b", "c", "d"], { endGroupLocked: true });
    expect(sameLadderSiblings([na, kLocked, h], na).map((s) => s.id)).toEqual(["h"]);
  });

  it("excludes already-superseded series", () => {
    const kSup = series("k", "K", ["a", "b", "c", "d"], { supersededBy: "na" });
    expect(sameLadderSiblings([na, kSup, h], na).map((s) => s.id)).toEqual(["h"]);
  });

  it("respects the minOverlap threshold", () => {
    const partial = series("p", "K", ["a", "b", "m", "n"]); // 2/4 = 0.5 overlap
    expect(sameLadderSiblings([na, partial], na, 0.6)).toEqual([]);
    expect(sameLadderSiblings([na, partial], na, 0.5).map((s) => s.id)).toEqual(["p"]);
  });
});
