import { describe, expect, it } from "vitest";
import {
  autoRange,
  decimateMinMax,
  defaultFigureOptions,
  fitFigureBox,
  formatTick,
  mergeSavedFigureOptions,
  niceTicks,
  peakLabelDecimalsFromData,
  pickVisibleLabels,
  reconcileFigureOptions,
  reconcilePeakLabelOverrides,
  MAX_ABSENT_PEAK_LABEL_OVERRIDES,
  resolveAxis,
  seriesPathD,
  sticksPathD,
  tickDecimals,
  windowSlice,
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

describe("windowSlice", () => {
  const x = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  it("clips to the window with one-point padding on each side", () => {
    // 3..6 are indices 3..6; padded out by one → 2..7.
    expect(windowSlice(x, 3, 6)).toEqual([2, 7]);
  });

  it("returns the whole range when the window covers all the data", () => {
    expect(windowSlice(x, -5, 100)).toEqual([0, 9]);
  });

  it("keeps the bracketing points when the window lands between samples", () => {
    // Nothing sits in (12,18); the slice still spans the 10 and 20 either side.
    expect(windowSlice([0, 10, 20, 30], 12, 18)).toEqual([1, 2]);
  });

  it("yields an empty slice for an empty array", () => {
    expect(windowSlice([], 0, 1)).toEqual([0, -1]);
  });

  it("does not clip a non-ascending series (degrades to the full range)", () => {
    expect(windowSlice([9, 8, 7, 6], 7, 8)).toEqual([0, 3]);
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

describe("sticksPathD", () => {
  const id = (v: number) => v;

  it("draws an isolated vertical stem from the baseline to each point", () => {
    expect(sticksPathD([0, 1], [3, 5], id, id, 0)).toBe("M0 0L0 3M1 0L1 5");
  });

  it("skips non-finite points (no stem)", () => {
    expect(sticksPathD([0, 1, 2], [3, NaN, 4], id, id, 0)).toBe("M0 0L0 3M2 0L2 4");
  });

  it("uses the provided baseline y for every stem", () => {
    expect(sticksPathD([2], [7], id, id, 10)).toBe("M2 10L2 7");
  });
});

describe("pickVisibleLabels", () => {
  it("keeps the most intense when labels crowd within minGap", () => {
    const items = [
      { px: 10, weight: 1 },
      { px: 12, weight: 5 }, // within 20px of both neighbours; tallest wins
      { px: 14, weight: 2 },
    ];
    const kept = pickVisibleLabels(items, 10, 20);
    expect(kept).toEqual([{ px: 12, weight: 5 }]);
  });

  it("keeps well-separated labels and returns them in original order", () => {
    const items = [
      { px: 0, weight: 1 },
      { px: 100, weight: 3 },
      { px: 200, weight: 2 },
    ];
    const kept = pickVisibleLabels(items, 10, 20);
    expect(kept.map((k) => k.px)).toEqual([0, 100, 200]);
  });

  it("caps at maxLabels (the most intense survive)", () => {
    const items = [
      { px: 0, weight: 1 },
      { px: 100, weight: 9 },
      { px: 200, weight: 5 },
    ];
    const kept = pickVisibleLabels(items, 2, 10);
    expect(kept.map((k) => k.weight)).toEqual([9, 5]); // px 0 (weight 1) dropped
  });

  it("returns nothing for a zero cap", () => {
    expect(pickVisibleLabels([{ px: 1, weight: 1 }], 0, 10)).toEqual([]);
  });

  it("ignores spacing when minGap is 0", () => {
    const items = [
      { px: 5, weight: 1 },
      { px: 5, weight: 2 },
    ];
    expect(pickVisibleLabels(items, 10, 0)).toHaveLength(2);
  });

  it("keeps a pinned label past the maxLabels cap", () => {
    const items = [
      { px: 0, weight: 1, pinned: true },
      { px: 100, weight: 9 },
      { px: 200, weight: 5 },
    ];
    // The pinned label is kept unconditionally; the cap (1) then governs only the
    // non-pinned remainder, so the single tallest of those (weight 9) survives too.
    const kept = pickVisibleLabels(items, 1, 10);
    expect(kept.map((k) => k.px)).toEqual([0, 100]);
  });

  it("keeps a pinned label even at a zero cap", () => {
    const items = [
      { px: 5, weight: 1, pinned: true },
      { px: 6, weight: 9 },
    ];
    expect(pickVisibleLabels(items, 0, 0)).toEqual([{ px: 5, weight: 1, pinned: true }]);
  });

  it("a pinned label ignores minGap but still blocks a crowded auto label", () => {
    const items = [
      { px: 10, weight: 1, pinned: true },
      { px: 12, weight: 9 }, // within minGap of the pinned one → auto-dropped
      { px: 200, weight: 2 },
    ];
    const kept = pickVisibleLabels(items, 10, 20);
    // pinned px10 kept; px12 rejected (too close to the pinned); px200 kept.
    expect(kept.map((k) => k.px)).toEqual([10, 200]);
  });

  it("a coloured-but-untouched peak is subject to the maxLabels cap", () => {
    // Colour alone (no override/custom/selection) must not pin a label: a whole
    // coloured repeat series should still thin to the tallest few.
    const items = [
      { px: 0, weight: 1 },
      { px: 100, weight: 9 },
      { px: 200, weight: 5 },
    ];
    const kept = pickVisibleLabels(items, 2, 10);
    expect(kept.map((k) => k.weight)).toEqual([9, 5]);
  });
});

describe("reconcilePeakLabelOverrides", () => {
  const dataWith = (ids: string[]): FigureData => ({
    x: [0],
    series: [],
    xLabel: "m/z",
    yLabel: "I",
    peakLabels: ids.map((id) => ({ id, x: 1, y: 1, text: "1" })),
  });

  it("keeps a placement while its label is away, and hands it back on return", () => {
    // Labels toggled off, a run hidden, an axis mode that withholds a marker:
    // the label returns under the same id, and a hand placement has to survive
    // the round trip or every drag is lost the moment the figure is touched.
    const prev = { a: { dx: 5 }, b: { hidden: true } };
    const away = reconcilePeakLabelOverrides(prev, dataWith(["a"]));
    expect(away).toEqual(prev);
    expect(reconcilePeakLabelOverrides(away, dataWith(["a", "b"]))).toEqual(prev);
  });

  it("returns the same object reference when nothing needs evicting", () => {
    const prev = { a: { dx: 5 } };
    expect(reconcilePeakLabelOverrides(prev, dataWith(["a", "b"]))).toBe(prev);
  });

  it("keeps placements when the data supplies no peak labels at all", () => {
    // The whole label set going away is the "turn labels off" case, not a
    // signal that every peak was re-picked.
    const prev = { a: { dx: 5 } };
    const data: FigureData = { x: [0], series: [], xLabel: "m/z", yLabel: "I" };
    expect(reconcilePeakLabelOverrides(prev, data)).toBe(prev);
  });

  it("evicts the oldest absent overrides once they pass the cap", () => {
    // A host that re-picks peaks mints fresh ids every time, so entries for
    // dead ids would otherwise accumulate for the life of the workspace.
    const n = MAX_ABSENT_PEAK_LABEL_OVERRIDES + 3;
    const prev: Record<string, { dx: number }> = {};
    for (let i = 0; i < n; i += 1) prev[`p${i}`] = { dx: i };
    const next = reconcilePeakLabelOverrides(prev, dataWith([]));
    expect(Object.keys(next)).toHaveLength(MAX_ABSENT_PEAK_LABEL_OVERRIDES);
    // Oldest first: the three earliest placements go, the newest all stay.
    expect(next.p0).toBeUndefined();
    expect(next.p2).toBeUndefined();
    expect(next.p3).toEqual({ dx: 3 });
    expect(next[`p${n - 1}`]).toEqual({ dx: n - 1 });
  });

  it("never evicts an override whose label is on the figure", () => {
    // Four past the cap, two of them still in view: only absent entries count
    // towards the cap, so exactly the two oldest ABSENT ones are evicted.
    const n = MAX_ABSENT_PEAK_LABEL_OVERRIDES + 4;
    const prev: Record<string, { dx: number }> = {};
    for (let i = 0; i < n; i += 1) prev[`p${i}`] = { dx: i };
    // p0 and p1 are the oldest, and would be first out — but they are in view.
    const next = reconcilePeakLabelOverrides(prev, dataWith(["p0", "p1"]));
    expect(next.p0).toEqual({ dx: 0 });
    expect(next.p1).toEqual({ dx: 1 });
    expect(next.p2).toBeUndefined();
    expect(next.p3).toBeUndefined();
    expect(next.p4).toEqual({ dx: 4 });
  });
});

describe("sticks & peak-label defaults", () => {
  it("series default to line; a styleHint can request sticks", () => {
    const data = makeData(["a", "b"]);
    data.series[1].styleHints = { kind: "sticks" };
    const opts = defaultFigureOptions(data);
    expect(opts.series[0].kind).toBe("line");
    expect(opts.series[1].kind).toBe("sticks");
  });

  it("peak labels turn on only when the host supplies them", () => {
    expect(defaultFigureOptions(makeData(["a"])).peakLabels.show).toBe(false);
    const withLabels: FigureData = {
      ...makeData(["a"]),
      peakLabels: [{ id: "p", x: 1, y: 2, text: "1.00" }],
    };
    expect(defaultFigureOptions(withLabels).peakLabels.show).toBe(true);
  });

  it("reconcile preserves the series kind across data updates", () => {
    const data = makeData(["a"]);
    data.series[0].styleHints = { kind: "sticks" };
    const prev = defaultFigureOptions(data);
    const next = reconcileFigureOptions(prev, makeData(["a", "b"]));
    expect(next.series[0].kind).toBe("sticks");
    expect(next.series[1].kind).toBe("line");
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

  it("takes background and axis weight from the host seed, white/regular without one", () => {
    const bare = defaultFigureOptions(makeData(["a"]));
    expect(bare.background).toBe("white");
    expect(bare.axisBold).toBe(false);
    // The MALDI seed's choices: drop the figure onto any page, and stay legible
    // at the size a spectrum is reproduced.
    const seeded = defaultFigureOptions(makeData(["a"]), {
      background: "transparent",
      axisBold: true,
    });
    expect(seeded.background).toBe("transparent");
    expect(seeded.axisBold).toBe(true);
  });

  it("legend defaults off for a single series and above 12 series", () => {
    expect(defaultFigureOptions(makeData(["a"])).legend.show).toBe(false);
    const many = makeData(Array.from({ length: 13 }, (_, i) => `s${i}`));
    expect(defaultFigureOptions(many).legend.show).toBe(false);
    expect(defaultFigureOptions(makeData(["a", "b"])).legend.show).toBe(true);
  });

  it("raises the legend auto-cap when stick series are present (MALDI ladders)", () => {
    const many = makeData(Array.from({ length: 13 }, (_, i) => `s${i}`));
    // As plain line series, 13 > 12 → the legend still defaults off.
    expect(defaultFigureOptions(many).legend.show).toBe(false);
    // One stick series marks a MALDI-style figure; the cap lifts so many assigned
    // ladders no longer silently default the legend off (WP6d).
    many.series[0].styleHints = { kind: "sticks" };
    expect(defaultFigureOptions(many).legend.show).toBe(true);
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

/** `makeData` plus peak labels at the given anchor values. */
function withPeaks(xs: number[], extra: Partial<{ customText: boolean }> = {}): FigureData {
  return {
    ...makeData(["a"]),
    peakLabels: xs.map((x, i) => ({ id: `p${i}`, x, y: 1, text: String(x), ...extra })),
  };
}

describe("fitFigureBox", () => {
  const figure = { width: 800, height: 600 };

  it("fills the width when the area is tall", () => {
    expect(fitFigureBox({ w: 400, h: 900 }, figure)).toEqual({ width: 400, height: 300 });
  });

  it("fills the height when the area is wide", () => {
    expect(fitFigureBox({ w: 2000, h: 300 }, figure)).toEqual({ width: 400, height: 300 });
  });

  it("always keeps the figure's aspect ratio", () => {
    for (const area of [
      { w: 1, h: 10_000 },
      { w: 10_000, h: 1 },
      { w: 733, h: 519 },
    ]) {
      const box = fitFigureBox(area, figure)!;
      expect(box.width / box.height).toBeCloseTo(800 / 600, 10);
      expect(box.width).toBeLessThanOrEqual(area.w + 1e-9);
      expect(box.height).toBeLessThanOrEqual(area.h + 1e-9);
    }
  });

  it("scales up past the figure's nominal size", () => {
    // Fullscreen exists to look closer; the preview is vector, so magnifying it
    // shows the same figure rather than a differently-proportioned one.
    expect(fitFigureBox({ w: 2400, h: 1800 }, figure)).toEqual({ width: 2400, height: 1800 });
  });

  it("returns null until the area has been measured", () => {
    expect(fitFigureBox({ w: 0, h: 0 }, figure)).toBeNull();
    expect(fitFigureBox({ w: 800, h: 0 }, figure)).toBeNull();
    expect(fitFigureBox({ w: 800, h: 600 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe("peakLabelDecimalsFromData", () => {
  it("reports the places the data actually carries", () => {
    expect(peakLabelDecimalsFromData(withPeaks([43, 91, 105]), 4)).toBe(0);
    expect(peakLabelDecimalsFromData(withPeaks([43.05, 91.1]), 4)).toBe(2);
  });

  it("takes the most precise label, not the last one", () => {
    expect(peakLabelDecimalsFromData(withPeaks([100, 337.28, 55.5]), 4)).toBe(2);
  });

  it("caps a computed TOF centroid at the requested maximum", () => {
    // The real shape of a centroid: an intensity-weighted mean, so a double with
    // as many places as it takes to round-trip.
    expect(peakLabelDecimalsFromData(withPeaks([337.2857123456789]), 4)).toBe(4);
    expect(peakLabelDecimalsFromData(withPeaks([337.2857123456789]), 2)).toBe(2);
  });

  it("returns null when there is nothing to measure", () => {
    expect(peakLabelDecimalsFromData(makeData(["a"]), 4)).toBeNull();
    expect(peakLabelDecimalsFromData(withPeaks([]), 4)).toBeNull();
    // Custom text is never reformatted by Decimals, so its anchor says nothing
    // about the precision on show (GC/MS's stacked figure projects an RT onto
    // the m/z axis and keeps the real RT as text).
    expect(peakLabelDecimalsFromData(withPeaks([0.123456789], { customText: true }), 4)).toBeNull();
  });

  it("treats exponent-form anchors as full precision", () => {
    expect(peakLabelDecimalsFromData(withPeaks([1e-7]), 4)).toBe(4);
  });

  it("ignores non-finite anchors", () => {
    expect(peakLabelDecimalsFromData(withPeaks([NaN, 43.5]), 4)).toBe(1);
  });
});

describe("defaultFigureOptions — host seed", () => {
  it("layers a host's own defaults over the shared ones", () => {
    const seed = {
      fontFamily: "Times New Roman",
      width: 800,
      height: 600,
      pngScale: 10,
      showGrid: false,
      peakLabels: { rotation: -45, maxLabels: 40, minGap: 6 },
    };
    const o = defaultFigureOptions(makeData(["a"]), seed);
    expect(o.fontFamily).toBe("Times New Roman");
    expect([o.width, o.height]).toEqual([800, 600]);
    expect(o.pngScale).toBe(10);
    // `showGrid` is one seed key that reaches both axes.
    expect(o.x.showGrid).toBe(false);
    expect(o.y.showGrid).toBe(false);
    expect(o.peakLabels.rotation).toBe(-45);
    expect(o.peakLabels.maxLabels).toBe(40);
    expect(o.peakLabels.minGap).toBe(6);
    // Everything the seed is silent about keeps the shared default.
    expect(o.titleFontSize).toBe(18);
    expect(o.peakLabels.decimals).toBe(2);
    expect(o.x.gridColor).toBe("#e2e8f0");
  });

  it("derives peak-label decimals from the data when the seed asks for it", () => {
    const seed = { autoPeakLabelDecimals: 4 };
    expect(defaultFigureOptions(withPeaks([43, 91]), seed).peakLabels.decimals).toBe(0);
    expect(defaultFigureOptions(withPeaks([337.2857123]), seed).peakLabels.decimals).toBe(4);
  });

  it("keeps the seeded decimals until there are labels to measure", () => {
    // Both mass-spec hosts mount their Figure tab before any file is open, so
    // the auto rule has nothing to read at seed time; `useFigureOptions`
    // re-derives it once the labels arrive.
    const o = defaultFigureOptions(makeData(["a"]), {
      autoPeakLabelDecimals: 4,
      peakLabels: { decimals: 1 },
    });
    expect(o.peakLabels.decimals).toBe(1);
  });

  it("lets the auto cap win over a pinned seed decimals", () => {
    const o = defaultFigureOptions(withPeaks([43.05]), {
      autoPeakLabelDecimals: 4,
      peakLabels: { decimals: 1 },
    });
    expect(o.peakLabels.decimals).toBe(2);
  });

  it("keeps the shared defaults when no seed is given", () => {
    const o = defaultFigureOptions(makeData(["a"]));
    expect(o.fontFamily).toBe("Arial");
    expect([o.width, o.height]).toEqual([900, 560]);
    expect(o.x.showGrid).toBe(true);
    expect(o.stickColor).toBeNull();
    expect(o.legend.marker).toBe("line");
    expect(o.legend.entries).toEqual({});
  });
});

describe("mergeSavedFigureOptions", () => {
  const base = () => defaultFigureOptions(makeData(["a", "b"]));

  it("keeps every saved value", () => {
    const saved = { ...base(), title: "Saved", stickColor: "#111111" };
    saved.legend = { ...saved.legend, marker: "dot" as const, entries: { a: { text: "PEG" } } };
    const merged = mergeSavedFigureOptions(base(), saved);
    expect(merged.title).toBe("Saved");
    expect(merged.stickColor).toBe("#111111");
    expect(merged.legend.marker).toBe("dot");
    expect(merged.legend.entries).toEqual({ a: { text: "PEG" } });
  });

  it("fills fields a record written by an older build never had", () => {
    // A record from before `stickColor` / `legend.marker` / `legend.entries`.
    const saved = base() as unknown as Record<string, unknown>;
    delete saved.stickColor;
    delete (saved.legend as Record<string, unknown>).marker;
    delete (saved.legend as Record<string, unknown>).entries;
    delete (saved.peakLabels as Record<string, unknown>).overrides;
    delete saved.y;
    const merged = mergeSavedFigureOptions(base(), saved);
    expect(merged.stickColor).toBeNull();
    expect(merged.legend.marker).toBe("line");
    expect(merged.legend.entries).toEqual({});
    expect(merged.peakLabels.overrides).toEqual({});
    expect(merged.y.label).toBe("y");
  });

  it("returns the base untouched when there is nothing saved", () => {
    const b = base();
    expect(mergeSavedFigureOptions(b, null)).toBe(b);
  });
});

describe("secondary y2 axis (WP5)", () => {
  function y2Data(): FigureData {
    return {
      x: [0, 1, 2],
      series: [
        { id: "tga", label: "weight %", y: [100, 90, 50], styleHints: { axis: "y" } },
        { id: "dtg", label: "DTG", y: [-0.1, -1, -0.2], styleHints: { axis: "y2", lineStyle: "dashed" } },
      ],
      xLabel: "Temperature (°C)",
      yLabel: "Weight (%)",
      y2Label: "Deriv. weight (%/°C)",
    };
  }

  it("defaultFigureOptions leaves y2 null with no y2Label (every IR/MALDI/GC-MS host)", () => {
    const opts = defaultFigureOptions(makeData(["a"]));
    expect(opts.y2).toBeUndefined();
  });

  it("defaultFigureOptions builds a y2 axis when the data carries a y2Label", () => {
    const opts = defaultFigureOptions(y2Data());
    expect(opts.y2).toBeDefined();
    expect(opts.y2!.label).toBe("Deriv. weight (%/°C)");
    // Grid is off by default for y2 — two gridded axes double-draw the plot.
    expect(opts.y2!.showGrid).toBe(false);
  });

  it("defaultSeriesStyle honours a styleHints.axis of y2", () => {
    const data = y2Data();
    const opts = defaultFigureOptions(data);
    expect(opts.series[0].axis).toBe("y");
    expect(opts.series[1].axis).toBe("y2");
  });

  it("a host seed can override the y2 label and turn its grid on", () => {
    const opts = defaultFigureOptions(y2Data(), {
      y2: { label: "dW/dT", showGrid: true },
    });
    expect(opts.y2!.label).toBe("dW/dT");
    expect(opts.y2!.showGrid).toBe(true);
  });

  it("mergeSavedFigureOptions merges a saved y2 one level deep", () => {
    const base = defaultFigureOptions(y2Data());
    const saved = { y2: { ...base.y2, label: "saved", min: 0 } } as Partial<typeof base>;
    const merged = mergeSavedFigureOptions(base, saved);
    expect(merged.y2!.label).toBe("saved");
    expect(merged.y2!.min).toBe(0);
    // fields saved didn't mention fall back to base
    expect(merged.y2!.showGrid).toBe(base.y2!.showGrid);
  });

  it("mergeSavedFigureOptions restores y2 from base when a record omits it", () => {
    const base = defaultFigureOptions(y2Data());
    const saved = { ...base } as unknown as Record<string, unknown>;
    delete saved.y2;
    const merged = mergeSavedFigureOptions(base, saved as Partial<typeof base>);
    expect(merged.y2).toBeDefined();
    expect(merged.y2!.label).toBe(base.y2!.label);
  });

  it("reconcileFigureOptions preserves a y2 axis across a data update", () => {
    const prev = defaultFigureOptions(y2Data());
    expect(prev.y2).toBeDefined();
    const next = reconcileFigureOptions(prev, y2Data());
    expect(next.y2).toBeDefined();
    expect(next.y2!.label).toBe(prev.y2!.label);
  });
});
