// Small, dependency-free numeric helpers for the IR workspace — the building
// blocks for baseline correction, peak measurement, and the kinetics fits.
// Each mirrors the NumPy/SciPy primitive the original Streamlit app relied on.

/** Evenly spaced points from `a` to `b` inclusive (NumPy `linspace`). */
export function linspace(a: number, b: number, n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [a];
  const out = new Array<number>(n);
  const step = (b - a) / (n - 1);
  for (let i = 0; i < n; i += 1) out[i] = a + step * i;
  // Pin the last point exactly to avoid float drift at the endpoint.
  out[n - 1] = b;
  return out;
}

/** Trapezoidal integral of `y` over a (possibly non-uniform) `x` grid. */
export function trapezoid(y: number[], x: number[]): number {
  let sum = 0;
  const n = Math.min(y.length, x.length);
  for (let i = 0; i < n - 1; i += 1) {
    sum += ((x[i + 1] - x[i]) * (y[i] + y[i + 1])) / 2;
  }
  return sum;
}

/**
 * NumPy-style 1-D linear interpolation. `xp` must be ascending. Values of
 * `xNew` outside [xp[0], xp[last]] are clamped to the endpoint values.
 */
export function interp(xNew: number[], xp: number[], fp: number[]): number[] {
  const n = xp.length;
  const out = new Array<number>(xNew.length);
  if (n === 0) return out.fill(NaN);
  if (n === 1) return out.fill(fp[0]);
  for (let i = 0; i < xNew.length; i += 1) {
    const x = xNew[i];
    if (x <= xp[0]) {
      out[i] = fp[0];
      continue;
    }
    if (x >= xp[n - 1]) {
      out[i] = fp[n - 1];
      continue;
    }
    // Binary search for the bracketing interval [lo, lo+1].
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xp[mid] <= x) lo = mid;
      else hi = mid;
    }
    const x0 = xp[lo];
    const x1 = xp[lo + 1];
    const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    out[i] = fp[lo] + t * (fp[lo + 1] - fp[lo]);
  }
  return out;
}

/** Ordinary least-squares straight-line fit (NumPy `polyfit` degree 1). */
export function polyfitDeg1(x: number[], y: number[]): { slope: number; intercept: number } {
  const n = Math.min(x.length, y.length);
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = n !== 0 ? (sy - slope * sx) / n : 0;
  return { slope, intercept };
}

/**
 * Tokenize a name into a natural-sort key: digit runs become numbers, other
 * runs become lowercased strings — so `file2` sorts before `file10`.
 */
export function naturalKey(name: string): (string | number)[] {
  const tokens = name.match(/\d+|\D+/g) ?? [];
  return tokens.map((t) => (/^\d+$/.test(t) ? Number.parseInt(t, 10) : t.toLowerCase()));
}

/** Comparator over `naturalKey` tokens (numbers before strings on type clash). */
export function naturalCompare(a: string, b: string): number {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  const len = Math.min(ka.length, kb.length);
  for (let i = 0; i < len; i += 1) {
    const x = ka[i];
    const y = kb[i];
    if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else {
      const xs = String(x);
      const ys = String(y);
      if (xs < ys) return -1;
      if (xs > ys) return 1;
    }
  }
  return ka.length - kb.length;
}

/**
 * Andrew's monotone-chain convex hull. Returns the hull vertices in CCW order
 * (lower chain min-x → max-x, then upper chain back) without a repeated start
 * point. Used by the rubberband baseline to find the lower envelope.
 */
export function convexHull(points: [number, number][]): [number, number][] {
  const pts = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const n = pts.length;
  if (n < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
