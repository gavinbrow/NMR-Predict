// Unit tests for segment classification, ordinal/cycle numbering, and
// default-segment choice (§WP1.4 of the plan).

import { describe, expect, it } from "vitest";
import { buildSegments, classifySegment, defaultSegmentId, numberSegments } from "../segments";
import type { DscSegment } from "../types";

// --- classifySegment ---------------------------------------------------

describe("classifySegment", () => {
  it("classifies a rising temperature as heat, with the rate rounded to 2 dp", () => {
    // 0 → 100 °C over 10 min = 10 °C/min.
    const tempC = Float64Array.from([0, 100]);
    const timeMin = Float64Array.from([0, 10]);
    const { kind, rateCPerMin } = classifySegment(tempC, timeMin, 0, 2);
    expect(kind).toBe("heat");
    expect(rateCPerMin).toBeCloseTo(10, 2);
  });

  it("classifies a falling temperature as cool, reporting the rate as a positive magnitude", () => {
    const tempC = Float64Array.from([280, 0]);
    const timeMin = Float64Array.from([0, 28]);
    const { kind, rateCPerMin } = classifySegment(tempC, timeMin, 0, 2);
    expect(kind).toBe("cool");
    expect(rateCPerMin).toBeCloseTo(10, 2);
  });

  it("classifies a near-flat span (< 1 °C) as isothermal with a null rate", () => {
    const tempC = Float64Array.from([150.0, 150.4, 150.2, 150.6]);
    const timeMin = Float64Array.from([0, 1, 2, 5]);
    const { kind, rateCPerMin } = classifySegment(tempC, timeMin, 0, 4);
    expect(kind).toBe("isothermal");
    expect(rateCPerMin).toBeNull();
  });

  it("classifies a non-positive duration as unknown with a null rate", () => {
    const tempC = Float64Array.from([20, 20]);
    const timeMin = Float64Array.from([5, 5]); // duration 0
    const { kind, rateCPerMin } = classifySegment(tempC, timeMin, 0, 2);
    expect(kind).toBe("unknown");
    expect(rateCPerMin).toBeNull();
  });

  it("classifies a too-short range (< 2 points) as unknown rather than throwing", () => {
    const tempC = Float64Array.from([20]);
    const timeMin = Float64Array.from([0]);
    const { kind, rateCPerMin } = classifySegment(tempC, timeMin, 0, 1);
    expect(kind).toBe("unknown");
    expect(rateCPerMin).toBeNull();
  });

  it("rounds the rate to 2 decimal places", () => {
    // 100 °C over 33 min = 3.0303... °C/min → 3.03.
    const tempC = Float64Array.from([0, 100]);
    const timeMin = Float64Array.from([0, 33]);
    const { rateCPerMin } = classifySegment(tempC, timeMin, 0, 2);
    expect(rateCPerMin).toBe(3.03);
  });
});

// --- numberSegments ------------------------------------------------------

function seg(kind: DscSegment["kind"], id: string): DscSegment {
  return {
    id,
    label: id,
    kind,
    rateCPerMin: kind === "isothermal" ? null : 10,
    ordinal: 0,
    cycle: 0,
    start: 0,
    end: 1,
    tStartC: 0,
    tEndC: 0,
    timeStartMin: 0,
    timeEndMin: 0,
  };
}

describe("numberSegments", () => {
  it("numbers heat/cool/heat/cool as cycles 1,1,2,2 and ordinals 1,1,2,2", () => {
    const numbered = numberSegments([
      seg("heat", "a"),
      seg("cool", "b"),
      seg("heat", "c"),
      seg("cool", "d"),
    ]);
    expect(numbered.map((s) => s.kind)).toEqual(["heat", "cool", "heat", "cool"]);
    expect(numbered.map((s) => s.ordinal)).toEqual([1, 1, 2, 2]);
    expect(numbered.map((s) => s.cycle)).toEqual([1, 1, 2, 2]);
  });

  it("does not advance the cycle for an isothermal hold between ramps", () => {
    const numbered = numberSegments([
      seg("heat", "a"),
      seg("isothermal", "hold"),
      seg("cool", "b"),
      seg("heat", "c"),
    ]);
    expect(numbered.map((s) => s.cycle)).toEqual([1, 1, 1, 2]);
    expect(numbered.map((s) => s.ordinal)).toEqual([1, 1, 1, 2]);
  });

  it("numbers isothermal segments independently of heat/cool ordinals", () => {
    const numbered = numberSegments([seg("isothermal", "a"), seg("heat", "b"), seg("isothermal", "c")]);
    expect(numbered.map((s) => s.ordinal)).toEqual([1, 1, 2]);
  });

  it("handles a single heat-only run without a following cool", () => {
    const numbered = numberSegments([seg("heat", "a")]);
    expect(numbered[0].ordinal).toBe(1);
    expect(numbered[0].cycle).toBe(1);
  });
});

// --- defaultSegmentId ------------------------------------------------------

describe("defaultSegmentId", () => {
  it("picks the 2nd heat when present", () => {
    const segments = numberSegments([
      seg("heat", "heat1"),
      seg("cool", "cool1"),
      seg("heat", "heat2"),
      seg("cool", "cool2"),
    ]);
    expect(defaultSegmentId(segments)).toBe("heat2");
  });

  it("falls back to the 1st heat when there is no 2nd heat", () => {
    const segments = numberSegments([seg("heat", "heat1"), seg("cool", "cool1")]);
    expect(defaultSegmentId(segments)).toBe("heat1");
  });

  it("falls back to the first non-isothermal segment when there is no heat", () => {
    const segments = numberSegments([seg("isothermal", "hold"), seg("cool", "cool1")]);
    expect(defaultSegmentId(segments)).toBe("cool1");
  });

  it("falls back to segment 0 when every segment is isothermal", () => {
    const segments = numberSegments([seg("isothermal", "a"), seg("isothermal", "b")]);
    expect(defaultSegmentId(segments)).toBe("a");
  });

  it("returns null for an empty list", () => {
    expect(defaultSegmentId([])).toBeNull();
  });
});

// --- buildSegments ---------------------------------------------------------

describe("buildSegments", () => {
  it("builds ids, boundary temperatures/times, and numbering from raw blocks", () => {
    // heat 0→100 over 10 min, then cool 100→0 over 10 min.
    const tempC = Float64Array.from([0, 50, 100, 90, 50, 0]);
    const timeMin = Float64Array.from([0, 5, 10, 15, 20, 25]);
    const segments = buildSegments("run1", tempC, timeMin, [
      { start: 0, end: 3, label: "Ramp up" },
      { start: 3, end: 6, label: "Ramp down" },
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0].id).toBe("run1:seg0");
    expect(segments[1].id).toBe("run1:seg1");
    expect(segments[0].kind).toBe("heat");
    expect(segments[1].kind).toBe("cool");
    expect(segments[0].tStartC).toBeCloseTo(0, 6);
    expect(segments[0].tEndC).toBeCloseTo(100, 6);
    expect(segments[1].tStartC).toBeCloseTo(90, 6);
    expect(segments[1].tEndC).toBeCloseTo(0, 6);
    expect(segments[0].timeStartMin).toBeCloseTo(0, 6);
    expect(segments[0].timeEndMin).toBeCloseTo(10, 6);
    expect(segments[0].cycle).toBe(1);
    expect(segments[1].cycle).toBe(1);
  });
});
