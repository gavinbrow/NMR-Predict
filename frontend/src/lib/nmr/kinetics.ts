// Kinetics analysis layer for the NMR Kinetics workspace.
//
// The full <NMRium> component does the NMR math (baseline, integration,
// ranges, stacking). These pure functions read the integrals/ranges back out
// of the NmriumState that <NMRium onChange> emits, turn them into time series
// for tracked ppm windows, and fit textbook kinetic models with dependency-free
// linearized ordinary least squares. Everything here is unit-testable.

export type TimeUnit = "s" | "min" | "h";

export interface KineticIntegral {
  id: string;
  from: number;
  to: number;
  /** Relative integral value (scaled by NMRium's sum options). */
  integral: number;
  /** Raw absolute area before scaling. */
  absolute: number;
}

/** Raw 1D data needed to integrate an arbitrary ppm window directly. */
export interface SpectrumData {
  x: ArrayLike<number>;
  re: ArrayLike<number>;
}

export interface KineticSpectrum {
  id: string;
  name: string;
  nucleus: string;
  integrals: KineticIntegral[];
  /** Ranges are also area-bearing; we fold their `integration` into the same shape. */
  ranges: KineticIntegral[];
  /**
   * Raw spectrum points (baseline-corrected `re` vs `x` in ppm). When present we
   * integrate the tracked window directly, so the kinetics layer works whether the
   * user used per-spectrum integrals, ranges, or the "1D multiple spectra analysis"
   * tool (which doesn't write integrals onto each spectrum).
   */
  data?: SpectrumData | null;
}

/** A ppm window defined in NMRium's "1D multiple spectra analysis" panel. */
export interface AnalysisColumn {
  label: string;
  from: number;
  to: number;
}

/**
 * What a tracked peak represents in the reaction:
 *  - reactant / product: plotted on the kinetics chart and fit to a model.
 *  - standard: an internal standard used only to normalize the other peaks;
 *    never plotted or fit on its own.
 */
export type PeakRole = "reactant" | "product" | "standard";

export interface TrackedPeak {
  id: string;
  label: string;
  from: number;
  to: number;
  color: string;
  /** Defaults to "reactant" when omitted. */
  role?: PeakRole;
}

/** A spectrum's user-assigned acquisition time. */
export interface Timepoint {
  value: number;
  unit: TimeUnit;
}

export type KineticModelKind = "zero" | "first" | "second" | "growth";

export interface SeriesPoint {
  timeSeconds: number;
  value: number;
  spectrumId: string;
  spectrumName: string;
}

export interface FitResult {
  model: KineticModelKind;
  /** Rate constant in per-second units (per the model's order). */
  k: number;
  /** Intercept on the linearized (transformed) scale. */
  intercept: number;
  rSquared: number;
  /** Half-life in seconds (first-order only). */
  halfLife?: number;
  /** Estimated plateau [A]∞ on the natural scale (growth model only). */
  plateau?: number;
  /** Number of points actually used after dropping invalid transforms. */
  pointCount: number;
}

const SECONDS_PER_UNIT: Record<TimeUnit, number> = {
  s: 1,
  min: 60,
  h: 3600,
};

export function toSeconds(value: number, unit: TimeUnit): number {
  return value * SECONDS_PER_UNIT[unit];
}

export function fromSeconds(seconds: number, unit: TimeUnit): number {
  return seconds / SECONDS_PER_UNIT[unit];
}

// --- NMRium state extraction -------------------------------------------------

interface SpectrumLike {
  id: string;
  info?: { name?: string; nucleus?: string; dimension?: number };
  display?: { name?: string };
  data?: { x?: ArrayLike<number>; re?: ArrayLike<number> } | null;
  integrals?: { values?: Array<Partial<KineticIntegral>> | null } | null;
  ranges?: {
    values?: Array<Partial<KineticIntegral> & { integration?: number }> | null;
  } | null;
}

interface AnalysisColumnLike {
  label?: string;
  from?: number;
  to?: number;
}

export interface NmriumStateLike {
  data?: { spectra?: SpectrumLike[] | null } | null;
  settings?: {
    panels?: {
      multipleSpectraAnalysis?: Record<
        string,
        { analysisOptions?: { columns?: Record<string, AnalysisColumnLike> | null } | null } | undefined
      > | null;
    } | null;
  } | null;
}

/** Compare spectrum names so "2" sorts before "10" (acquisition order). */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * The single point of contact with NMRium internals: pull 1D spectra and map
 * their integrals/ranges to the slim shape the rest of the module uses.
 */
