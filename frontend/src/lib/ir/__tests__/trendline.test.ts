import { describe, expect, it } from "vitest";
import { defaultTrendlineConfig, fitTrendline, type TrendlineConfig } from "../trendline";

const cfg = (over: Partial<TrendlineConfig>): TrendlineConfig => ({
  ...defaultTrendlineConfig(),
  enabled: true,
  ...over,
});

describe("fitTrendline", () => {
  it("fits a straight line through perfect data (R² = 1)", () => {
    // y = 2x + 1
    const fit = fitTrendline([0, 1, 2, 3], [1, 3, 5, 7], cfg({ type: "linear" }));
    expect(fit.ok).toBe(true);
    expect(fit.r2).toBeCloseTo(1, 10);
    expect(fit.predict(10)).toBeCloseTo(21, 6);
    expect(fit.equation).toBe("y = 2x + 1");
  });

  it("forces the line through the origin", () => {
    // y = 2x (no intercept)
    const fit = fitTrendline([1, 2, 3], [2.1, 3.9, 6.05], cfg({ type: "linear", throughOrigin: true }));
    expect(fit.ok).toBe(true);
    expect(fit.predict(0)).toBe(0);
    expect(fit.equation).not.toContain("+");
    expect(fit.equation.startsWith("y = ")).toBe(true);
  });

  it("fits a quadratic with a polynomial of degree 2", () => {
    // y = x^2
    const fit = fitTrendline([-2, -1, 0, 1, 2], [4, 1, 0, 1, 4], cfg({ type: "polynomial", degree: 2 }));
    expect(fit.ok).toBe(true);
    expect(fit.r2).toBeCloseTo(1, 8);
    expect(fit.predict(3)).toBeCloseTo(9, 6);
    expect(fit.equation).toContain("x^2");
  });

  it("fits an exponential y = a·e^(b·x)", () => {
    const e = Math.E;
    const fit = fitTrendline([0, 1, 2, 3], [2, 2 * e, 2 * e ** 2, 2 * e ** 3], cfg({ type: "exponential" }));
    expect(fit.ok).toBe(true);
    expect(fit.r2).toBeCloseTo(1, 6);
    expect(fit.predict(0)).toBeCloseTo(2, 4);
    expect(fit.predict(2)).toBeCloseTo(2 * e ** 2, 2);
  });

  it("fits a logarithmic y = a·ln(x) + b", () => {
    const y = [1, 2, 3, 4].map((x) => 3 * Math.log(x) + 1);
    const fit = fitTrendline([1, 2, 3, 4], y, cfg({ type: "logarithmic" }));
    expect(fit.ok).toBe(true);
    expect(fit.r2).toBeCloseTo(1, 6);
    expect(fit.predict(2)).toBeCloseTo(3 * Math.log(2) + 1, 4);
  });

  it("fits a power law y = a·x^b", () => {
    const fit = fitTrendline([1, 2, 3, 4], [2, 16, 54, 128], cfg({ type: "power" }));
    expect(fit.ok).toBe(true);
    expect(fit.r2).toBeCloseTo(1, 6);
    expect(fit.predict(2)).toBeCloseTo(16, 3);
  });

  it("restricts the fit to the configured x-range", () => {
    // First four points are y = 2x + 1; the last is a wild outlier excluded by range.
    const fit = fitTrendline(
      [0, 1, 2, 3, 100],
      [1, 3, 5, 7, 9999],
      cfg({ type: "linear", rangeMax: 10 }),
    );
    expect(fit.ok).toBe(true);
    expect(fit.n).toBe(4);
    expect(fit.r2).toBeCloseTo(1, 10);
    expect(fit.predict(4)).toBeCloseTo(9, 6);
  });

  it("ignores non-finite pairs", () => {
    const fit = fitTrendline([0, 1, NaN, 2, 3], [1, 3, 5, 5, 7], cfg({ type: "linear" }));
    expect(fit.ok).toBe(true);
    expect(fit.n).toBe(4);
    expect(fit.equation).toBe("y = 2x + 1");
  });

  it("fails gracefully with too few points for the model", () => {
    const fit = fitTrendline([0, 1, 2], [1, 2, 3], cfg({ type: "polynomial", degree: 4 }));
    expect(fit.ok).toBe(false);
    expect(Number.isNaN(fit.predict(1))).toBe(true);
    expect(fit.error).toBeTruthy();
  });

  it("fails when the range leaves fewer than two points", () => {
    const fit = fitTrendline([0, 1, 2], [1, 2, 3], cfg({ type: "linear", rangeMin: 5 }));
    expect(fit.ok).toBe(false);
    expect(fit.error).toBeTruthy();
  });
});
