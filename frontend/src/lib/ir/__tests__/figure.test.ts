import { describe, expect, it } from "vitest";
import {
  autoRange,
  decimateMinMax,
  defaultFigureOptions,
  formatTick,
  niceTicks,
  reconcileFigureOptions,
  resolveAxis,
  seriesPathD,
  tickDecimals,
  type FigureData,
} from "../figure";

function makeData(ids: string[]): FigureData {
  return {
    x: [0, 1, 2],
    series: ids.map((id) => ({ id, label: id, y: [0, 1, 2] })),
    xLabel: "x",
    yLabel: "y",
  };
}

describe("niceTicks", () => {
  it("produces 1/2/5 steps spanning the range", () => {
    const t = niceTicks(0, 10, 6);
    expect(t.step).toBe(2);
    expect(t.lo).toBe(0);
    expect(t.hi).toBe(10);
    expect(t.ticks).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("expands to nice bounds containing the data", () => {
    const t = niceTicks(0.13, 9.7, 6);
    expect(t.lo).toBeLessThanOrEqual(0.13);
    expect(t.hi).toBeGreaterThanOrEqual(9.7);
    expect(t.ticks[0]).toBe(t.lo);
    expect(t.ticks[t.ticks.length - 1]).toBe(t.hi);
  });

  it("pads a degenerate (flat) range", () => {
    const t = niceTicks(5, 5);
    expect(t.lo).toBeLessThan(5);
    expect(t.hi).toBeGreaterThan(5);
    expect(t.ticks.length).toBeGreaterThanOrEqual(2);
  });

  it("swaps inverted inputs", () => {
    const t = niceTicks(10, 0, 6);
    expect(t.lo).toBe(0);
    expect(t.hi).toBe(10);
  });

  it("survives non-finite inputs", () => {
    const t = niceTicks(NaN, 10);
    expect(t.ticks.length).toBeGreaterThanOrEqual(2);
  });
});

describe("tickDecimals", () => {
  it("integer steps need no decimals", () => {
    expect(tickDecimals(1)).toBe(0);
    expect(tickDecimals(2)).toBe(0);
    expect(tickDecimals(50)).toBe(0);
  });

  it("fractional steps get just enough decimals", () => {
    expect(tickDecimals(0.5)).toBe(1);
    expect(tickDecimals(0.2)).toBe(1);
    expect(tickDecimals(0.05)).toBe(2);
    expect(tickDecimals(0.001)).toBe(3);
  });

  it("degenerate steps fall back to 0", () => {
    expect(tickDecimals(0)).toBe(0);
    expect(tickDecimals(NaN)).toBe(0);
  });
});

describe("formatTick", () => {
  it("renders fixed decimals", () => {
    expect(formatTick(0.30000000000000004, 1)).toBe("0.3");
  });

  it("normalises negative zero", () => {
    expect(formatTick(-0.0001, 0)).toBe("0");
    expect(formatTick(-0.0001, 2)).toBe("0.00");
  });
});

describe("autoRange", () => {
  it("ignores non-finite values", () => {
    expect(autoRange([NaN, 3, -1, Infinity, 7])).toEqual([-1, 7]);
  });

  it("falls back to [0, 1] with no finite values", () => {
    expect(autoRange([NaN, NaN])).toEqual([0, 1]);
    expect(autoRange([])).toEqual([0, 1]);
  });
});

describe("resolveAxis", () => {
  const axis = defaultFigureOptions(makeData(["a"])).x;

  it("auto mode nices the data range", () => {
    const r = resolveAxis(axis, [0.2, 9.8]);
    expect(r.lo).toBeLessThanOrEqual(0.2);
    expect(r.hi).toBeGreaterThanOrEqual(9.8);
    expect(r.manualInvalid).toBe(false);
  });

  it("manual bounds are honoured exactly, ticks clipped inside", () => {
    const r = resolveAxis({ ...axis, min: 2, max: 8 }, [0, 100]);
    expect(r.lo).toBe(2);
    expect(r.hi).toBe(8);
    for (const t of r.ticks) {
      expect(t).toBeGreaterThanOrEqual(2);
      expect(t).toBeLessThanOrEqual(8);
    }
  });

  it("degenerate manual bounds fall back to auto and flag it", () => {
    const r = resolveAxis({ ...axis, min: 5, max: 5 }, [0, 10]);
    expect(r.manualInvalid).toBe(true);
    expect(r.lo).toBeLessThan(r.hi);
  });

  it("uses the manual decimals override", () => {
    const r = resolveAxis({ ...axis, decimals: 3 }, [0, 10]);
    expect(r.decimals).toBe(3);
  });
});

describe("decimateMinMax", () => {
  it("returns short inputs unchanged", () => {
    const x = [0, 1, 2];
    const y = [5, 6, 7];
    expect(decimateMinMax(x, y, 100)).toEqual({ x, y });
  });

  it("keeps each bucket's extremes (peaks survive)", () => {
    const n = 10000;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = x.map((v) => Math.sin(v / 50));
    y[4321] = 99; // a sharp spike that naive striding would miss
    const dec = decimateMinMax(x, y, 100);
    expect(dec.x.length).toBeLessThanOrEqual(300);
    expect(Math.max(...dec.y)).toBe(99);
    expect(Math.min(...dec.y)).toBeCloseTo(Math.min(...y), 6);
  });

  it("preserves gaps with NaN sentinels", () => {
    const n = 5000;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = x.map((v) => (v > 2000 && v < 2500 ? NaN : v));
    const dec = decimateMinMax(x, y, 100);
    expect(dec.y.some((v) => Number.isNaN(v))).toBe(true);
  });

  it("emits ascending x within buckets", () => {
    const n = 5000;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = x.map((v) => Math.cos(v / 10));
    const dec = decimateMinMax(x, y, 100);
    for (let i = 1; i < dec.x.length; i += 1) {
      expect(dec.x[i]).toBeGreaterThanOrEqual(dec.x[i - 1]);
    }
  });
});

describe("seriesPathD", () => {
  const id = (v: number) => v;

  it("draws move-then-line segments", () => {
    expect(seriesPathD([0, 1, 2], [0, 1, 2], id, id)).toBe("M0 0L1 1L2 2");
  });

  it("lifts the pen across NaN gaps", () => {
    const d = seriesPathD([0, 1, 2, 3], [0, NaN, 2, 3], id, id);
    expect(d).toBe("M0 0M2 2L3 3");
  });

  it("returns an empty path with no finite points", () => {
    expect(seriesPathD([0, 1], [NaN, NaN], id, id)).toBe("");
  });
});

describe("default & reconcile options", () => {
  it("seeds one style per series with palette colours and hints applied", () => {
    const data = makeData(["a", "b"]);
    data.series[1].styleHints = { lineStyle: "none", markers: true, color: "#000000" };
    const opts = defaultFigureOptions(data);
    expect(opts.series).toHaveLength(2);
    expect(opts.series[0].color).toBe("#2563eb");
    expect(opts.series[1].lineStyle).toBe("none");
    expect(opts.series[1].markers).toBe(true);
    expect(opts.series[1].color).toBe("#000000");
    expect(opts.reversedX).toBe(false);
  });

  it("legend defaults off for a single series and above 12 series", () => {
    expect(defaultFigureOptions(makeData(["a"])).legend.show).toBe(false);
    const many = makeData(Array.from({ length: 13 }, (_, i) => `s${i}`));
    expect(defaultFigureOptions(many).legend.show).toBe(false);
    expect(defaultFigureOptions(makeData(["a", "b"])).legend.show).toBe(true);
  });

  it("reconcile keeps edits, seeds new series, drops removed ones", () => {
    const prev = defaultFigureOptions(makeData(["a", "b"]));
    prev.series[0] = { ...prev.series[0], color: "#123456", lineWidth: 3 };
    const next = reconcileFigureOptions(prev, makeData(["a", "c"]));
    expect(next.series.map((s) => s.id)).toEqual(["a", "c"]);
    expect(next.series[0].color).toBe("#123456");
    expect(next.series[0].lineWidth).toBe(3);
    expect(next.series[1].color).toBe("#dc2626"); // palette default for index 1
  });

  it("reconcile leaves non-series options untouched", () => {
    const prev = { ...defaultFigureOptions(makeData(["a"])), title: "My figure" };
    const next = reconcileFigureOptions(prev, makeData(["a", "b"]));
    expect(next.title).toBe("My figure");
  });
});