export function extractKineticSpectra(state: NmriumStateLike | null | undefined): KineticSpectrum[] {
  const spectra = state?.data?.spectra ?? [];

  return spectra
    .filter((spectrum) => (spectrum.info?.dimension ?? 1) === 1)
    .map((spectrum) => {
      const integrals: KineticIntegral[] = (spectrum.integrals?.values ?? [])
        .filter((value): value is Partial<KineticIntegral> => value != null)
        .map((value, index) => ({
          id: value.id ?? `${spectrum.id}-integral-${index}`,
          from: Number(value.from ?? 0),
          to: Number(value.to ?? 0),
          integral: Number(value.integral ?? value.absolute ?? 0),
          absolute: Number(value.absolute ?? 0),
        }));

      const ranges: KineticIntegral[] = (spectrum.ranges?.values ?? [])
        .filter((value): value is Partial<KineticIntegral> & { integration?: number } => value != null)
        .map((value, index) => ({
          id: value.id ?? `${spectrum.id}-range-${index}`,
          from: Number(value.from ?? 0),
          to: Number(value.to ?? 0),
          integral: Number(value.integration ?? value.integral ?? value.absolute ?? 0),
          absolute: Number(value.absolute ?? 0),
        }));

      const x = spectrum.data?.x;
      const re = spectrum.data?.re;
      const data: SpectrumData | null =
        x && re && x.length > 0 && re.length > 0 ? { x, re } : null;

      return {
        id: spectrum.id,
        name: spectrum.display?.name ?? spectrum.info?.name ?? spectrum.id,
        nucleus: spectrum.info?.nucleus ?? "",
        integrals,
        ranges,
        data,
      } satisfies KineticSpectrum;
    })
    .sort((a, b) => naturalCompare(a.name, b.name));
}

/**
 * Read the ppm windows the user defined in NMRium's "1D multiple spectra
 * analysis" panel (stored in settings, not on individual spectra). These can be
 * imported as tracked peaks so the "integrate everything at once" workflow flows
 * straight into the kinetics plot.
 */
export function extractAnalysisColumns(state: NmriumStateLike | null | undefined): AnalysisColumn[] {
  const byNucleus = state?.settings?.panels?.multipleSpectraAnalysis ?? {};
  const columns: AnalysisColumn[] = [];

  for (const nucleus of Object.keys(byNucleus)) {
    const cols = byNucleus[nucleus]?.analysisOptions?.columns ?? {};
    for (const key of Object.keys(cols)) {
      const col = cols[key];
      const from = Number(col?.from);
      const to = Number(col?.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      columns.push({
        label: col?.label?.trim() || key,
        from: Math.max(from, to),
        to: Math.min(from, to),
      });
    }
  }

  return columns;
}

// --- Direct window integration ----------------------------------------------

/**
 * Trapezoidal area of the spectrum's real channel over a ppm window. Works
 * regardless of whether x ascends or descends (ppm axes usually descend), since
 * each segment uses the absolute step width. This is the same quantity NMRium's
 * range/analysis tools report, computed straight from the points so we don't
 * depend on the user having created an integral object.
 */
export function integrateWindow(
  data: SpectrumData,
  from: number,
  to: number,
): number | null {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const { x, re } = data;
  const n = Math.min(x.length, re.length);
  if (n < 2) return null;

  let area = 0;
  let used = 0;
  for (let i = 0; i < n - 1; i += 1) {
    const x0 = x[i];
    const x1 = x[i + 1];
    const inA = x0 >= lo && x0 <= hi;
    const inB = x1 >= lo && x1 <= hi;
    if (!inA || !inB) continue;
    area += (Math.abs(x1 - x0) * (re[i] + re[i + 1])) / 2;
    used += 1;
  }

  return used > 0 ? area : null;
}

// --- Peak matching -----------------------------------------------------------

function overlap(aFrom: number, aTo: number, bFrom: number, bTo: number): number {
  const lo = Math.max(Math.min(aFrom, aTo), Math.min(bFrom, bTo));
  const hi = Math.min(Math.max(aFrom, aTo), Math.max(bFrom, bTo));
  return Math.max(0, hi - lo);
}

/**
 * Value of a tracked peak in one spectrum.
 *
 * Primary path: integrate the tracked ppm window directly from the raw points.
 * This is consistent across the whole series and independent of how (or whether)
 * the user integrated in NMRium — so it works for both per-spectrum integration
 * and the "1D multiple spectra analysis" tool.
 *
 * Fallback: if raw data isn't available, reuse a NMRium integral/range whose
 * window best overlaps the tracked peak. Returns null when nothing is available,
 * so the chart shows a gap for that timepoint instead of a fake zero.
 */
export function integralForPeak(spectrum: KineticSpectrum, peak: TrackedPeak): number | null {
  if (spectrum.data) {
    const direct = integrateWindow(spectrum.data, peak.from, peak.to);
    if (direct != null) return direct;
  }

  const candidates = [...spectrum.integrals, ...spectrum.ranges];
  let best: { value: number; score: number } | null = null;

  for (const candidate of candidates) {
    const score = overlap(candidate.from, candidate.to, peak.from, peak.to);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { value: candidate.integral, score };
    }
  }

  return best ? best.value : null;
}

