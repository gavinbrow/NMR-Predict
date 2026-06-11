// Customizable "line of best fit" for the kinetics result plots. A real
// least-squares regression — linear, polynomial, exponential, logarithmic, or
// power — fitted to the measured scatter points, with an optional force-through-
// origin constraint and a restricted fit range. Pure math: no DOM, fully
// unit-testable. The host evaluates `predict` across the plot's x to draw the
// curve, and shows `equation` + `r2` as a label.

export type TrendlineType = "linear" | "polynomial" | "exponential" | "logarithmic" | "power";
export type TrendlineStyle = "solid" | "dashed" | "dotted";

export interface TrendlineConfig {
  enabled: boolean;
  type: TrendlineType;
  /** Polynomial degree (2–6); ignored for other types. */
  degree: number;
  /** Constrain the curve through (0, 0). Only linear/polynomial honour this. */
  throughOrigin: boolean;
  /** Restrict the fit to x ≥ rangeMin; null = data minimum. */
  rangeMin: number | null;
  /** Restrict the fit to x ≤ rangeMax; null = data maximum. */
  rangeMax: number | null;
  color: string;
  width: number;
  style: TrendlineStyle;
  /** Show the fitted equation + R² as a label on the plot. */
  showEquation: boolean;
}

export interface TrendlineFit {
  ok: boolean;
  /** Evaluate the fitted model at an x; NaN where the model is undefined. */
  predict: (x: number) => number;
  /** Human-readable equation, e.g. "y = 0.42x + 1.3". */
  equation: string;
  /** Coefficient of determination on the original y-scale, over the fit points. */
  r2: number;
  /** Number of points used in the fit. */
  n: number;
  /** Reason the fit could not be produced (when `ok` is false). */
  error?: string;
}

/** A fresh trendline config (disabled, linear, distinct purple). */
export function defaultTrendlineConfig(color = "#7c3aed"): TrendlineConfig {
  return {
    enabled: false,
    type: "linear",
    degree: 2,
    throughOrigin: false,
    rangeMin: null,
    rangeMax: null,
    color,
    width: 2,
    style: "solid",
    showEquation: true,
  };
}

// --- formatting --------------------------------------------------------------

/** 4-significant-figure number, trailing zeros trimmed ("0" for zero). */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "?";
  if (v === 0) return "0";
  return String(Number(v.toPrecision(4)));
}

// --- linear algebra ----------------------------------------------------------

/** Solve A·c = b for a small dense system via Gauss–Jordan with pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Ordinary least-squares slope/intercept (intercept forced to 0 if asked). */
function linReg(
  xs: number[],
  ys: number[],
  throughOrigin: boolean,
): { slope: number; intercept: number } {
  const n = xs.length;
  if (throughOrigin) {
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i += 1) {
      sxx += xs[i] * xs[i];
      sxy += xs[i] * ys[i];
    }
    return { slope: sxx ? sxy / sxx : NaN, intercept: 0 };
  }
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const d = n * sxx - sx * sx;
  const slope = d !== 0 ? (n * sxy - sx * sy) / d : NaN;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

/** 1 − SS_res/SS_tot for `predict` over the given points (NaN if degenerate). */
function rSquared(xs: number[], ys: number[], predict: (x: number) => number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  let mean = 0;
  for (const y of ys) mean += y;
  mean /= n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const p = predict(xs[i]);
    if (!Number.isFinite(p)) return NaN;
    ssRes += (ys[i] - p) ** 2;
    ssTot += (ys[i] - mean) ** 2;
  }
  if (ssTot === 0) return NaN;
  return 1 - ssRes / ssTot;
}

// --- per-type fits -----------------------------------------------------------

function fail(error: string): TrendlineFit {
  return { ok: false, predict: () => NaN, equation: "", r2: NaN, n: 0, error };
}

/** Build the descending-power equation string from coefficients. */
function polyEquation(coef: number[], powers: number[]): string {
  let s = "y =";
  let first = true;
  for (let j = powers.length - 1; j >= 0; j -= 1) {
    const c = coef[j];
    if (!Number.isFinite(c) || c === 0) continue;
    const p = powers[j];
    const suffix = p === 0 ? "" : p === 1 ? "x" : `x^${p}`;
    const a = Math.abs(c);
    if (first) {
      s += ` ${c < 0 ? "-" : ""}${fmt(a)}${suffix}`;
      first = false;
    } else {
      s += ` ${c < 0 ? "-" : "+"} ${fmt(a)}${suffix}`;
    }
  }
  return first ? "y = 0" : s;
}

