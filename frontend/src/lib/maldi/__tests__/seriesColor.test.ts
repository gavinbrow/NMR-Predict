import { describe, expect, it } from "vitest";
import type { Series } from "@/lib/maldi/types";
import { buildLadderColorMap, SERIES_COLORS } from "@/lib/maldi/seriesColor";

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

describe("buildLadderColorMap", () => {
  // The same peak ladder read as three adducts (they share every member peak),
  // plus a second, disjoint ladder.
  const na = series("na", "Na", ["a", "b", "c", "d"]);
  const k = series("k", "K", ["a", "b", "c", "d"]);
  const h = series("h", "H", ["a", "b", "c", "d"]);
  const other = series("other", "Na", ["w", "x", "y", "z"]);

  it("gives every adduct of one ladder the same colour", () => {
    const map = buildLadderColorMap([na, k, h]);
    expect(map.get("na")).toBe(map.get("k"));
    expect(map.get("k")).toBe(map.get("h"));
  });

  it("gives distinct ladders distinct colours", () => {
    const map = buildLadderColorMap([na, k, h, other]);
    expect(map.get("na")).toBe(SERIES_COLORS[0]);
    expect(map.get("other")).toBe(SERIES_COLORS[1]);
    expect(map.get("other")).not.toBe(map.get("na"));
  });

  it("keeps a ladder's colour when one of its adducts is confirmed or superseded", () => {
    // Confirming an adduct (endGroupLocked) or hiding a sibling (supersededBy) must
    // not change the shared ladder colour — grouping is over the full list.
    const kLocked = series("k", "K", ["a", "b", "c", "d"], { endGroupLocked: true });
    const hSup = series("h", "H", ["a", "b", "c", "d"], { supersededBy: "k" });
    const map = buildLadderColorMap([na, kLocked, hSup, other]);
    expect(map.get("na")).toBe(map.get("k"));
    expect(map.get("na")).toBe(map.get("h"));
    expect(map.get("other")).not.toBe(map.get("na"));
  });

  it("assigns colours in first-seen ladder order", () => {
    // `other` appears first, so it takes colour 0 and the na/k/h ladder takes 1.
    const map = buildLadderColorMap([other, na, k, h]);
    expect(map.get("other")).toBe(SERIES_COLORS[0]);
    expect(map.get("na")).toBe(SERIES_COLORS[1]);
  });

  it("splits ladders that fall below the overlap threshold into their own colour", () => {
    const partial = series("p", "K", ["a", "b", "m", "n"]); // 2/4 = 0.5 overlap with na
    const strict = buildLadderColorMap([na, partial], 0.6);
    expect(strict.get("p")).not.toBe(strict.get("na"));
    const loose = buildLadderColorMap([na, partial], 0.5);
    expect(loose.get("p")).toBe(loose.get("na"));
  });

  it("wraps around the palette when there are more ladders than colours", () => {
    const many = SERIES_COLORS.map((_c, i) => series(`s${i}`, "Na", [`peak-${i}`]));
    const wrap = series("wrap", "Na", ["peak-wrap"]);
    const map = buildLadderColorMap([...many, wrap]);
    expect(map.get("wrap")).toBe(SERIES_COLORS[SERIES_COLORS.length % SERIES_COLORS.length]);
    expect(map.get("wrap")).toBe(SERIES_COLORS[0]);
  });
});