// --- Series building ---------------------------------------------------------

/**
 * Build a time series for one tracked peak across all spectra that have a time
 * assigned. When a standard peak is supplied, each value is normalized by the
 * standard's integral in the same spectrum. Sorted ascending by time; spectra
 * missing an integral for the peak (or the standard) are skipped.
 */
export function buildSeries(
  spectra: KineticSpectrum[],
  timepoints: Record<string, Timepoint | undefined>,
  peak: TrackedPeak,
  standardPeak?: TrackedPeak | null,
): SeriesPoint[] {
  const points: SeriesPoint[] = [];

  for (const spectrum of spectra) {
    const time = timepoints[spectrum.id];
    if (!time || !Number.isFinite(time.value)) continue;

    const raw = integralForPeak(spectrum, peak);
    if (raw == null) continue;

    let value = raw;
    if (standardPeak && standardPeak.id !== peak.id) {
      const standard = integralForPeak(spectrum, standardPeak);
      if (standard == null || standard === 0) continue;
      value = raw / standard;
    }

    points.push({
      timeSeconds: toSeconds(time.value, time.unit),
      value,
      spectrumId: spectrum.id,
      spectrumName: spectrum.name,
    });
  }

  return points.sort((a, b) => a.timeSeconds - b.timeSeconds);
}

// --- Model fitting -----------------------------------------------------------

interface Linear {
  slope: number;
  intercept: number;
  rSquared: number;
}

function linearRegression(xs: number[], ys: number[]): Linear {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0, rSquared: 0 };
  if (n === 1) return { slope: 0, intercept: ys[0], rSquared: 0 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i];
    sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumXX += xs[i] * xs[i];
  }

  const denom = n * sumXX - sumX * sumX;
  const meanY = sumY / n;
  if (denom === 0) {
    // All x identical — no slope can be determined.
    return { slope: 0, intercept: meanY, rSquared: 0 };
  }

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = meanY - (slope * sumX) / n;

  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i += 1) {
    const predicted = intercept + slope * xs[i];
    ssTot += (ys[i] - meanY) ** 2;
    ssRes += (ys[i] - predicted) ** 2;
  }
  const rSquared = ssTot === 0 ? (ssRes === 0 ? 1 : 0) : 1 - ssRes / ssTot;

  return { slope, intercept, rSquared };
}

/**
 * Fit a kinetic model by linearizing and running ordinary least squares:
 *   zero   y = [A]          slope = -k
 *   first  y = ln[A]        slope = -k,  t½ = ln2 / k
 *   second y = 1/[A]        slope = +k
 *   growth y = ln([A]∞−[A]) slope = -k   ([A]∞ = max observed value)
 * Non-positive transform inputs are dropped before fitting.
 */
export function fitModel(series: SeriesPoint[], model: KineticModelKind): FitResult {
  const base: FitResult = {
    model,
    k: Number.NaN,
    intercept: Number.NaN,
    rSquared: Number.NaN,
    pointCount: 0,
  };

  if (series.length < 2) return base;

  const xs: number[] = [];
  const ys: number[] = [];
  let plateau: number | undefined;

  if (model === "growth") {
    // [A]∞ estimated as the maximum observed value; nudge up slightly so the
    // top point doesn't produce ln(0).
    const maxValue = Math.max(...series.map((p) => p.value));
    plateau = maxValue * 1.000001;
  }

  for (const point of series) {
    const t = point.timeSeconds;
    const v = point.value;
    let y: number;

    switch (model) {
      case "zero":
        y = v;
        break;
      case "first":
        if (v <= 0) continue;
        y = Math.log(v);
        break;
      case "second":
        if (v === 0) continue;
        y = 1 / v;
        break;
      case "growth": {
        const diff = (plateau ?? 0) - v;
        if (diff <= 0) continue;
        y = Math.log(diff);
        break;
      }
    }

    xs.push(t);
    ys.push(y);
  }

  if (xs.length < 2) return { ...base, plateau };

  const { slope, intercept, rSquared } = linearRegression(xs, ys);

  let k: number;
  let halfLife: number | undefined;
  switch (model) {
    case "second":
      k = slope;
      break;
    case "zero":
    case "first":
    case "growth":
    default:
      k = -slope;
      break;
  }
  if (model === "first" && k !== 0) {
    halfLife = Math.LN2 / k;
  }

  return {
    model,
    k,
    intercept,
    rSquared,
    halfLife,
    plateau,
    pointCount: xs.length,
  };
}

