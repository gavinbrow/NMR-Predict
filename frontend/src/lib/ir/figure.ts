// Pure types and math for the publication figure maker. The renderer
// (FigureSvg) and the controls panel both consume these; nothing here touches
// the DOM, so everything is unit-testable.

// --- data fed in by a host (overlay / kinetics plots) ------------------------

/** One series of y-values over the shared x (NaN = gap). */
export interface FigureSeriesData {
  /** Stable identity used to keep user styling across data updates. */
  id: string;
  label: string;
  y: number[];
  /** Host-suggested initial styling (e.g. scatter vs dashed fit line). */
  styleHints?: Partial<
    Pick<SeriesStyle, "color" | "lineWidth" | "lineStyle" | "markers" | "markerSize">
  >;
}

/** A free-text note drawn on the figure (e.g. a fit equation + R²). */
export interface FigureAnnotation {
  id: string;
  text: string;
  /** Anchor as plot-area fractions (0 = left/top of the plot box). */
  x: number;
  y: number;
  color: string;
  /** Font size in px; defaults to the tick font size. */
  fontSize?: number;
}

/** The neutral plot shape both hosts feed into the figure maker. */
export interface FigureData {
  /** Shared x-values, ascending. */
  x: number[];
  series: FigureSeriesData[];
  xLabel: string;
  yLabel: string;
  /** Seed for the reversed-x option (IR convention: high cm⁻¹ on the left). */
  reversedX?: boolean;
  /** File-name stem for downloads (e.g. "ir_overlay"). */
  sourceName?: string;
  /** Host-supplied text notes (e.g. a trendline equation), drawn on the plot. */
  annotations?: FigureAnnotation[];
}

// --- user-editable options ----------------------------------------------------

export type LineStyle = "solid" | "dashed" | "dotted" | "none";
export type GridStyle = "solid" | "dashed" | "dotted";
export type LegendPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface AxisOptions {
  label: string;
  /** Manual range bound; null = auto from the data. */
  min: number | null;
  max: number | null;
  /** Approximate tick count; null = auto (~6). */
  tickCount: number | null;
  /** Tick label decimals; null = auto from the tick step. */
  decimals: number | null;
  showTickLabels: boolean;
  showGrid: boolean;
  gridColor: string;
  gridWidth: number;
  gridStyle: GridStyle;
}

export interface SeriesStyle {
  id: string;
  label: string;
  visible: boolean;
  color: string;
  lineWidth: number;
  lineStyle: LineStyle;
  markers: boolean;
  /** Marker radius in px. */
  markerSize: number;
}

export interface LegendOptions {
  show: boolean;
  position: LegendPosition;
  /**
   * Free placement of the legend's top-left corner as fractions (0–1) of the
   * plot area. `null` falls back to the `position` corner. Set by dragging the
   * legend in the live preview.
   */
  custom: { x: number; y: number } | null;
  fontSize: number;
  frame: boolean;
}

export interface FigureOptions {
  title: string;
  titleFontSize: number;
  fontFamily: string;
  axisFontSize: number;
  tickFontSize: number;
  /** Figure size in px (the SVG viewBox; exports scale from here). */
  width: number;
  height: number;
  background: "white" | "transparent";
  reversedX: boolean;
  /** Plot frame: the border box around the plot area, plus the tick marks. */
  frameShow: boolean;
  frameColor: string;
  frameWidth: number;
  /** Axis label + tick label text colour and weight. */
  axisColor: string;
  axisBold: boolean;
  x: AxisOptions;
  y: AxisOptions;
  series: SeriesStyle[];
  legend: LegendOptions;
}

// --- defaults ------------------------------------------------------------------

/** Distinct line colours, cycled across series (shared with the analysis views). */
export const PALETTE = [
  "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#ea580c", "#0d9488",
  "#9333ea", "#ca8a04", "#0284c7", "#e11d48", "#4f46e5",
];

export const FONT_FAMILIES = ["Arial", "Times New Roman", "Georgia", "Courier New"];

