import { describe, expect, it } from "vitest";
import { analyze, fitOrders, measurePeak } from "../kinetics";

describe("measurePeak", () => {
  const wn = [0, 1, 2, 3, 4];

  it("returns NaN for an empty window", () => {
    expect(measurePeak(wn, [0, 1, 2, 1, 0], 100, 1, "height", "none")).toBeNaN();
  });

  it("height with no baseline is the window max", () => {
    expect(measurePeak(wn, [0, 1, 2, 1, 0], 2, 2, "height", "none")).toBe(2);
  });

  it("area with no baseline is the trapezoidal integral of the clipped signal", () => {
    // trapz of [0,1,2,1,0] over unit spacing = 0.5 + 1.5 + 1.5 + 0.5 = 4
    expect(measurePeak(wn, [0, 1, 2, 1, 0], 2, 2, "area", "none")).toBeCloseTo(4, 10);
  });

  it("subtracts a linear per-window baseline before measuring", () => {
    // k = max(1, floor(5/10)) = 1 → anchors are the first/last points:
    // line through (0,1)..(4,5) is y = x + 1, so corrected = [0,0,1,-1,0].
    const abs = [1, 2, 4, 3, 5];
    expect(measurePeak(wn, abs, 2, 2, "height", "linear")).toBeCloseTo(1, 10);
    // clip(corrected,0,∞) = [0,0,1,0,0] → trapz = 0.5 + 0.5 = 1
    expect(measurePeak(wn, abs, 2, 2, "area", "linear")).toBeCloseTo(1, 10);
  });

  it("restricts the measurement to the window", () => {
    const abs = [10, 1, 2, 1, 10];
    // center 2, halfwidth 1 → only wn 1,2,3 → max corrected = 2
    expect(measurePeak(wn, abs, 2, 1, "height", "none")).toBe(2);
  });
});

describe("analyze", () => {
  it("recovers a clean first-order decay", () => {
    // S(t) = 2 + 8·exp(-0.5·t)
    const k = 0.5;
    const s0 = 10;
    const sInf = 2;
    const time = [0, 1, 2, 3, 4, 5, 6, 8, 10];
    const signal = time.map((t) => sInf + (s0 - sInf) * Math.exp(-k * t));

    const res = analyze(time, signal);
    expect(res.fitOk).toBe(true);
    expect(res.k).toBeCloseTo(0.5, 3);
    expect(res.sInf).toBeCloseTo(2, 2);
    expect(res.r2).toBeGreaterThan(0.999);
    expect(res.halfLife).toBeCloseTo(Math.LN2 / 0.5, 3);
    expect(res.finalConversion).toBeCloseTo(0.8, 2);
    expect(res.s0).toBe(10);
    expect(res.tFit).toHaveLength(200);
    expect(res.sFit).toHaveLength(200);
  });

  it("computes conversion against the measured s0 and divides by a reference", () => {
    const time = [0, 1, 2];
    const signal = [10, 5, 0];
    const reference = [2, 2, 2];
    const res = analyze(time, signal, reference);
    // divided signal = [5, 2.5, 0]; conversion = (5 - s)/5 = [0, 0.5, 1]
    expect(res.signal).toEqual([5, 2.5, 0]);
    expect(res.conversion).toEqual([0, 0.5, 1]);
    expect(res.s0).toBe(5);
  });

  it("drops non-finite pairs (reference zero) and reports fitOk=false with too few points", () => {
    const time = [0, 1, 2];
    const signal = [10, 5, 2];
    const reference = [1, 0, 1]; // middle pair dropped → 2 points left
    const res = analyze(time, signal, reference);
    expect(res.time).toEqual([0, 2]);
    expect(res.signal).toEqual([10, 2]);
    expect(res.fitOk).toBe(false);
    expect(res.k).toBeNaN();
  });
});

describe("fitOrders", () => {
  it("identifies a first-order decay with R² ≈ 1 on the ln transform", () => {
    // S = 10·exp(-0.3·t) → ln(S) is exactly linear with slope -0.3
    const k = 0.3;
    const time = [0, 1, 2, 3, 4, 5];
    const signal = time.map((t) => 10 * Math.exp(-k * t));

    const orders = fitOrders(time, signal, null, "min", "ratio");
    const first = orders.find((o) => o.order === 1)!;
    expect(first.ok).toBe(true);
    expect(first.k).toBeCloseTo(0.3, 6);
    expect(first.r2).toBeGreaterThan(0.9999);
    expect(first.kUnits).toBe("1/min");
    expect(first.label).toBe("ln(S) vs t");
    expect(first.n).toBe(6);
  });

  it("labels units per order and keeps order 0 valid for all points", () => {
    const time = [0, 1, 2, 3];
    const signal = [8, 6, 4, 2]; // exactly linear → order 0 R² = 1, k = 2
    const orders = fitOrders(time, signal, null, "s", "area");

    const zero = orders.find((o) => o.order === 0)!;
    expect(zero.k).toBeCloseTo(2, 10);
    expect(zero.r2).toBeCloseTo(1, 10);
    expect(zero.kUnits).toBe("area/s");

    const second = orders.find((o) => o.order === 2)!;
    expect(second.kUnits).toBe("1/(area·s)");
  });

  it("drops points whose transform is invalid (ln of non-positive)", () => {
    const time = [0, 1, 2, 3];
    const signal = [5, 3, 0, -1]; // ln valid only for 5 and 3 → 2 points
    const orders = fitOrders(time, signal, null, "min", "ratio");
    const first = orders.find((o) => o.order === 1)!;
    expect(first.n).toBe(2);
    expect(first.ok).toBe(false);
  });
});
