import { describe, expect, it } from "vitest";
import {
  buildSeries,
  extractAnalysisColumns,
  extractKineticSpectra,
  fitModel,
  formatHalfLife,
  formatRate,
  integralForPeak,
  integrateWindow,
  linearizeSeries,
  predictFromFit,
  toSeconds,
  type KineticSpectrum,
  type SeriesPoint,
  type TrackedPeak,
} from "./kinetics";

const peak = (over: Partial<TrackedPeak> = {}): TrackedPeak => ({
  id: "p1",
  label: "Product",
  from: 2.0,
  to: 2.2,
  color: "#0ea5e9",
  ...over,
});

describe("toSeconds", () => {
  it("converts each supported unit to seconds", () => {
    expect(toSeconds(30, "s")).toBe(30);
    expect(toSeconds(2, "min")).toBe(120);
    expect(toSeconds(1.5, "h")).toBe(5400);
  });
});

describe("extractKineticSpectra", () => {
  it("maps 1D spectra integrals and ranges into the slim shape", () => {
    const spectra = extractKineticSpectra({
      data: {
        spectra: [
          {
            id: "a",
            info: { name: "t0", nucleus: "1H", dimension: 1 },
            display: { name: "Sample 0" },
            integrals: { values: [{ id: "i1", from: 2.2, to: 2.0, integral: 1.5, absolute: 1500 }] },
            ranges: { values: [{ id: "r1", from: 7.3, to: 7.1, integration: 3, absolute: 3000 }] },
          },
        ],
      },
    });

    expect(spectra).toHaveLength(1);
    expect(spectra[0].name).toBe("Sample 0");
    expect(spectra[0].nucleus).toBe("1H");
    expect(spectra[0].integrals[0]).toMatchObject({ id: "i1", integral: 1.5 });
    expect(spectra[0].ranges[0]).toMatchObject({ id: "r1", integral: 3 });
  });

  it("drops 2D spectra and tolerates missing collections", () => {
    const spectra = extractKineticSpectra({
      data: {
        spectra: [
          { id: "2d", info: { name: "cosy", dimension: 2 } },
          { id: "bare", info: { name: "t1", nucleus: "1H", dimension: 1 } },
        ],
      },
    });

    expect(spectra.map((s) => s.id)).toEqual(["bare"]);
    expect(spectra[0].integrals).toEqual([]);
    expect(spectra[0].ranges).toEqual([]);
  });

  it("returns an empty array for empty/undefined state", () => {
    expect(extractKineticSpectra(undefined)).toEqual([]);
    expect(extractKineticSpectra({})).toEqual([]);
    expect(extractKineticSpectra({ data: { spectra: [] } })).toEqual([]);
  });

  it("captures raw data when present", () => {
    const spectra = extractKineticSpectra({
      data: {
        spectra: [
          {
            id: "a",
            info: { nucleus: "1H", dimension: 1 },
            data: { x: [1, 2, 3], re: [10, 20, 30] },
          },
        ],
      },
    });
    expect(spectra[0].data).toEqual({ x: [1, 2, 3], re: [10, 20, 30] });
  });

  it("sorts spectra by natural numeric name order", () => {
    const spectra = extractKineticSpectra({
      data: {
        spectra: [
          { id: "s10", info: { name: "Kinetics 10", dimension: 1 } },
          { id: "s2", info: { name: "Kinetics 2", dimension: 1 } },
          { id: "s1", info: { name: "Kinetics 1", dimension: 1 } },
        ],
      },
    });
    expect(spectra.map((s) => s.id)).toEqual(["s1", "s2", "s10"]);
  });
});