/** The three orders whose textbook plot linearizes against time. */
export type LinearOrder = "zero" | "first" | "second";

export const ORDER_TEST_ORDERS: LinearOrder[] = ["zero", "first", "second"];

/** Axis label for the linearized concentration term of each order. */
export const ORDER_Y_LABELS: Record<LinearOrder, string> = {
  zero: "[A]",
  first: "ln[A]",
  second: "1/[A]",
};

export interface LinearizedPoint {
  timeSeconds: number;
  /** The transformed concentration term ([A], ln[A] or 1/[A]). */
  y: number;
  spectrumId: string;
}

export interface LinearizedSeries {
  order: LinearOrder;
  yLabel: string;
  points: LinearizedPoint[];
  /** Best-fit straight line through the transformed points (null if < 2 valid). */
  line: { slope: number; intercept: number; rSquared: number } | null;
}

/**
 * Transform a series for an order-determination ("which order is this?") plot:
 * plot [A] (zero), ln[A] (first), or 1/[A] (second) against time and read off R².
 * The order whose transform is most linear (highest R²) is the apparent order.
 * Invalid transform inputs (non-positive for ln, zero for reciprocal) are dropped.
 */
export function linearizeSeries(series: SeriesPoint[], order: LinearOrder): LinearizedSeries {
  const points: LinearizedPoint[] = [];

  for (const point of series) {
    let y: number;
    switch (order) {
      case "zero":
        y = point.value;
        break;
      case "first":
        if (point.value <= 0) continue;
        y = Math.log(point.value);
        break;
      case "second":
        if (point.value === 0) continue;
        y = 1 / point.value;
        break;
    }
    points.push({ timeSeconds: point.timeSeconds, y, spectrumId: point.spectrumId });
  }

  const line =
    points.length >= 2
      ? linearRegression(
          points.map((p) => p.timeSeconds),
          points.map((p) => p.y),
        )
      : null;

  return { order, yLabel: ORDER_Y_LABELS[order], points, line };
}

/**
 * Reconstruct the fitted value at a given time (seconds) for drawing the fit
 * curve. Returns null when the fit is degenerate.
 */
export function predictFromFit(fit: FitResult, timeSeconds: number): number | null {
  if (!Number.isFinite(fit.k) || !Number.isFinite(fit.intercept)) return null;
  const t = timeSeconds;

  switch (fit.model) {
    case "zero":
      return fit.intercept - fit.k * t;
    case "first":
      return Math.exp(fit.intercept - fit.k * t);
    case "second": {
      const denom = fit.intercept + fit.k * t;
      return denom === 0 ? null : 1 / denom;
    }
    case "growth": {
      if (fit.plateau == null) return null;
      return fit.plateau - Math.exp(fit.intercept - fit.k * t);
    }
    default:
      return null;
  }
}

// --- Formatting --------------------------------------------------------------

const RATE_UNIT_SUFFIX: Record<KineticModelKind, string> = {
  zero: "a.u.·{u}⁻¹",
  first: "{u}⁻¹",
  second: "a.u.⁻¹·{u}⁻¹",
  growth: "{u}⁻¹",
};

const UNIT_LABEL: Record<TimeUnit, string> = { s: "s", min: "min", h: "h" };

/**
 * Format a per-second rate constant in the chosen display time unit. The rate
 * scales by the same factor (seconds per unit) for every model order.
 */
export function formatRate(kPerSecond: number, model: KineticModelKind, unit: TimeUnit): string {
  if (!Number.isFinite(kPerSecond)) return "—";
  const kDisplay = kPerSecond * SECONDS_PER_UNIT[unit];
  const suffix = RATE_UNIT_SUFFIX[model].replace("{u}", UNIT_LABEL[unit]);
  return `${formatNumber(kDisplay)} ${suffix}`;
}

export function formatHalfLife(halfLifeSeconds: number | undefined, unit: TimeUnit): string {
  if (halfLifeSeconds == null || !Number.isFinite(halfLifeSeconds)) return "—";
  return `${formatNumber(fromSeconds(halfLifeSeconds, unit))} ${UNIT_LABEL[unit]}`;
}

function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e5)) {
    return value.toExponential(3);
  }
  return Number(value.toPrecision(4)).toString();
}

export const MODEL_LABELS: Record<KineticModelKind, string> = {
  zero: "Zero order",
  first: "First order",
  second: "Second order",
  growth: "Growth (1st-order formation)",
};
