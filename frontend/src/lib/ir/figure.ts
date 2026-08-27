// Pure types and math for the publication figure maker. The renderer
// (FigureSvg) and the controls panel both consume these; nothing here touches
// the DOM, so everything is unit-testable.

// --- data fed in by a host (overlay / kinetics plots) ------------------------

/** One series of y-values over the shared x (NaN = gap). */
export interface FigureSeriesData {
  /** Stable identity used to keep user styling across data updates. */
  id: string;
  label: string;
  /**
   * Optional per-series x-values, ascending. When omitted the series shares the
   * top-level {@link FigureData.x}. Lets hosts overlay traces that live on
   * different x grids (e.g. several mass spectra) or draw sparse stick series
   * (peaks) alongside a dense profile trace.
   */
  x?: number[];
  y: number[];
  /** Data-space baseline for stick series. Defaults to zero (or the visible
   * y-axis floor). Hosts use this for vertically stacked mass spectra. */
  baseline?: number;
  /**
   * Keep this series out of the legend unless the user explicitly adds it (a
   * `show: true` {@link LegendEntryOverride}). For series that exist only
   * because the renderer cannot draw them as part of another — the MALDI
   * adapter splits a ladder's sticks by per-peak colour — where a legend row
   * would just repeat the ladder it came from under a one-off colour.
   */
  legendHidden?: boolean;
  /**
   * Optional heading this series belongs under in the controls panel. Purely an
   * organising device for the Series list: when any series carries one, the
   * panel sections the list by group and offers per-group bulk styling. Hosts
   * that plot one thing (IR, kinetics) leave it undefined and get the flat list
   * unchanged; the MALDI adapter sets it to the source file's name, which is
   * what makes a cross-file figure editable file by file.
   */
  group?: string;
  /** Host-suggested initial styling (e.g. scatter vs dashed fit line, sticks). */
  styleHints?: Partial<
    Pick<SeriesStyle, "color" | "lineWidth" | "lineStyle" | "markers" | "markerSize" | "kind" | "axis">
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

/**
 * A label anchored to a data point — drawn above the point in data space (e.g. an
 * m/z value over a mass-spectrum peak). Unlike {@link FigureAnnotation} (placed by
 * plot-area fraction), these track the data through zoom/range changes, and the
 * renderer thins them to the most intense, non-overlapping few.
 */
export interface PeakLabelDatum {
  id: string;
  /** Anchor in data coordinates (e.g. the peak's m/z). */
  x: number;
  /** Anchor height in data coordinates (e.g. the peak's intensity) — also the
   *  default priority used when thinning a crowded set (taller wins). */
  y: number;
  /**
   * Thinning priority, when the drawn height is the wrong way to rank. Stacked
   * multi-file figures shift each file's trace up by a constant, so `y` would
   * rank every label on the top trace above every label on the bottom one and
   * the lower files would lose all their labels. Hosts pass the peak's own
   * untransformed intensity here instead. Defaults to {@link y}.
   */
  priority?: number;
  /** Pre-formatted fallback text, used when label decimals are set to "raw". */
  text: string;
  /**
   * When true, {@link text} is a host/user-authored label (e.g. a MALDI peak's
   * `Peak.label`) that must be shown verbatim: the Decimals option only reformats
   * labels *without* custom text. Without this flag a user's custom peak label
   * would be overwritten by `x.toFixed(decimals)` the moment they touch Decimals.
   */
  customText?: boolean;
  /**
   * Optional per-datum colour (e.g. the peak's own `Peak.color`). It wins over
   * both the "colour by series" mapping and the single label colour — this is how
   * an individually-coloured peak reaches the label renderer.
   */
  color?: string;
  /** Optional owning series id — used to colour labels by series (and, in the
   *  MALDI adapter, to group sticks). */
  seriesId?: string;
}

/**
 * Figure-only overrides for a single peak label, keyed by {@link PeakLabelDatum.id}.
 * Deliberately thin: it holds only what is genuinely figure-local — placement
 * (a drag offset) and visibility. Text and colour are *not* here; those come from
 * the datum (the host's peak model, already editable/persisted/undoable), so the
 * override layer never duplicates them.
 */
export interface PeakLabelOverride {
  /** Removed from this figure only (the peak stays in the table / exports). */
  hidden?: boolean;
  /** Pixel offset from the anchor, set by dragging the label in the preview. */
  dx?: number;
  dy?: number;
}

/** The neutral plot shape both hosts feed into the figure maker. */
export interface FigureData {
  /** Shared x-values, ascending. Series may override with their own x. */
  x: number[];
  series: FigureSeriesData[];
  xLabel: string;
  yLabel: string;
  /**
   * Right-hand (secondary) y-axis label. When present, the figure maker builds
   * a second y axis (`options.y2`) and lets a series declare
   * {@link SeriesStyle.axis} `"y2"` to draw against it. Absent for every host
   * that has no second axis (IR, MALDI, GC/MS) — the right axis is purely
   * data-driven, so those hosts render byte-identically to before.
   */
  y2Label?: string;
  /** Seed for the reversed-x option (IR convention: high cm⁻¹ on the left). */
  reversedX?: boolean;
  /** File-name stem for downloads (e.g. "ir_overlay"). */
  sourceName?: string;
  /** Host-supplied text notes (e.g. a trendline equation), drawn on the plot. */
  annotations?: FigureAnnotation[];
  /**
   * Data-anchored labels (e.g. peak m/z values). When present (even if empty)
   * the figure maker exposes the "Peaks & labels" controls; hosts that never
   * label points leave this undefined.
   */
  peakLabels?: PeakLabelDatum[];
}

// --- user-editable options ----------------------------------------------------

export type LineStyle = "solid" | "dashed" | "dotted" | "none";
export type GridStyle = "solid" | "dashed" | "dotted";
export type LegendPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
/** How a series is drawn: a connected line (spectra/trends) or vertical stems
 *  from the baseline to each point (centroid / stick mass spectra). */
export type SeriesKind = "line" | "sticks";

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

/** Which y-axis a series is plotted against. `"y"` (left, the default) or
 *  `"y2"` (the optional right-hand secondary axis). Absent on every host that
 *  has no `y2Label`, so the existing IR/MALDI/GC-MS figures are unchanged. */
export type SeriesAxis = "y" | "y2";

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
  /** Connected line vs. vertical stems (defaults to "line"). */
  kind: SeriesKind;
  /** Which y-axis this series is drawn against. Defaults to the left ("y"). */
  axis: SeriesAxis;
}