describe("extractAnalysisColumns", () => {
  it("reads the multiple-spectra-analysis column windows from settings", () => {
    const columns = extractAnalysisColumns({
      settings: {
        panels: {
          multipleSpectraAnalysis: {
            "1H": {
              analysisOptions: {
                columns: {
                  A: { label: "Alkene", from: 5.27, to: 5.79 },
                  B: { from: 6.1, to: 5.97 },
                },
              },
            },
          },
        },
      },
    });

    expect(columns).toEqual([
      { label: "Alkene", from: 5.79, to: 5.27 },
      { label: "B", from: 6.1, to: 5.97 },
    ]);
  });

  it("returns an empty array when there is no analysis", () => {
    expect(extractAnalysisColumns(undefined)).toEqual([]);
    expect(extractAnalysisColumns({ settings: {} })).toEqual([]);
  });
});

describe("integrateWindow", () => {
  it("integrates a descending-ppm window (trapezoidal area)", () => {
    // x descends 3→0, constant y = 10. Area over [1,3] = width 2 * 10 = 20.
    const data = { x: [3, 2, 1, 0], re: [10, 10, 10, 10] };
    expect(integrateWindow(data, 1, 3)).toBeCloseTo(20, 6);
  });

  it("integrates the same area regardless of from/to order", () => {
    const data = { x: [0, 1, 2, 3], re: [10, 10, 10, 10] };
    expect(integrateWindow(data, 3, 1)).toBeCloseTo(20, 6);
  });

  it("returns null when no points fall in the window", () => {
    expect(integrateWindow({ x: [0, 1, 2], re: [1, 1, 1] }, 5, 6)).toBeNull();
  });
});

describe("integralForPeak", () => {
  const spectrum: KineticSpectrum = {
    id: "a",
    name: "a",
    nucleus: "1H",
    integrals: [
      { id: "i1", from: 2.2, to: 2.0, integral: 5, absolute: 5 },
      { id: "i2", from: 1.3, to: 1.1, integral: 9, absolute: 9 },
    ],
    ranges: [],
  };

  it("returns the value of the best-overlapping integral", () => {
    expect(integralForPeak(spectrum, peak({ from: 2.15, to: 2.05 }))).toBe(5);
  });

  it("returns null when nothing overlaps the tracked window", () => {
    expect(integralForPeak(spectrum, peak({ from: 8.0, to: 7.8 }))).toBeNull();
  });

  it("integrates raw data directly when available (ignores stored integrals)", () => {
    const withData: KineticSpectrum = {
      id: "a",
      name: "a",
      nucleus: "1H",
      integrals: [{ id: "i1", from: 2.2, to: 2.0, integral: 999, absolute: 999 }],
      ranges: [],
      data: { x: [2.2, 2.1, 2.0], re: [4, 4, 4] },
    };
    // Direct trapezoidal area over [2.0, 2.2] = width 0.2 * 4 = 0.8, not the stored 999.
    expect(integralForPeak(withData, peak({ from: 2.2, to: 2.0 }))).toBeCloseTo(0.8, 6);
  });
});

describe("buildSeries", () => {
  const spectra: KineticSpectrum[] = [
    {
      id: "s0",
      name: "0 min",
      nucleus: "1H",
      integrals: [
        { id: "prod0", from: 2.2, to: 2.0, integral: 1, absolute: 1 },
        { id: "std0", from: 0.1, to: -0.1, integral: 2, absolute: 2 },
      ],
      ranges: [],
    },
    {
      id: "s1",
      name: "10 min",
      nucleus: "1H",
      integrals: [
        { id: "prod1", from: 2.2, to: 2.0, integral: 3, absolute: 3 },
        { id: "std1", from: 0.1, to: -0.1, integral: 2, absolute: 2 },
      ],
      ranges: [],
    },
  ];
  const timepoints = {
    s0: { value: 0, unit: "min" as const },
    s1: { value: 10, unit: "min" as const },
  };

  it("builds a sorted series of raw integrals", () => {
    const series = buildSeries(spectra, timepoints, peak());
    expect(series.map((p) => [p.timeSeconds, p.value])).toEqual([
      [0, 1],
      [600, 3],
    ]);
  });

  it("normalizes by the internal standard when supplied", () => {
    const standard = peak({ id: "std", label: "TMS", from: 0.1, to: -0.1 });
    const series = buildSeries(spectra, timepoints, peak(), standard);
    expect(series.map((p) => p.value)).toEqual([0.5, 1.5]);
  });

  it("skips spectra without an assigned timepoint", () => {
    const series = buildSeries(spectra, { s1: { value: 10, unit: "min" } }, peak());
    expect(series.map((p) => p.spectrumId)).toEqual(["s1"]);
  });
});