function defaultAxisOptions(label: string): AxisOptions {
  return {
    label,
    min: null,
    max: null,
    tickCount: null,
    decimals: null,
    showTickLabels: true,
    showGrid: true,
    gridColor: "#e2e8f0",
    gridWidth: 1,
    gridStyle: "solid",
  };
}

function defaultSeriesStyle(s: FigureSeriesData, index: number): SeriesStyle {
  const hints = s.styleHints ?? {};
  return {
    id: s.id,
    label: s.label,
    visible: true,
    color: hints.color ?? PALETTE[index % PALETTE.length],
    lineWidth: hints.lineWidth ?? 1.5,
    lineStyle: hints.lineStyle ?? "solid",
    markers: hints.markers ?? false,
    markerSize: hints.markerSize ?? 4,
  };
}

/** Initial options seeded from the data (labels, palette colours, style hints). */
export function defaultFigureOptions(data: FigureData): FigureOptions {
  return {
    title: "",
    titleFontSize: 18,
    fontFamily: "Arial",
    axisFontSize: 14,
    tickFontSize: 12,
    width: 900,
    height: 560,
    background: "white",
    reversedX: data.reversedX ?? false,
    frameShow: true,
    frameColor: "#334155",
    frameWidth: 1,
    axisColor: "#0f172a",
    axisBold: false,
    x: defaultAxisOptions(data.xLabel),
    y: defaultAxisOptions(data.yLabel),
    series: data.series.map(defaultSeriesStyle),
    legend: {
      show: data.series.length > 1 && data.series.length <= 12,
      position: "top-right",
      custom: null,
      fontSize: 12,
      frame: true,
    },
  };
}

/**
 * Carry user edits across a data update: keep the style for series ids that
 * survive, seed defaults for new ones, drop removed ones.
 */
export function reconcileFigureOptions(prev: FigureOptions, data: FigureData): FigureOptions {
  const prevById = new Map(prev.series.map((s) => [s.id, s]));
  return {
    ...prev,
    series: data.series.map((s, i) => prevById.get(s.id) ?? defaultSeriesStyle(s, i)),
  };
}

// --- axis math -------------------------------------------------------------------

/** Heckbert's "nice number": 1/2/5 × 10^k near `value`. */
function niceNum(value: number, round: boolean): number {
  const exp = Math.floor(Math.log10(value));
  const f = value / 10 ** exp;
  let nf: number;
  if (round) {
    if (f < 1.5) nf = 1;
    else if (f < 3) nf = 2;
    else if (f < 7) nf = 5;
    else nf = 10;
  } else if (f <= 1) nf = 1;
  else if (f <= 2) nf = 2;
  else if (f <= 5) nf = 5;
  else nf = 10;
  return nf * 10 ** exp;
}

export interface TickResult {
  ticks: number[];
  lo: number;
  hi: number;
  step: number;
}

/**
 * Nice tick marks spanning [min, max] (Heckbert's loose labelling): expands to
 * nice bounds at a 1/2/5 step near `count` ticks. Degenerate (flat) ranges are
 * padded; inverted inputs are swapped.
 */
export function niceTicks(min: number, max: number, count = 6): TickResult {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { ticks: [0, 1], lo: 0, hi: 1, step: 1 };
  }
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    min -= pad;
    max += pad;
  }
  const range = niceNum(max - min, false);
  const step = niceNum(range / (Math.max(2, count) - 1), true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const n = Math.round((hi - lo) / step);
  const ticks: number[] = [];
  for (let i = 0; i <= n; i += 1) ticks.push(lo + i * step);
  return { ticks, lo, hi, step };
}

/** Decimal places needed to render a 1/2/5×10^k tick step exactly. */
export function tickDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0 || step >= 1) return 0;
  return Math.min(6, -Math.floor(Math.log10(step) + 1e-9));
}