/** Styling for the data-anchored peak labels (see {@link PeakLabelDatum}). */
export interface PeakLabelOptions {
  show: boolean;
  fontSize: number;
  color: string;
  bold: boolean;
  /**
   * Decimal places when auto-formatting the anchor's x (e.g. m/z). `-1` uses the
   * host-supplied {@link PeakLabelDatum.text} verbatim instead.
   */
  decimals: number;
  /** Rotation in degrees (0 = horizontal; -90 reads upward — fits dense peaks). */
  rotation: number;
  /** Gap in px between the point apex and the label. */
  offset: number;
  /** Draw at most this many labels — the most intense survive. */
  maxLabels: number;
  /** Minimum horizontal spacing in px between kept labels (thins crowding). */
  minGap: number;
  /**
   * Colour each label by its owning series ({@link PeakLabelDatum.seriesId} →
   * that series' style colour) instead of the single {@link color}. A per-datum
   * {@link PeakLabelDatum.color} still wins over both.
   */
  colorBySeries: boolean;
  /**
   * Nudge auto-placed labels vertically so their boxes don't overlap each other.
   * {@link minGap} only thins labels that are close in x, which is enough for a
   * spectrum's ladder but not for a figure whose labels are all pinned (custom
   * text bypasses thinning) — a TGA overlay draws an onset/Td/Tmax callout per
   * run and they land on top of one another. Off by default so the spectrum
   * hosts render exactly as before; a label the user has dragged is never moved
   * by this and instead acts as a fixed obstacle.
   */
  declutter: boolean;
  /**
   * Figure-only per-label overrides (placement nudge + hide), keyed by
   * {@link PeakLabelDatum.id}. A label carrying an override — or a custom
   * colour/text, or the current selection — bypasses thinning so an edit can't
   * silently drop it. Default `{}`.
   */
  overrides: Record<string, PeakLabelOverride>;
}