// Synthetic series generators for fit recovery tests.
function series(values: Array<[number, number]>): SeriesPoint[] {
  return values.map(([timeSeconds, value], index) => ({
    timeSeconds,
    value,
    spectrumId: `s${index}`,
    spectrumName: `s${index}`,
  }));
}

describe("fitModel", () => {
  it("recovers k and half-life for first-order decay A = A0·e^(-kt)", () => {
    const A0 = 100;
    const k = 0.01; // per second
    const pts = series([0, 60, 120, 240, 480].map((t) => [t, A0 * Math.exp(-k * t)]));
    const fit = fitModel(pts, "first");

    expect(fit.k).toBeCloseTo(k, 6);
    expect(fit.rSquared).toBeGreaterThan(0.999);
    expect(fit.halfLife).toBeCloseTo(Math.LN2 / k, 4);
  });

  it("recovers -slope for zero-order decay", () => {
    const k = 0.5;
    const pts = series([0, 2, 4, 6].map((t) => [t, 100 - k * t]));
    const fit = fitModel(pts, "zero");
    expect(fit.k).toBeCloseTo(k, 6);
    expect(fit.rSquared).toBeGreaterThan(0.999);
  });

  it("recovers k for second-order decay 1/A = 1/A0 + kt", () => {
    const k = 0.002;
    const invA0 = 1 / 50;
    const pts = series([0, 50, 100, 200].map((t) => [t, 1 / (invA0 + k * t)]));
    const fit = fitModel(pts, "second");
    expect(fit.k).toBeCloseTo(k, 6);
    expect(fit.rSquared).toBeGreaterThan(0.999);
  });

  it("returns NaN fit for fewer than two points", () => {
    const fit = fitModel(series([[0, 1]]), "first");
    expect(Number.isNaN(fit.k)).toBe(true);
    expect(fit.pointCount).toBe(0);
  });
});

describe("predictFromFit", () => {
  it("reproduces the first-order curve it was fit from", () => {
    const A0 = 80;
    const k = 0.005;
    const pts = series([0, 100, 200, 400].map((t) => [t, A0 * Math.exp(-k * t)]));
    const fit = fitModel(pts, "first");
    expect(predictFromFit(fit, 0)).toBeCloseTo(A0, 2);
    expect(predictFromFit(fit, 200)).toBeCloseTo(A0 * Math.exp(-k * 200), 2);
  });
});