/** Fixed-decimal tick label, normalising "-0" to "0". */
export function formatTick(value: number, decimals: number): string {
  const s = value.toFixed(decimals);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

/** Finite [min, max] of the values; [0, 1] when there are none. */
export function autoRange(values: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo === Infinity ? [0, 1] : [lo, hi];
}

export interface ResolvedAxis {
  lo: number;
  hi: number;
  ticks: number[];
  decimals: number;
  /** True when a manual min/max pair was degenerate and auto was used instead. */
  manualInvalid: boolean;
}

/**
 * Turn axis options + the data values into a concrete range and tick set.
 * Manual bounds are honoured exactly (ticks clipped inside); auto bounds are
 * niced. A degenerate manual pair (min ≥ max) falls back to auto.
 */
export function resolveAxis(axis: AxisOptions, values: number[]): ResolvedAxis {
  const [dLo, dHi] = autoRange(values);
  const count = axis.tickCount ?? 6;
  const auto = niceTicks(dLo, dHi, count);

  let lo = axis.min ?? auto.lo;
  let hi = axis.max ?? auto.hi;
  let manualInvalid = false;
  if (!(lo < hi)) {
    manualInvalid = true;
    lo = auto.lo;
    hi = auto.hi;
  }

  const t = niceTicks(lo, hi, count);
  const eps = (hi - lo) * 1e-9;
  const ticks = t.ticks.filter((v) => v >= lo - eps && v <= hi + eps);
  return { lo, hi, ticks, decimals: axis.decimals ?? tickDecimals(t.step), manualInvalid };
}

// --- series geometry ---------------------------------------------------------------

/**
 * Min/max-bucket decimation for live previews of dense spectra: each bucket
 * keeps its extreme two points (in x order), so peaks survive. A bucket with
 * any non-finite y emits a NaN sentinel so gaps stay gaps. Inputs short enough
 * to draw directly are returned as-is.
 */
export function decimateMinMax(
  x: number[],
  y: number[],
  buckets: number,
): { x: number[]; y: number[] } {
  const n = Math.min(x.length, y.length);
  if (n <= buckets * 2) return { x: x.slice(0, n), y: y.slice(0, n) };

  const ox: number[] = [];
  const oy: number[] = [];
  const per = n / buckets;
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor(b * per);
    const end = Math.min(n, Math.floor((b + 1) * per));
    if (start >= end) continue;

    let iMin = -1;
    let iMax = -1;
    let hasGap = false;
    for (let i = start; i < end; i += 1) {
      const v = y[i];
      if (!Number.isFinite(v)) {
        hasGap = true;
        continue;
      }
      if (iMin === -1 || v < y[iMin]) iMin = i;
      if (iMax === -1 || v > y[iMax]) iMax = i;
    }

    if (iMin === -1) {
      // All-gap bucket — one NaN point keeps the pen up.
      ox.push(x[start]);
      oy.push(NaN);
      continue;
    }
    const first = Math.min(iMin, iMax);
    const second = Math.max(iMin, iMax);
    ox.push(x[first]);
    oy.push(y[first]);
    if (second !== first) {
      ox.push(x[second]);
      oy.push(y[second]);
    }
    if (hasGap) {
      ox.push(x[end - 1]);
      oy.push(NaN);
    }
  }
  return { x: ox, y: oy };
}

/**
 * SVG path `d` for one series through the scale functions. Non-finite points
 * lift the pen (a new `M` subpath), so NaN gaps render as gaps.
 */
export function seriesPathD(
  x: number[],
  y: number[],
  sx: (v: number) => number,
  sy: (v: number) => number,
): string {
  const n = Math.min(x.length, y.length);
  const r = (v: number) => Math.round(v * 100) / 100;
  let d = "";
  let pen = false;
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${r(sx(x[i]))} ${r(sy(y[i]))}`;
    pen = true;
  }
  return d;
}

/** SVG stroke-dasharray for a line/grid style, scaled by the stroke width. */
export function dashArray(style: LineStyle | GridStyle, width: number): string | undefined {
  const w = Math.max(width, 0.5);
  if (style === "dashed") return `${4 * w} ${3 * w}`;
  if (style === "dotted") return `${w} ${2 * w}`;
  return undefined;
}