/** How a legend row's colour key is drawn: a line sample or a filled dot. */
export type LegendMarker = "line" | "dot";

/**
 * Per-series legend overrides, keyed by {@link SeriesStyle.id}. Both fields are
 * absent by default, which is what makes the legend derive itself from the
 * series (an entry per visible series, named by the series).
 */
export interface LegendEntryOverride {
  /**
   * Force this series into (`true`) or out of (`false`) the legend, overriding
   * the default rule "a series is in the legend when it is visible". Lets the
   * legend name a subset — e.g. one entry per polymer in a MALDI figure whose
   * stick series also include per-peak colour splits.
   */
  show?: boolean;
  /** Legend wording for this series, replacing {@link SeriesStyle.label}. Empty
   *  or absent falls back to the series' own label. */
  text?: string;
}

/**
 * A legend row that keys something the figure does not draw as a series: a
 * shading convention, a marker the analyst added by hand, a note about a few
 * specific peaks ("* = matrix cluster"). The per-series {@link LegendEntryOverride}
 * can only rename or hide rows that already exist, so without this there was no
 * way to say anything in the legend that wasn't a series name.
 *
 * Notes are drawn after the series rows, in order, and flow into the legend's
 * extra columns exactly like series rows do.
 */
export interface LegendNote {
  /** Stable id — the React key and the target of edits. */
  id: string;
  /** Row wording. Blank notes are skipped, so a half-typed row never renders. */
  text: string;
  /** Key colour, or `null` for a row of plain text with no colour key at all. */
  color: string | null;
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
  /** Colour key glyph: a line sample (default) or a filled dot. */
  marker: LegendMarker;
  /** Per-series show/rename overrides — see {@link LegendEntryOverride}. The
   *  colour is deliberately NOT overridable: the legend is a key to the data, so
   *  it always shows the series' own colour. Default `{}`. */
  entries: Record<string, LegendEntryOverride>;
  /** Extra rows that key something other than a series — see {@link LegendNote}.
   *  Default `[]`. */
  notes: LegendNote[];
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
  /**
   * PNG export scale multiplier (1×, 2×, …). Lives in the options rather than
   * the `FigureMaker` so it survives the {@link FigurePopout} dialog unmounting
   * and any host-level tab switch — the same reason the rest of the styling
   * lives here. SVG export is vector and ignores this. Optional so raw
   * {@link FigureOptions} construction (tests, new hosts) does not have to
   * supply it; {@link FigureMaker} falls back to `2` when unset.
   * {@link defaultFigureOptions} still seeds `2`.
   */
  pngScale?: number;
  background: "white" | "transparent";
  reversedX: boolean;
  /**
   * Draw every `kind: "sticks"` series in this one colour instead of its own.
   * `null` (the default) leaves each stick series in its series colour.
   *
   * This is what separates "colour the labels by series" from "colour the
   * spectrum by series": with a uniform stick colour the peaks stay a single
   * neutral colour while the labels and the legend still carry each ladder's
   * colour. Line series are never affected.
   */
  stickColor: string | null;
  /** Plot frame: the border box around the plot area, plus the tick marks. */
  frameShow: boolean;
  frameColor: string;
  frameWidth: number;
  /** Axis label + tick label text colour and weight. */
  axisColor: string;
  axisBold: boolean;
  x: AxisOptions;
  y: AxisOptions;
  /**
   * Right-hand secondary y-axis. Present only when the data supplies a
   * {@link FigureData.y2Label} (or a host seeds one); every IR/MALDI/GC-MS
   * figure has this `undefined` and renders exactly as before. Gridlines are
   * off by default for y2 — two gridded axes double-draw the same plot.
   */
  y2?: AxisOptions | null;
  series: SeriesStyle[];
  legend: LegendOptions;
  /** Data-anchored peak labels (m/z values etc.); inert unless the host supplies
   *  {@link FigureData.peakLabels}. */
  peakLabels: PeakLabelOptions;
}

