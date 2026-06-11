import { describe, expect, it } from "vitest";
import { computeBaseline, correctBaseline } from "../baseline";

describe("manual (draw) baseline", () => {
  const wn = [0, 1, 2, 3, 4];

  it("is a no-op (flat zero) with fewer than two anchors", () => {
    const abs = [9, 9, 9, 9, 9];
    expect(computeBaseline("Manual (draw)", wn, abs, undefined, undefined, [])).toEqual([
      0, 0, 0, 0, 0,
    ]);
    expect(
      computeBaseline("Manual (draw)", wn, abs, undefined, undefined, [{ x: 2, y: 5 }]),
    ).toEqual([0, 0, 0, 0, 0]);
  });

  it("interpolates linearly between anchors and holds the ends flat", () => {
    const b = computeBaseline("Manual (draw)", wn, [0, 0, 0, 0, 0], undefined, undefined, [
      { x: 1, y: 0 },
      { x: 3, y: 2 },
    ]);
    expect(b).toEqual([0, 0, 1, 2, 2]);
  });

  it("sorts unordered anchors by wavenumber", () => {
    const b = computeBaseline("Manual (draw)", wn, [0, 0, 0, 0, 0], undefined, undefined, [
      { x: 3, y: 2 },
      { x: 1, y: 0 },
    ]);
    expect(b).toEqual([0, 0, 1, 2, 2]);
  });

  it("ignores non-finite anchors", () => {
    const b = computeBaseline("Manual (draw)", wn, [0, 0, 0, 0, 0], undefined, undefined, [
      { x: 1, y: 0 },
      { x: Number.NaN, y: 5 },
      { x: 3, y: 2 },
    ]);
    expect(b).toEqual([0, 0, 1, 2, 2]);
  });

  it("subtracts the same drawn baseline from any spectrum", () => {
    const anchors = [
      { x: 0, y: 1 },
      { x: 4, y: 1 },
    ];
    expect(
      correctBaseline("Manual (draw)", wn, [3, 3, 3, 3, 3], undefined, undefined, anchors),
    ).toEqual([2, 2, 2, 2, 2]);
  });
});