/** Polynomial (degree d) least squares; linear is just d = 1. */
function fitPoly(xs: number[], ys: number[], degree: number, throughOrigin: boolean): TrendlineFit {
  const powers = throughOrigin
    ? Array.from({ length: degree }, (_, i) => i + 1)
    : Array.from({ length: degree + 1 }, (_, i) => i);
  const m = powers.length;
  if (xs.length < m) return fail(`Need at least ${m} points for this fit.`);

  const A = powers.map((pj) =>
    powers.map((pk) => xs.reduce((acc, x) => acc + x ** (pj + pk), 0)),
  );
  const b = powers.map((pj) => xs.reduce((acc, x, i) => acc + ys[i] * x ** pj, 0));
  const coef = solve(A, b);
  if (!coef) return fail("Could not fit (try a lower degree).");

  const predict = (x: number) => powers.reduce((acc, p, j) => acc + coef[j] * x ** p, 0);
  return { ok: true, predict, equation: polyEquation(coef, powers), r2: rSquared(xs, ys, predict), n: xs.length };
}

/** Exponential y = a·e^(b·x), via OLS on (x, ln y) over positive y. */
function fitExp(xs: number[], ys: number[]): TrendlineFit {
  const sx: number[] = [];
  const sy: number[] = [];
  const ly: number[] = [];
  for (let i = 0; i < xs.length; i += 1) {
    if (ys[i] > 0) {
      sx.push(xs[i]);
      sy.push(ys[i]);
      ly.push(Math.log(ys[i]));
    }
  }
  if (sx.length < 2) return fail("Need ≥2 points with y > 0 for an exponential fit.");
  const { slope: b, intercept } = linReg(sx, ly, false);
  const a = Math.exp(intercept);
  const predict = (x: number) => a * Math.exp(b * x);
  return {
    ok: true,
    predict,
    equation: `y = ${fmt(a)}e^(${fmt(b)}x)`,
    r2: rSquared(sx, sy, predict),
    n: sx.length,
  };
}

/** Logarithmic y = a·ln(x) + b, via OLS on (ln x, y) over x > 0. */
function fitLog(xs: number[], ys: number[]): TrendlineFit {
  const sx: number[] = [];
  const sy: number[] = [];
  const lx: number[] = [];
  for (let i = 0; i < xs.length; i += 1) {
    if (xs[i] > 0) {
      sx.push(xs[i]);
      sy.push(ys[i]);
      lx.push(Math.log(xs[i]));
    }
  }
  if (sx.length < 2) return fail("Need ≥2 points with x > 0 for a logarithmic fit.");
  const { slope: a, intercept: b } = linReg(lx, sy, false);
  const predict = (x: number) => (x > 0 ? a * Math.log(x) + b : NaN);
  const eq = `y = ${fmt(a)}ln(x) ${b < 0 ? "-" : "+"} ${fmt(Math.abs(b))}`;
  return { ok: true, predict, equation: eq, r2: rSquared(sx, sy, predict), n: sx.length };
}

/** Power y = a·x^b, via OLS on (ln x, ln y) over x > 0 and y > 0. */
function fitPow(xs: number[], ys: number[]): TrendlineFit {
  const sx: number[] = [];
  const sy: number[] = [];
  const lx: number[] = [];
  const ly: number[] = [];
  for (let i = 0; i < xs.length; i += 1) {
    if (xs[i] > 0 && ys[i] > 0) {
      sx.push(xs[i]);
      sy.push(ys[i]);
      lx.push(Math.log(xs[i]));
      ly.push(Math.log(ys[i]));
    }
  }
  if (sx.length < 2) return fail("Need ≥2 points with x > 0 and y > 0 for a power fit.");
  const { slope: b, intercept } = linReg(lx, ly, false);
  const a = Math.exp(intercept);
  const predict = (x: number) => (x > 0 ? a * x ** b : NaN);
  return {
    ok: true,
    predict,
    equation: `y = ${fmt(a)}x^(${fmt(b)})`,
    r2: rSquared(sx, sy, predict),
    n: sx.length,
  };
}

// --- entry point -------------------------------------------------------------

/**
 * Fit the configured trendline to the (x, y) scatter. Points are first reduced
 * to the finite pairs inside [rangeMin, rangeMax]; the chosen model is fitted by
 * least squares and returned with a `predict` closure, a formatted `equation`,
 * and an R² measured on the original y-scale.
 */
export function fitTrendline(x: number[], y: number[], cfg: TrendlineConfig): TrendlineFit {
  const xs: number[] = [];
  const ys: number[] = [];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
    if (cfg.rangeMin != null && x[i] < cfg.rangeMin) continue;
    if (cfg.rangeMax != null && x[i] > cfg.rangeMax) continue;
    xs.push(x[i]);
    ys.push(y[i]);
  }
  if (xs.length < 2) return fail("Not enough points in the selected range.");

  switch (cfg.type) {
    case "linear":
      return fitPoly(xs, ys, 1, cfg.throughOrigin);
    case "polynomial":
      return fitPoly(xs, ys, Math.max(2, Math.min(6, Math.round(cfg.degree))), cfg.throughOrigin);
    case "exponential":
      return fitExp(xs, ys);
    case "logarithmic":
      return fitLog(xs, ys);
    case "power":
      return fitPow(xs, ys);
    default:
      return fail("Unknown fit type.");
  }
}