// --- defaults ------------------------------------------------------------------

/** Distinct line colours, cycled across series (shared with the analysis views). */
export const PALETTE = [
  "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#ea580c", "#0d9488",
  "#9333ea", "#ca8a04", "#0284c7", "#e11d48", "#4f46e5",
];

export const FONT_FAMILIES = ["Arial", "Times New Roman", "Georgia", "Courier New"];

export function defaultAxisOptions(label: string, showGrid: boolean): AxisOptions {
  return {
    label,
    min: null,
    max: null,
    tickCount: null,
    decimals: null,
    showTickLabels: true,
    showGrid,
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
    kind: hints.kind ?? "line",
    axis: hints.axis ?? "y",
  };
}

/**
 * A host's own starting values for {@link defaultFigureOptions}. Hosts differ in
 * what a *sensible* figure looks like — a MALDI stick spectrum wants diagonal
 * m/z labels packed tightly and no gridlines, an IR overlay does not — so each
 * host states its preferences here instead of them becoming everyone's defaults.
 * Everything omitted keeps the shared default below.
 */
export interface FigureOptionSeed {
  fontFamily?: string;
  width?: number;
  height?: number;
  pngScale?: number;
  /** Initial gridline visibility, applied to BOTH axes. */
  showGrid?: boolean;
  /** Initial figure background. Defaults to "white". */
  background?: "white" | "transparent";
  /** Initial bold weight for the axis + tick labels. Defaults to false. */
  axisBold?: boolean;
  legend?: Partial<LegendOptions>;
  peakLabels?: Partial<PeakLabelOptions>;
  /**
   * Host-supplied overrides for the optional right-hand (y2) axis. Only applied
   * when the data carries a {@link FigureData.y2Label}; absent hosts never get
   * a y2 axis, so this is inert for IR/MALDI/GC-MS.
   */
  y2?: Partial<AxisOptions>;
  /**
   * Derive `peakLabels.decimals` from the data instead of pinning it, capped at
   * this many places. See {@link peakLabelDecimalsFromData}. Wins over
   * `peakLabels.decimals` whenever the data actually has labels to measure.
   *
   * This is for hosts whose precision is a property of the FILE, not of the
   * host: a GC/MS run can be nominal-mass quadrupole data (m/z 43, 91) or TOF
   * data resolved to 337.2858, and neither a fixed 0 nor a fixed 4 reads well
   * on the other. `useFigureOptions` re-derives it as the label set changes.
   */
  autoPeakLabelDecimals?: number;
}

/**
 * The decimal places the data itself carries, capped at `max` — the precision a
 * peak label can show without either inventing digits or dropping real ones.
 *
 * Measured off each label's anchor value via `String(x)`, which prints the
 * shortest decimal that round-trips: an m/z of exactly 43.05 reports 2, while a
 * computed TOF centroid (337.28571…) reports far more and so lands on the cap.
 * Values in exponent form are treated as full precision — they are far from the
 * magnitudes a peak label is written in, so guessing low would lose digits.
 *
 * `customText` labels are skipped: `decimals` never reformats those, and their
 * anchor may not even be the quantity on show — GC/MS's stacked figure projects
 * a retention time onto the spectrum's m/z axis and keeps the real RT as text,
 * so measuring that anchor would report a precision nothing is drawn at.
 */