describe("end-to-end: 4 spectra at 0/20/40/60 min", () => {
  // Mirror the requested manual test (spectra 1, 6, 9, 15). Each spectrum carries
  // raw points where a tracked peak [2.0, 2.2] decays first-order with k and a
  // flat internal-standard peak [0.0, 0.2] stays constant. Build a flat-topped
  // box of the given area so integrateWindow over the 0.2-ppm window returns it.
  const k = 0.02; // per minute
  const A0 = 100;
  const stdArea = 50;

  function box(peakArea: number) {
    // x descends across two windows; width 0.2 each → height = area / 0.2.
    const x = [2.2, 2.1, 2.0, 0.2, 0.1, 0.0];
    const h = peakArea / 0.2;
    const s = stdArea / 0.2;
    const re = [h, h, h, s, s, s];
    return { x, re };
  }

  const minutes = [0, 20, 40, 60];
  const state = {
    data: {
      spectra: minutes.map((t, i) => ({
        id: `spec-${i}`,
        info: { name: `Kinetics ${i + 1}`, nucleus: "1H", dimension: 1 },
        data: box(A0 * Math.exp(-k * t)),
      })),
    },
  };

  it("recovers the first-order rate from raw-data integration", () => {
    const spectra = extractKineticSpectra(state);
    const timepoints = Object.fromEntries(
      spectra.map((s, i) => [s.id, { value: minutes[i], unit: "min" as const }]),
    );
    const product = peak({ id: "prod", from: 2.2, to: 2.0 });
    const series = buildSeries(spectra, timepoints, product);

    expect(series).toHaveLength(4);
    const fit = fitModel(series, "first");
    // k is fit in per-second; 0.02/min = 0.02/60 per second.
    expect(fit.k).toBeCloseTo(k / 60, 6);
    expect(fit.rSquared).toBeGreaterThan(0.999);
  });

  it("internal-standard normalization leaves the decay shape but rescales it", () => {
    const spectra = extractKineticSpectra(state);
    const timepoints = Object.fromEntries(
      spectra.map((s, i) => [s.id, { value: minutes[i], unit: "min" as const }]),
    );
    const product = peak({ id: "prod", from: 2.2, to: 2.0 });
    const standard = peak({ id: "std", label: "TMS", from: 0.2, to: 0.0 });
    const series = buildSeries(spectra, timepoints, product, standard);
    // First normalized value = A0 / stdArea.
    expect(series[0].value).toBeCloseTo(A0 / stdArea, 6);
    const fit = fitModel(series, "first");
    expect(fit.k).toBeCloseTo(k / 60, 6);
  });
});

describe("linearizeSeries", () => {
  it("transforms by order and reports a high R² for the matching order", () => {
    // First-order decay: ln[A] is linear in t, so the 'first' transform fits best.
    const A0 = 50;
    const k = 0.02;
    const data = series([0, 30, 60, 120, 240].map((t) => [t, A0 * Math.exp(-k * t)]));

    const first = linearizeSeries(data, "first");
    expect(first.yLabel).toBe("ln[A]");
    expect(first.points).toHaveLength(5);
    expect(first.line?.rSquared).toBeGreaterThan(0.999);
    // Slope of ln[A] vs t is -k.
    expect(first.line?.slope).toBeCloseTo(-k, 6);

    // Zero-order transform of the same exponential data is noticeably less linear.
    const zero = linearizeSeries(data, "zero");
    expect(zero.yLabel).toBe("[A]");
    expect(zero.line!.rSquared).toBeLessThan(first.line!.rSquared);
  });

  it("uses the right transform and label for each order", () => {
    const data = series([
      [0, 10],
      [10, 5],
    ]);
    expect(linearizeSeries(data, "zero").points.map((p) => p.y)).toEqual([10, 5]);
    expect(linearizeSeries(data, "second").points.map((p) => p.y)).toEqual([0.1, 0.2]);
    expect(linearizeSeries(data, "second").yLabel).toBe("1/[A]");
  });

  it("drops invalid transform inputs and returns no line when fewer than two remain", () => {
    const data = series([
      [0, -1],
      [10, 0],
      [20, 4],
    ]);
    // ln of negatives/zero is dropped; only one valid point → no regression line.
    const first = linearizeSeries(data, "first");
    expect(first.points).toHaveLength(1);
    expect(first.line).toBeNull();
  });
});

describe("formatting", () => {
  it("scales the rate to the display unit and labels the order", () => {
    expect(formatRate(0.01, "first", "s")).toContain("s⁻¹");
    // 0.01 s⁻¹ = 0.6 min⁻¹
    expect(formatRate(0.01, "first", "min")).toContain("0.6");
    expect(formatRate(0.01, "first", "min")).toContain("min⁻¹");
    expect(formatRate(Number.NaN, "first", "s")).toBe("—");
  });

  it("formats half-life in the display unit", () => {
    expect(formatHalfLife(120, "min")).toContain("2");
    expect(formatHalfLife(undefined, "s")).toBe("—");
  });
});
