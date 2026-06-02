import { describe, expect, it } from "vitest";
import {
  cleanCurve,
  DEFAULT_PARAMS,
  extractRun,
  interp,
  linfit,
  offsetYield,
  PROPERTY_META,
  searchSortedLeft,
  summarize,
  trapezoid,
} from "../compute";
import type { RunProps } from "../types";

/**
 * A realistic-ish stress–strain curve: rises, peaks at 2% strain (UTS = 60 MPa),
 * then decays — concave enough that the offset-yield line crosses and toughness
 * is positive. Returned in either percent or mm/mm so we can exercise the unit
 * conversion in `_clean`.
 */
function syntheticRun(strainIsPercent: boolean): { strain: number[]; stress: number[] } {
  const strain: number[] = [];
  const stress: number[] = [];
  const N = 200;
  for (let i = 0; i <= N; i += 1) {
    const ePct = (i / N) * 8; // 0 → 8 %
    const stressVal = 60 * (ePct / 2) * Math.exp(1 - ePct / 2); // peak 60 MPa at 2 %
    strain.push(strainIsPercent ? ePct : ePct / 100);
    stress.push(stressVal);
  }
  return { strain, stress };
}

const NUMERIC_KEYS = PROPERTY_META.map((p) => p.key);

describe("numeric helpers", () => {
  it("linfit recovers a known line", () => {
    const { slope, intercept, r2 } = linfit([0, 1, 2, 3], [1, 3, 5, 7]); // y = 2x + 1
    expect(slope).toBeCloseTo(2, 9);
    expect(intercept).toBeCloseTo(1, 9);
    expect(r2).toBeCloseTo(1, 9);
  });

  it("interp clamps at the ends and interpolates within", () => {
    const xs = [0, 1, 2];
    const ys = [0, 10, 20];
    expect(interp(-1, xs, ys)).toBe(0); // clamp low
    expect(interp(3, xs, ys)).toBe(20); // clamp high
    expect(interp(0.5, xs, ys)).toBeCloseTo(5, 9);
  });

  it("searchSortedLeft matches np.searchsorted(side='left')", () => {
    const xs = [1, 2, 2, 3];
    expect(searchSortedLeft(xs, 0)).toBe(0);
    expect(searchSortedLeft(xs, 2)).toBe(1); // leftmost
    expect(searchSortedLeft(xs, 2.5)).toBe(3);
    expect(searchSortedLeft(xs, 4)).toBe(4);
  });

  it("trapezoid integrates a unit ramp", () => {
    // ∫₀¹ x dx = 0.5
    expect(trapezoid([0, 1], [0, 1])).toBeCloseTo(0.5, 9);
  });
});

describe("cleanCurve", () => {
  it("drops non-finite, sorts by strain, and removes non-increasing points", () => {
    const { s, st } = cleanCurve([2, 0, 1, 1, NaN], [20, 0, 10, 99, 5], true);
    expect(s).toEqual([0, 1, 2]); // sorted, duplicate strain dropped, NaN gone
    expect(st).toEqual([0, 10, 20]); // the *first* of the duplicate strains is kept
  });

  it("converts a mm/mm fraction to percent", () => {
    const { s } = cleanCurve([0, 0.01, 0.02], [0, 5, 10], false);
    expect(s).toEqual([0, 1, 2]);
  });
});

describe("extractRun", () => {
  it("computes a finite value for every property on a realistic curve", () => {
    const { strain, stress } = syntheticRun(true);
    const props = extractRun(strain, stress);
    for (const key of NUMERIC_KEYS) {
      expect(Number.isFinite(props[key] as number), `${key} should be finite`).toBe(true);
    }
    expect(props.uts_MPa).toBeCloseTo(60, 5);
    expect(props.strain_at_uts).toBeCloseTo(2, 1);
    expect(props.E_MPa).toBeGreaterThan(0);
    expect(props.toughness).toBeGreaterThan(0);
    expect(props.E_method).toContain("regr"); // ≥3 points in the 0.05–0.25% window
  });

  it("treats percent and mm/mm input identically once cleaned", () => {
    const pct = extractRun(...Object.values(syntheticRun(true)) as [number[], number[]], true);
    const frac = extractRun(...Object.values(syntheticRun(false)) as [number[], number[]], false);
    for (const key of NUMERIC_KEYS) {
      expect(frac[key] as number).toBeCloseTo(pct[key] as number, 6);
    }
  });

  it("is stable run-to-run (pure)", () => {
    const { strain, stress } = syntheticRun(true);
    const a = extractRun(strain, stress);
    const b = extractRun(strain, stress);
    expect(a).toEqual(b);
  });

  it("returns N/A (NaN) for offset yield on a purely linear curve", () => {
    // A straight elastic line never crosses its own +offset line.
    const strain: number[] = [];
    const stress: number[] = [];
    for (let i = 0; i <= 100; i += 1) {
      strain.push(i * 0.05); // 0 → 5 %
      stress.push(i * 0.05 * 100); // slope 100 MPa per %
    }
    const props = extractRun(strain, stress);
    expect(Number.isNaN(props.yield_off_MPa)).toBe(true);
    expect(Number.isNaN(props.yield_off_pct)).toBe(true);
    // ...but the modulus is still recovered.
    expect(props.E_MPa).toBeCloseTo(100 * 100, 0);
  });

  it("returns all-NaN on an empty curve without throwing", () => {
    const props = extractRun([], []);
    for (const key of NUMERIC_KEYS) {
      expect(Number.isNaN(props[key] as number)).toBe(true);
    }
  });

  it("honors the break definition", () => {
    const { strain, stress } = syntheticRun(true);
    const last = extractRun(strain, stress, true, DEFAULT_PARAMS);
    const drop = extractRun(strain, stress, true, {
      ...DEFAULT_PARAMS,
      breakDefinition: { mode: "dropFromPeak", dropFrac: 0.5 }, // break at 50% of UTS
    });
    // Dropping-from-peak breaks earlier (lower strain) than the last point.
    expect(drop.elong_break).toBeLessThan(last.elong_break);
    expect(drop.break_MPa).toBeCloseTo(0.5 * last.uts_MPa, 0);
  });
});

describe("summarize", () => {
  it("computes mean, sample SD (ddof=1), CV, n, min, max", () => {
    const stats = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(stats.n).toBe(8);
    expect(stats.mean).toBeCloseTo(5, 9);
    expect(stats.sd).toBeCloseTo(2.13809, 4); // sample SD
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(9);
    expect(stats.cv).toBeCloseTo((stats.sd / 5) * 100, 6);
  });

  it("drops non-finite values and reports n=0 cleanly", () => {
    expect(summarize([NaN, Infinity]).n).toBe(0);
    expect(Number.isNaN(summarize([]).mean)).toBe(true);
    const single = summarize([42]);
    expect(single.n).toBe(1);
    expect(single.sd).toBe(0); // SD is 0 (not NaN) for a single value
  });
});

// Keep the RunProps key list and PROPERTY_META in lock-step.
describe("PROPERTY_META", () => {
  it("covers exactly the numeric RunProps keys", () => {
    const sample: RunProps = extractRun(...(Object.values(syntheticRun(true)) as [number[], number[]]));
    const numericKeys = Object.keys(sample).filter(
      (k) => typeof (sample as unknown as Record<string, unknown>)[k] === "number",
    );
    expect(new Set(NUMERIC_KEYS)).toEqual(new Set(numericKeys));
  });
});