export function peakLabelDecimalsFromData(data: FigureData, max: number): number | null {
  let best: number | null = null;
  for (const p of data.peakLabels ?? []) {
    if (p.customText || !Number.isFinite(p.x)) continue;
    const s = String(p.x);
    if (s.includes("e") || s.includes("E")) return max;
    const dot = s.indexOf(".");
    const places = dot < 0 ? 0 : s.length - dot - 1;
    if (best === null || places > best) best = places;
    if (best >= max) return max;
  }
  return best;
}

/** Initial options seeded from the data (labels, palette colours, style hints),
 *  with any host preferences from `seed` layered on top. */
export function defaultFigureOptions(data: FigureData, seed: FigureOptionSeed = {}): FigureOptions {
  // Auto-show the legend for a modest multi-series figure. A MALDI stick figure
  // can emit one series per assigned ladder (see the MALDI adapter's
  // `seriesGroups`), so a flat cap of 12 would silently default the legend off
  // once a sample carries many ladders — the one thing that legend is there to
  // tell apart. Lift the ceiling when any stick series is present (a MALDI-only
  // signal; IR/Kinetics never emit `kind: "sticks"`, so their seeding is
  // unchanged). (WP6d)
  const hasSticks = data.series.some((s) => s.styleHints?.kind === "sticks");
  const legendCap = hasSticks ? 40 : 12;
  const showGrid = seed.showGrid ?? true;
  const autoDecimals =
    seed.autoPeakLabelDecimals == null
      ? null
      : peakLabelDecimalsFromData(data, seed.autoPeakLabelDecimals);
  return {
    title: "",
    titleFontSize: 18,
    fontFamily: seed.fontFamily ?? "Arial",
    axisFontSize: 14,
    tickFontSize: 12,
    width: seed.width ?? 900,
    height: seed.height ?? 560,
    pngScale: seed.pngScale ?? 2,
    background: seed.background ?? "white",
    reversedX: data.reversedX ?? false,
    stickColor: null,
    frameShow: true,
    frameColor: "#334155",
    frameWidth: 1,
    axisColor: "#0f172a",
    axisBold: seed.axisBold ?? false,
    x: defaultAxisOptions(data.xLabel, showGrid),
    y: defaultAxisOptions(data.yLabel, showGrid),
    // The right-hand secondary axis exists only when the data carries a
    // y2Label — IR/MALDI/GC-MS never set one, so their options are byte-for-byte
    // the same as before (no `y2` key at all). Grid is off for y2 by default:
    // two gridded axes double-draw the same plot area. A host's `seed.y2`
    // patches the seeded axis (label overrides, a manual range, etc.).
    y2: data.y2Label
      ? { ...defaultAxisOptions(data.y2Label, false), ...seed.y2 }
      : undefined,
    series: data.series.map(defaultSeriesStyle),
    legend: {
      show: data.series.length > 1 && data.series.length <= legendCap,
      position: "top-right",
      custom: null,
      fontSize: 12,
      frame: true,
      marker: "line",
      entries: {},
      notes: [],
      ...seed.legend,
    },
    peakLabels: {
      show: (data.peakLabels?.length ?? 0) > 0,
      fontSize: 10,
      color: "#0f172a",
      bold: false,
      decimals: 2,
      rotation: 0,
      offset: 6,
      maxLabels: 25,
      minGap: 26,
      colorBySeries: false,
      declutter: false,
      overrides: {},
      ...seed.peakLabels,
      // After the seed spread: an auto cap is a stronger statement than a pinned
      // default. It only applies once there are labels to measure — a host that
      // mounts its figure before any data (MALDI's and GC/MS's Figure tabs are
      // built from empty state) keeps the seeded value until then, and
      // `useFigureOptions` re-derives this when the labels arrive.
      ...(autoDecimals === null ? {} : { decimals: autoDecimals }),
    },
  };
}

