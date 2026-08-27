// Small pure numeric helpers for the TGA compute engine. They operate on
// Float64Arrays, never mutate their inputs, and never throw.

/** Drop rows whose time is not strictly greater than the previous kept row's.
 *  Returns the kept indices so callers can slice other arrays consistently. */
export function monotoneDedupeIndices(timeMin: Float64Array): number[] {
  const n = timeMin.length;
  const out: number[] = [];
  let prev = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const t = timeMin[i];
    if (Number.isFinite(t) && t > prev + Number.EPSILON) {
      out.push(i);
      prev = t;
    }
  }
  return out;
}

/** Apply a monotone-dedupe using timeMin, returning equally-sized slices of the
 *  three primary arrays. Any of the arrays may be shorter than timeMin; they
 *  are truncated to the common length before deduping. */
export function dedupeRun(
  timeMin: Float64Array,
  tempC: Float64Array,
  weightMg: Float64Array,
): { timeMin: Float64Array; tempC: Float64Array; weightMg: Float64Array; indices: number[] } {
  const n = Math.min(timeMin.length, tempC.length, weightMg.length);
  const indices = monotoneDedupeIndices(timeMin.subarray(0, n));
  const m = indices.length;
  const outT = new Float64Array(m);
  const outTemp = new Float64Array(m);
  const outW = new Float64Array(m);
  for (let k = 0; k < m; k += 1) {
    const i = indices[k];
    outT[k] = timeMin[i];
    outTemp[k] = tempC[i];
    outW[k] = weightMg[i];
  }
  return { timeMin: outT, tempC: outTemp, weightMg: outW, indices };
}

/** Linear interpolation at a single x value. `xs` must be strictly ascending.
 *  Values outside the range clamp to the nearest endpoint. */
export function interp1d(x: number, xs: Float64Array, ys: Float64Array): number {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return NaN;
  if (n === 1) return ys[0];
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const dx = xs[hi] - xs[lo];
  const t = dx === 0 ? 0 : (x - xs[lo]) / dx;
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** Index of the last element <= v in an ascending array, or -1 when empty or
 *  every element is greater than v. Mirrors `lowerBound` semantics from
 *  `lib/gcms/numerics.ts`. */
export function lowerBound(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return -1;
  return lo - 1;
}

/** Index of the first element >= v in an ascending array, or arr.length when
 *  every element is less than v. */
export function upperBound(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Clamp a window to odd, minimum 5, and no larger than the data length. */
export function clampWindow(window: number, n: number): number {
  let w = Math.max(5, Math.floor(window));
  if (w > n) w = n;
  if (w % 2 === 0) w -= 1;
  return w < 5 ? 5 : w;
}

/** Find the index of the maximum finite value in `arr`. Returns -1 if none. */
export function argmax(arr: Float64Array, lo = 0, hi = arr.length): number {
  let best = -1;
  let bestV = -Infinity;
  for (let i = lo; i < hi; i += 1) {
    const v = arr[i];
    if (Number.isFinite(v) && v > bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

/** Find the index of the minimum finite value in `arr`. Returns -1 if none. */
export function argmin(arr: Float64Array, lo = 0, hi = arr.length): number {
  let best = -1;
  let bestV = Infinity;
  for (let i = lo; i < hi; i += 1) {
    const v = arr[i];
    if (Number.isFinite(v) && v < bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

/** Find the local minimum of `arr` within `[lo, hi]` whose value is the lowest.
 *  The returned index is a strict local minimum in at least a one-point
 *  neighbourhood (smaller than both neighbours when present), with ties resolved
 *  to the left. */
export function localMinimumIndex(arr: Float64Array, lo: number, hi: number): number {
  let best = -1;
  let bestV = Infinity;
  for (let i = Math.max(1, lo); i < Math.min(hi, arr.length - 1); i += 1) {
    const v = arr[i];
    if (!Number.isFinite(v)) continue;
    if (v < arr[i - 1] && v <= arr[i + 1] && v < bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

/** Find the local maximum of `arr` within `[lo, hi]` whose value is the highest.
 *  The returned index is a strict local maximum in at least a one-point
 *  neighbourhood. */
export function localMaximumIndex(arr: Float64Array, lo: number, hi: number): number {
  let best = -1;
  let bestV = -Infinity;
  for (let i = Math.max(1, lo); i < Math.min(hi, arr.length - 1); i += 1) {
    const v = arr[i];
    if (!Number.isFinite(v)) continue;
    if (v > arr[i - 1] && v >= arr[i + 1] && v > bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

/** X-coordinate of the intersection of two lines y = m1*x + c1 and
 *  y = m2*x + c2. Returns NaN when the lines are parallel. */
export function lineIntersectionX(
  m1: number,
  c1: number,
  m2: number,
  c2: number,
): number {
  const dm = m2 - m1;
  if (!Number.isFinite(dm) || Math.abs(dm) < Number.EPSILON) return NaN;
  return (c1 - c2) / dm;
}

/** Mean of `arr[lo..hi)`. Returns NaN when the slice is empty. */
export function mean(arr: Float64Array, lo = 0, hi = arr.length): number {
  let sum = 0;
  let count = 0;
  for (let i = lo; i < hi; i += 1) {
    if (Number.isFinite(arr[i])) {
      sum += arr[i];
      count += 1;
    }
  }
  return count > 0 ? sum / count : NaN;
}

/** Standard deviation (sample, ddof = 1) of `arr[lo..hi)`. Returns NaN when
 *  fewer than two finite values exist. */
export function sd(arr: Float64Array, lo = 0, hi = arr.length): number {
  const vals: number[] = [];
  for (let i = lo; i < hi; i += 1) {
    if (Number.isFinite(arr[i])) vals.push(arr[i]);
  }
  if (vals.length < 2) return NaN;
  const m = mean(Float64Array.from(vals));
  let ss = 0;
  for (const v of vals) ss += (v - m) ** 2;
  return Math.sqrt(ss / (vals.length - 1));
}
