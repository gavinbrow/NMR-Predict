import { describe, expect, it } from "vitest";
import { subtractChromBackground } from "../chromBackground";
import type { ChromTrace } from "../types";

function makeTrace(id: string, rt: number[], intensity: number[], color = "#123456"): ChromTrace {
  return {
    id,
    runId: "run1",
    kind: "TIC",
    label: id,
    rtMin: Float64Array.from(rt),
    intensity: Float64Array.from(intensity),
    color,
    visible: true,
    offset: 0,
    scale: 1,
  };
}

describe("subtractChromBackground", () => {
  it("subtracts point-by-point on identical RT grids and clamps negatives to 0", () => {
    const sample = makeTrace("s1", [1, 2, 3], [10, 5, 20]);
    const blank = makeTrace("b1", [1, 2, 3], [4, 8, 2]);
    const out = subtractChromBackground(sample, blank);
    expect(out.id).toBe("s1-bg");
    expect(out.kind).toBe("TIC-bg");
    expect(out.runId).toBe("run1");
    expect(out.color).toBe("#123456");
    expect(out.visible).toBe(true);
    expect(Array.from(out.rtMin)).toEqual([1, 2, 3]);
    // 10−4=6, 5−8=−3→0, 20−2=18
    expect(Array.from(out.intensity)).toEqual([6, 0, 18]);
  });

  it("sample − itself → all zeros (flat baseline)", () => {
    const sample = makeTrace("s1", [1, 2, 3], [10, 20, 30]);
    const out = subtractChromBackground(sample, sample);
    expect(Array.from(out.intensity)).toEqual([0, 0, 0]);
  });

  it("aligns RT-shifted grids by nearest RT, not by index equality", () => {
    const sample = makeTrace("s1", [1, 2, 3, 4], [10, 20, 30, 40]);
    const blank = makeTrace("b1", [1.1, 2.1, 3.1, 4.1], [1, 2, 3, 4]);
    const out = subtractChromBackground(sample, blank);
    // sample[0]=10, nearest blank RT is 1.1 → blank[0]=1 → 9
    // sample[1]=20, nearest blank RT is 2.1 → blank[1]=2 → 18
    // sample[2]=30, nearest blank RT is 3.1 → blank[2]=3 → 27
    // sample[3]=40, nearest blank RT is 4.1 → blank[3]=4 → 36
    expect(Array.from(out.intensity)).toEqual([9, 18, 27, 36]);
  });

  it("never mutates either input", () => {
    const sample = makeTrace("s1", [1, 2], [10, 20]);
    const blank = makeTrace("b1", [1, 2], [3, 4]);
    const sampleBefore = Array.from(sample.intensity);
    const blankBefore = Array.from(blank.intensity);
    subtractChromBackground(sample, blank);
    expect(Array.from(sample.intensity)).toEqual(sampleBefore);
    expect(Array.from(blank.intensity)).toEqual(blankBefore);
  });

  it("empty sample returns an empty derived trace (no throw)", () => {
    const sample = makeTrace("s1", [], []);
    const blank = makeTrace("b1", [1, 2], [3, 4]);
    const out = subtractChromBackground(sample, blank);
    expect(out.intensity.length).toBe(0);
    expect(out.rtMin.length).toBe(0);
  });

  it("empty blank passes the sample through unchanged (no throw)", () => {
    const sample = makeTrace("s1", [1, 2], [10, 20]);
    const blank = makeTrace("b1", [], []);
    const out = subtractChromBackground(sample, blank);
    expect(Array.from(out.intensity)).toEqual([10, 20]);
  });

  it("label is `${sample.label} − bg`", () => {
    const sample = makeTrace("s1", [1], [10]);
    const blank = makeTrace("b1", [1], [3]);
    const out = subtractChromBackground(sample, blank);
    expect(out.label).toBe("s1 − bg");
  });
});