/**
 * Layer a persisted `saved` options object over a freshly-built `base`, so
 * options that were written to storage before a field existed (or by a newer
 * build that has since dropped one) still deserialize into a complete
 * {@link FigureOptions}. The nested groups are merged one level deep — a whole
 * missing `legend`/`peakLabels`/axis block falls back to `base` wholesale, and a
 * present one keeps `base`'s value for each key it lacks.
 *
 * `series` is taken from `saved` verbatim when present: the caller reconciles it
 * against the live data (see {@link reconcileFigureOptions}), which is the only
 * thing that can tell a stale series id from a real one.
 */
export function mergeSavedFigureOptions(
  base: FigureOptions,
  saved: Partial<FigureOptions> | null | undefined,
): FigureOptions {
  if (!saved) return base;
  // The right-hand y2 axis is optional on both sides: a saved record may predate
  // y2 (older snapshot), and a host may have closed the only series using it.
  // Merge only when one side actually has one; otherwise inherit the base.
  const y2 =
    saved.y2 === undefined
      ? base.y2
      : saved.y2 && base.y2
        ? { ...base.y2, ...saved.y2 }
        : saved.y2 ?? base.y2;
  return {
    ...base,
    ...saved,
    x: { ...base.x, ...saved.x },
    y: { ...base.y, ...saved.y },
    y2,
    series: saved.series ?? base.series,
    legend: {
      ...base.legend,
      ...saved.legend,
      entries: saved.legend?.entries ?? {},
      notes: saved.legend?.notes ?? [],
    },
    peakLabels: {
      ...base.peakLabels,
      ...saved.peakLabels,
      overrides: saved.peakLabels?.overrides ?? {},
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

/**
 * Drop peak-label overrides whose peak id is gone from the data. Peak ids are
 * `crypto.randomUUID()`s minted afresh on every re-pick (they do not survive
 * re-picking), so without this a re-pick would leave placement/hide entries
 * keyed by dead ids to accumulate forever — and, worse, a *new* peak that
 * happened to reuse an id would inherit a stranger's placement. We deliberately
 * do NOT re-bind by rounded m/z: a shifted centroid would silently mis-apply
 * another peak's override. The trade-off (re-picking resets label placement) is
 * surfaced to the user in the controls. Overrides for surviving ids are kept
 * verbatim; the previous object is returned unchanged when nothing is dropped so
 * callers can skip a needless state update.
 */
export function reconcilePeakLabelOverrides(
  prev: Record<string, PeakLabelOverride>,
  data: FigureData,
): Record<string, PeakLabelOverride> {
  const ids = new Set((data.peakLabels ?? []).map((p) => p.id));
  let dropped = false;
  const next: Record<string, PeakLabelOverride> = {};
  for (const [id, ov] of Object.entries(prev)) {
    if (ids.has(id)) next[id] = ov;
    else dropped = true;
  }
  return dropped ? next : prev;
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

/**
 * The largest box with the figure's aspect ratio that fits inside `area`.
 *
 * The fullscreen preview needs this because `max-height` on an inline `<svg>`
 * clamps the height WITHOUT narrowing the width: the element box stops matching
 * the viewBox and the drawing letterboxes inside it. That is not only ugly —
 * `FigureSvg` maps pointer coordinates through the element's bounding box, so a
 * letterboxed figure takes drag-zooms and label drags at the wrong place.
 *
 * Scaling UP is allowed: the preview is vector and every font size scales with
 * it, so a magnified preview is the same figure, just bigger. Returns null when
 * the area has not been measured yet (zero width or height).
 */
export function fitFigureBox(
  area: { w: number; h: number },
  figure: { width: number; height: number },
): { width: number; height: number } | null {
  if (!(area.w > 0) || !(area.h > 0)) return null;
  if (!(figure.width > 0) || !(figure.height > 0)) return null;
  const scale = Math.min(area.w / figure.width, area.h / figure.height);
  return { width: figure.width * scale, height: figure.height * scale };
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
 * Index span `[start, end]` (inclusive) of the points whose x falls within
 * `[lo, hi]`, padded by one point on each side so a clipped line still reaches
 * the plot edges. Assumes x is ascending (true for spectra and IR grids); if it
 * is not, the full range `[0, n-1]` is returned so callers draw everything
 * rather than clip incorrectly. An empty array yields `[0, -1]` (an empty
 * slice). This lets the preview decimate only the *visible* window when zoomed
 * in, which is what reveals fine structure such as isotope envelopes — a global
 * decimation would collapse them long before you could zoom to them.
 */
export function windowSlice(x: number[], lo: number, hi: number): [number, number] {
  const n = x.length;
  if (n === 0) return [0, -1];
  const first = x[0];
  const last = x[n - 1];
  if (!(Number.isFinite(first) && Number.isFinite(last)) || first > last) {
    return [0, n - 1]; // not ascending / unusable → don't clip
  }
  // Lower bound: first index with x >= lo.
  let a = 0;
  let b = n;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (x[mid] < lo) a = mid + 1;
    else b = mid;
  }
  const loIdx = a;
  // Upper bound: last index with x <= hi.
  a = 0;
  b = n;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (x[mid] <= hi) a = mid + 1;
    else b = mid;
  }
  const hiIdx = a - 1;
  return [Math.max(0, loIdx - 1), Math.min(n - 1, hiIdx + 1)];
}

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

/**
 * SVG path `d` for a stick/stem series: an isolated vertical segment from
 * `baseY` (the projected baseline) up to each finite point. Used for centroid /
 * stick mass spectra. Non-finite points are skipped (no stem). Unlike a line
 * series these are never decimated — stick data is already the sparse peak set.
 */
export function sticksPathD(
  x: number[],
  y: number[],
  sx: (v: number) => number,
  sy: (v: number) => number,
  baseY: number,
): string {
  const n = Math.min(x.length, y.length);
  const r = (v: number) => Math.round(v * 100) / 100;
  const b = r(baseY);
  let d = "";
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
    const px = r(sx(x[i]));
    d += `M${px} ${b}L${px} ${r(sy(y[i]))}`;
  }
  return d;
}

/**
 * Thin a crowded set of labels to the ones worth drawing: take the most intense
 * first (highest `weight`), keep one only if no already-kept label sits within
 * `minGap` px of it, and stop at `maxLabels`. Returns the kept items in their
 * original order. Operates on already-projected x-pixels so it is pure and
 * testable independent of the renderer.
 *
 * A `pinned` item (one the user has edited/selected — see WP5b) is always kept:
 * it bypasses both the `maxLabels` cap and the `minGap` rejection, so editing a
 * label can never make it vanish. Pinned items still seed the kept-position set
 * so an auto-picked label is not placed on top of one, and they do not consume
 * the cap (the cap governs only the auto-thinned remainder).
 */
export function pickVisibleLabels<T extends { px: number; weight: number; pinned?: boolean }>(
  items: T[],
  maxLabels: number,
  minGap: number,
): T[] {
  if (items.length === 0) return [];
  const cap = Math.max(0, Math.floor(maxLabels));
  const gap = Math.max(0, minGap);
  const keptPx: number[] = [];
  const kept: { item: T; order: number }[] = [];

  // Pinned labels first — unconditionally kept, and their positions block the
  // gap check for the auto-picked ones below.
  items.forEach((item, order) => {
    if (item.pinned) {
      keptPx.push(item.px);
      kept.push({ item, order });
    }
  });

  // Auto-thin the rest by weight (taller peaks first) under the cap + gap.
  const ranked = items
    .map((item, order) => ({ item, order }))
    .filter((e) => !e.item.pinned)
    .sort((a, b) => b.item.weight - a.item.weight);
  let picked = 0;
  for (const entry of ranked) {
    if (picked >= cap) break;
    const px = entry.item.px;
    if (gap > 0 && keptPx.some((k) => Math.abs(k - px) < gap)) continue;
    keptPx.push(px);
    kept.push(entry);
    picked += 1;
  }
  return kept.sort((a, b) => a.order - b.order).map((e) => e.item);
}
