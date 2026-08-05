import { useEffect, useMemo, useRef } from "react";
import type { MutableRefObject } from "react";
import uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import { layoutLabels, type LabelInput, type PlacedLabel } from "@/lib/gcms/annotate";
import {
  applyOffset,
  downsample,
  normalizeTrace,
  resampleOntoGappy,
  sliceRange,
  unionGrid,
  unionMzColumns,
} from "@/lib/gcms/view";
import type { XYSeries } from "@/lib/gcms/types";

/**
 * One trace rendered by a {@link GcmsPlot} panel. The plot draws the set of
 * VISIBLE traces; it does not care which one is ACTIVE. Selecting a trace
 * changes only what analysis acts on — the rendered picture (x range, y scale,
 * colours, offsets) is identical before and after a selection change; the only
 * visible difference is stroke emphasis (the active trace is thicker + full
 * opacity, the rest are thinner + reduced opacity). Draw order is trace order,
 * never selection order.
 */
export interface PanelTrace {
  id: string;
  label: string;
  x: Float64Array;
  y: Float64Array;
  color: string;
  visible: boolean;
  offset: number;
  /** Per-trace intensity gain applied in `buildData` before `offset` and
   *  before the stack accumulator. Optional because the spectrum panel's
   *  traces (MassSpectrum-derived) have no gain concept; `undefined` (like a
   *  non-finite or zero value) is treated as 1 — see `scaleColumn`. */
  scale?: number;
  /** Data-space floor for a stick series. Stacked spectra are translated
   * upward by `buildData`; carrying the same translated floor here prevents
   * each stem from being drawn all the way down to zero. */
  baseline?: number;
  width: number;
}

/** An integration / chromatographic marker drawn over the plot. */
export interface PlotMarker {
  x: number;
  y: number;
  kind: "start" | "end" | "apex";
  color: string;
}

export interface GcmsPlotProps {
  axis: "rt" | "mz";
  xLabel: string;
  title: string;
  traces: PanelTrace[];
  activeTraceId: string | null;
  drawMode: "line" | "stick";
  annotations: LabelInput[];
  markers: PlotMarker[];
  /**
   * Fraction of the CURRENT resolved y-scale max (`u.scales.y.max`, which the
   * wheel handler shrinks/grows on every scroll) below which an annotation is
   * dropped before layout even sees it. Deliberately relative to the
   * *resolved* scale, not the global data maximum, so scrolling up (which
   * lowers `scales.y.max`) automatically lowers the bar and reveals smaller
   * peaks' labels — "show fewer peaks, then more as you zoom/scroll" falls
   * out of this for free with no extra state. Defaults to 0.04 (spectrum);
   * {@link ChromatogramPanel} passes a lower ~0.02 since chromatogram peaks
   * are already a curated (detected/integrated) set, not a raw top-N list.
   */
  labelFloorFrac?: number;
  /**
   * When true, the "apex" triangles are derived from the labels this plot
   * actually PLACED (post view-filter, post `layoutLabels`) instead of from
   * the `markers` prop — so the triangle count stays automatically
   * consistent with the view-dependent label density from `labelFloorFrac`
   * (fewer labels visible => fewer triangles, and vice versa). `start`/`end`
   * tick markers from `markers` are unaffected and still drawn. Defaults to
   * false (the chromatogram panel's apex/start/end markers keep coming
   * straight from `markers`, since chromatogram peaks are already a small,
   * curated set).
   */
  markersFromLabels?: boolean;
  cursorX: number | null;
  /** Zero or more highlighted RT/mz windows (Phase 4 task D: multi-region
   *  select). Rendered as one selection band per entry — see `drawOverlays`. */
  selections: [number, number][];
  /** Parallel to `selections` — the colour to fill each band with (falls back
   *  to the theme's primaryAlpha when missing/shorter than `selections`).
   *  Lets the chromatogram band for a region match that region's spectrum
   *  panel swatch, so with several stacked spectra it's clear which band
   *  belongs to which panel. */
  selectionColors?: string[];
  background: [number, number] | null;
  normalize: boolean;
  stacked: boolean;
  logY: boolean;
  /**
   * Fixed x-domain override (Phase 4 task C). When set, this REPLACES the
   * per-render union-of-visible-traces domain the rebuild effect otherwise
   * computes, and feeds `domainKey` — so the spectrum panel's zoom/pan state
   * survives a scan change (a new scan is still the SAME domain, e.g. the
   * run's `mzRange`) instead of being recomputed (and reset) from that one
   * scan's own m/z span every time the cursor moves. Only meaningful for
   * "mz" axis panels; the chromatogram panel doesn't pass it.
   */
  xDomain?: [number, number];
  /** Floor for the plot's own height, in px. The plot otherwise FILLS its
   *  parent via CSS (`h-full`) — it deliberately does NOT take a measured pixel
   *  height as a prop, because routing the panel height through React state
   *  (ResizeObserver -> setState -> inline style) leaves the plot stuck at the
   *  initial value whenever RO delivery is delayed or suspended. */
  minHeight?: number;
  /** When set, overrides the modifier-key detection so a drag always acts as
   *  this mode (the toolbar segmented control). "auto" (default) falls back to
   *  the Shift/Ctrl modifier detection. */
  dragMode?: "auto" | "zoom" | "select" | "background";
  /** Optional ref the plot assigns a PNG-capture function to. The function
   *  snapshots the rendered canvas (at the user's current view) as a PNG data
   *  URL, or returns null when the plot has no data. The optional `scale`
   *  argument multiplies the canvas resolution (2 = 2x), honouring the export
   *  scale selector; it defaults to 1 (the on-screen size). */
  captureRef?: MutableRefObject<((scale?: number) => string | null) | null>;
  onHover(x: number | null, idx: number | null): void;
  onClick(x: number, modifiers: { shift: boolean; ctrl: boolean }): void;
  /**
   * `additive` is true when Shift was held during the drag (independent of
   * which `mode` was resolved — including when `dragMode` forces a fixed
   * mode via the toolbar segmented control). Phase 4 task D: a "select"-mode
   * drag with `additive` true APPENDS a new region instead of replacing the
   * existing selection(s).
   */
  onSelectRange(
    lo: number,
    hi: number,
    mode: "zoom" | "select" | "background",
    additive: boolean,
  ): void;
  /**
   * Click-to-pick (Phase 3 task C): fired when a click lands within ~8
   * (canvas-pixel) px of a VISIBLE series' rendered y at the clicked x, ahead
   * of the ordinary `onClick` pin. Optional and gated on being supplied — the
   * spectrum panel passes nothing, so its click handling is unaffected.
   */
  onPickTrace?(id: string): void;
  /**
   * Shift+wheel (Phase 3 task D): fired instead of the plain-wheel y-axis
   * scale when Shift is held, with `factor` the per-notch multiplier (1.25 up,
   * 1/1.25 down) to apply to the ACTIVE trace's `scale` alone. Optional and
   * gated on being supplied, same as `onPickTrace`.
   */
  onScaleTrace?(id: string, factor: number): void;
}

// --- Theme tokens -----------------------------------------------------------
// The plot reads the app's CSS variables (HSL component triples like
// "190 90% 38%") and wraps them with hsl(...) for canvas use. Re-read whenever
// the <html> class attribute mutates (the app toggles `.dark`), so the panel
// looks native in BOTH light and dark mode. NO hard-coded colours anywhere
// except the per-trace `color` the caller supplies.
interface ThemeTokens {
  border: string;
  mutedFg: string;
  fg: string;
  bg: string;
  primary: string;
  primaryAlpha: string; // primary at low alpha for the selection band
  bgAlpha: string; // primary at a more muted alpha for the background band
}

function hslVar(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return "";
  // raw is like "190 90% 38%"; wrap with hsl(...). If it already starts with
  // "hsl" (a future-proofing fallback) leave it alone.
  if (raw.startsWith("hsl")) return raw;
  return `hsl(${raw})`;
}

function hslVarAlpha(name: string, alpha: number): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return "";
  if (raw.startsWith("hsl")) return raw;
  return `hsl(${raw} / ${alpha})`;
}

function readTheme(): ThemeTokens {
  return {
    border: hslVar("--border") || "hsl(214 25% 88%)",
    mutedFg: hslVar("--muted-foreground") || "hsl(215 16% 45%)",
    fg: hslVar("--foreground") || "hsl(222 47% 11%)",
    bg: hslVar("--card") || "hsl(0 0% 100%)",
    primary: hslVar("--primary") || "hsl(190 90% 38%)",
    primaryAlpha: hslVarAlpha("--primary", 0.15) || "hsla(190, 90%, 38%, 0.15)",
    bgAlpha: hslVarAlpha("--primary", 0.06) || "hsla(190, 90%, 38%, 0.06)",
  };
}

// Compact y-axis tick label (e.g. 3.0M, 12k, 0.42) so wide numbers don't run
// over the rotated axis label.
function compactNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1)}G`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  if (a === 0) return "0";
  if (a < 1) return v.toFixed(2);
  return `${Math.round(v)}`;
}

/** Composite the rendered plot canvas with a wrapped trace legend. The live
 * DOM legend sits outside uPlot and was previously absent from standalone PNG
 * exports, which made separated XIC colours impossible to map back to m/z. */
function plotPngWithLegend(
  source: HTMLCanvasElement,
  plotCssWidth: number,
  traces: PanelTrace[],
  theme: ThemeTokens,
): string {
  const visible = traces.filter((trace) => trace.visible);
  if (visible.length <= 1) return source.toDataURL("image/png");

  const pixelRatio = source.width / Math.max(1, plotCssWidth);
  const pad = 8 * pixelRatio;
  const gap = 14 * pixelRatio;
  const swatch = 9 * pixelRatio;
  const lineHeight = 18 * pixelRatio;
  const fontSize = 11 * pixelRatio;
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return source.toDataURL("image/png");
  probe.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;

  const items: { trace: PanelTrace; x: number; row: number; width: number }[] = [];
  let cursor = pad;
  let row = 0;
  const maxItemWidth = Math.max(40 * pixelRatio, source.width - pad * 2);
  for (const trace of visible) {
    const width = Math.min(maxItemWidth, swatch + 5 * pixelRatio + probe.measureText(trace.label).width);
    if (cursor > pad && cursor + width > source.width - pad) {
      row += 1;
      cursor = pad;
    }
    items.push({ trace, x: cursor, row, width });
    cursor += width + gap;
  }

  const legendHeight = pad * 2 + (row + 1) * lineHeight;
  const output = document.createElement("canvas");
  output.width = source.width;
  output.height = source.height + legendHeight;
  const ctx = output.getContext("2d");
  if (!ctx) return source.toDataURL("image/png");
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, output.width, output.height);
  ctx.drawImage(source, 0, 0);
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = Math.max(1, pixelRatio);
  ctx.beginPath();
  ctx.moveTo(0, source.height + 0.5 * pixelRatio);
  ctx.lineTo(output.width, source.height + 0.5 * pixelRatio);
  ctx.stroke();
  ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  for (const item of items) {
    const y = source.height + pad + item.row * lineHeight + lineHeight / 2;
    ctx.fillStyle = item.trace.color;
    ctx.fillRect(item.x, y - swatch / 2, swatch, swatch);
    ctx.fillStyle = theme.mutedFg;
    ctx.fillText(
      item.trace.label,
      item.x + swatch + 5 * pixelRatio,
      y,
      Math.max(1, item.width - swatch - 5 * pixelRatio),
    );
  }
  return output.toDataURL("image/png");
}

/** Median of a sorted-ish ascending series' x spacings (used as maxGap basis). */
function medianSpacing(x: Float64Array): number {
  const n = x.length;
  if (n < 2) return 1;
  // For typed arrays of modest size, compute the median of consecutive diffs.
  // Allocates a small number[] — fine for the chromatogram sizes we see.
  const diffs: number[] = [];
  for (let i = 1; i < n; i += 1) {
    const d = x[i] - x[i - 1];
    if (Number.isFinite(d) && d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return 1;
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1] || 1;
}

/**
 * Multiply a y column by a trace's `scale` (Phase 3 task B). A
 * missing/zero/non-finite value is treated as 1 (unscaled) rather than
 * propagating `undefined`/`NaN`/a zeroed-out column into the plot.
 *
 * MUST run before `applyOffset` and before the stack accumulator in
 * `buildData` reads the column's max: offset is an ADDITIVE shift applied
 * once at the end, so scaling after it would scale the offset too (a trace
 * offset by +1000 and then "scaled" 2x would jump to +2000, not stay put);
 * and the stack accumulator sizes the gap it leaves for the traces above a
 * trace from that trace's (pre-offset) max, so scaling after the accumulator
 * has already read it would leave the gap sized for the UNSCALED height while
 * the drawn peak is taller/shorter, letting an overlapping trace clip into it
 * or leaving a needless gap.
 *
 * Per the `view.ts` purity contract this module already follows: returns the
 * INPUT array unchanged when the effective scale is 1 (the common case, no
 * allocation), and otherwise always allocates a fresh `Float64Array` — it
 * never mutates `col` (which may itself be `normalizeTrace`'s or
 * `resampleOntoGappy`'s return value) in place.
 */
function scaleColumn(col: Float64Array, scale: number | undefined): Float64Array {
  const s = scale != null && Number.isFinite(scale) && scale !== 0 ? scale : 1;
  if (s === 1) return col;
  const out = new Float64Array(col.length);
  for (let i = 0; i < col.length; i += 1) out[i] = col[i] * s;
  return out;
}

/** Build the uPlot data array `[grid, ...columns]` for a given x view window. */
function buildData(
  traces: PanelTrace[],
  axis: "rt" | "mz",
  drawMode: "line" | "stick",
  lo: number,
  hi: number,
  plotWidthPx: number,
  normalize: boolean,
  stacked: boolean,
): AlignedData {
  const visible = traces.filter((t) => t.visible && t.x.length > 0);
  const cols: (number[] | Float64Array)[] = [];

  if (visible.length === 0) {
    // Empty plot: still return one column per trace so series indices are
    // stable across visibility toggles.
    cols.push(new Float64Array(0));
    for (let i = 0; i < traces.length; i += 1) cols.push(new Float64Array(0));
    return cols as unknown as AlignedData;
  }

  let grid: Float64Array;
  if (drawMode === "line") {
    // RT line axis. Two paths:
    //  - SINGLE visible trace: sliceRange + downsample (min/max envelope) so
    //    narrow peaks survive a heavy downsample — pixel-identical to drawing
    //    the trace itself.
    //  - TWO OR MORE visible traces: unionGrid of every visible trace, each
    //    resampled with a per-trace gap break (~3x its median spacing) so a run
    //    that stops early breaks the line instead of drawing a straight bridge.
    //    When that union grid is denser than ~2x the plot width, a uniform
    //    decimated grid spanning the window replaces it (the min/max envelope
    //    would give each trace a different x grid and desync the columns).
    const maxPoints = Math.max(2, plotWidthPx * 2);
    if (visible.length === 1) {
      const t = visible[0];
      let windowed =
        lo < hi && (lo > t.x[0] || hi < t.x[t.x.length - 1])
          ? sliceRange({ x: t.x, y: t.y }, lo, hi)
          : { x: t.x, y: t.y };
      if (windowed.x.length > maxPoints) windowed = downsample(windowed, maxPoints);
      grid = windowed.x;
      cols.push(grid);
      for (const tt of traces) {
        if (!tt.visible || tt.x.length === 0 || tt.id !== t.id) {
          cols.push(new Float64Array(grid.length).fill(NaN));
          continue;
        }
        let col = windowed.y;
        if (normalize) {
          const normed = normalizeTrace({ x: grid, y: col });
          col = normed.y;
        }
        // Scale BEFORE offset (see scaleColumn's doc comment) — no stacking
        // in this single-visible-trace branch, so there's no accumulator to
        // worry about ordering against.
        col = scaleColumn(col, tt.scale);
        col = applyOffset({ x: grid, y: col }, tt.offset).y;
        cols.push(col);
      }
      return cols as unknown as AlignedData;
    }

    const visSeries: XYSeries[] = visible.map((t) => ({ x: t.x, y: t.y }));
    grid = unionGrid(visSeries);
    // Restrict the grid to the visible x window.
    if (grid.length > 0 && (lo > grid[0] || hi < grid[grid.length - 1])) {
      const start = grid.findIndex((v) => v >= lo);
      if (start < 0) {
        cols.push(new Float64Array(0));
        for (let i = 0; i < traces.length; i += 1) cols.push(new Float64Array(0));
        return cols as unknown as AlignedData;
      }
      let end = grid.length;
      for (let i = grid.length - 1; i >= 0; i -= 1) {
        if (grid[i] <= hi) {
          end = i + 1;
          break;
        }
      }
      grid = grid.subarray(Math.max(0, start), end);
    }
    let effGrid = grid;
    if (grid.length > maxPoints) {
      const lo2 = grid.length > 0 ? grid[0] : lo;
      const hi2 = grid.length > 0 ? grid[grid.length - 1] : hi;
      const uniform = new Float64Array(maxPoints);
      const span = hi2 - lo2;
      const step = span / (maxPoints - 1);
      for (let i = 0; i < maxPoints; i += 1) uniform[i] = lo2 + i * step;
      effGrid = uniform;
    }
    cols.push(effGrid);
    // Stack offset accumulator: when stacking, each trace is raised by the
    // cumulative max of the traces below it so overlapping peaks separate.
    let stackTop = 0;
    for (const t of traces) {
      if (!t.visible || t.x.length === 0) {
        cols.push(new Float64Array(effGrid.length).fill(NaN));
        continue;
      }
      const maxGap = Math.max(medianSpacing(t.x) * 3, 1e-9);
      let col = resampleOntoGappy({ x: t.x, y: t.y }, effGrid, maxGap);
      if (normalize) {
        const normed = normalizeTrace({ x: effGrid, y: col });
        col = normed.y;
      }
      // Scale BEFORE the stack accumulator below reads this column's max (and
      // before applyOffset) — see scaleColumn's doc comment for why either
      // order would be wrong.
      col = scaleColumn(col, t.scale);
      let offset = t.offset;
      if (stacked) {
        offset += stackTop;
        let m = 0;
        for (let i = 0; i < col.length; i += 1) {
          const v = col[i];
          if (Number.isFinite(v) && v > m) m = v;
        }
        stackTop += m;
      }
      col = applyOffset({ x: effGrid, y: col }, offset).y;
      cols.push(col);
    }
    return cols as unknown as AlignedData;
  }

  // Stick axis (mz): EXACT union — no interpolation, no downsampling, so
  // centroid sticks are never smeared.
  const visSeries: XYSeries[] = visible.map((t) => ({ x: t.x, y: t.y }));
  const { grid: mzGrid, columns: mzCols } = unionMzColumns(visSeries);
  grid = mzGrid;
  cols.push(grid);
  let stackTop = 0;
  let visIdx = 0;
  for (const t of traces) {
    if (!t.visible || t.x.length === 0) {
      cols.push(new Float64Array(grid.length).fill(NaN));
      continue;
    }
    let col = mzCols[visIdx];
    if (normalize) {
      const normed = normalizeTrace({ x: grid, y: col });
      col = normed.y;
    }
    // Scale BEFORE the stack accumulator below reads this column's max (and
    // before applyOffset) — see scaleColumn's doc comment for why either
    // order would be wrong.
    col = scaleColumn(col, t.scale);
    let offset = t.offset;
    if (stacked) {
      offset += stackTop;
      let m = 0;
      for (let i = 0; i < col.length; i += 1) {
        const v = col[i];
        if (Number.isFinite(v) && v > m) m = v;
      }
      stackTop += m;
    }
    col = applyOffset({ x: grid, y: col }, offset).y;
    cols.push(col);
    visIdx += 1;
  }
  return cols as unknown as AlignedData;
}

// Axis font: uPlot's own default font-family string (see uPlot.cjs.js), just
// at 10px instead of the default 12px — part of the Phase 1 "double the
// usable plot area" pass (smaller axis furniture -> more canvas for data).
// `labelFont` mirrors uPlot's own convention of bolding the axis label.
const AXIS_FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';
const AXIS_FONT = `10px ${AXIS_FONT_FAMILY}`;
const AXIS_LABEL_FONT = `bold 10px ${AXIS_FONT_FAMILY}`;

/** Max positive y across every visible column (NaN and negatives skipped). */
function windowMax(data: AlignedData, traces: PanelTrace[]): number {
  let m = 0;
  for (let s = 1; s < data.length; s += 1) {
    const tr = traces[s - 1];
    if (tr && !tr.visible) continue;
    const ys = data[s] as ArrayLike<number>;
    for (let i = 0; i < ys.length; i += 1) {
      const v = ys[i];
      if (Number.isFinite(v) && v > m) m = v;
    }
  }
  return m;
}

/**
 * uPlot 1.6.32 panel shared by the GC/MS chromatogram (line) and spectrum
 * (stick) panels. Implements the nine uPlot rules documented above; see the
 * inline comments for which rule is applied where.
 */
export function GcmsPlot(props: GcmsPlotProps): JSX.Element {
  const {
    axis,
    xLabel,
    title,
    traces,
    activeTraceId,
    drawMode,
    annotations,
    markers,
    labelFloorFrac = 0.04,
    markersFromLabels = false,
    cursorX,
    selections,
    selectionColors,
    background,
    normalize,
    stacked,
    logY,
    minHeight = 220,
    dragMode,
    xDomain,
    captureRef,
    onHover,
    onClick,
    onSelectRange,
    onPickTrace,
    onScaleTrace,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Hover readout written straight to the DOM (not React state) so moving the
  // mouse never re-renders this component — the performance rule.
  const readoutRef = useRef<HTMLSpanElement>(null);
  // Refs read inside the uPlot draw hook / setCursor hook so we can redraw
  // without recreating the instance.
  const annotationsRef = useRef(annotations);
  const markersRef = useRef(markers);
  const labelFloorFracRef = useRef(labelFloorFrac);
  const markersFromLabelsRef = useRef(markersFromLabels);
  const cursorXRef = useRef(cursorX);
  const selectionsRef = useRef(selections);
  const selectionColorsRef = useRef(selectionColors);
  const backgroundRef = useRef(background);
  const xDomainRef = useRef(xDomain);
  const onHoverRef = useRef(onHover);
  const onClickRef = useRef(onClick);
  const onSelectRangeRef = useRef(onSelectRange);
  const onPickTraceRef = useRef(onPickTrace);
  const onScaleTraceRef = useRef(onScaleTrace);
  const tracesRef = useRef(traces);
  const activeTraceIdRef = useRef(activeTraceId);
  const normalizeRef = useRef(normalize);
  const stackedRef = useRef(stacked);
  const logYRef = useRef(logY);
  const axisRef = useRef(axis);
  const drawModeRef = useRef(drawMode);
  const xLabelRef = useRef(xLabel);
  const dragModeRef = useRef(dragMode ?? "auto");
  annotationsRef.current = annotations;
  markersRef.current = markers;
  labelFloorFracRef.current = labelFloorFrac;
  markersFromLabelsRef.current = markersFromLabels;
  cursorXRef.current = cursorX;
  selectionsRef.current = selections;
  selectionColorsRef.current = selectionColors;
  backgroundRef.current = background;
  xDomainRef.current = xDomain;
  onHoverRef.current = onHover;
  onClickRef.current = onClick;
  onSelectRangeRef.current = onSelectRange;
  onPickTraceRef.current = onPickTrace;
  onScaleTraceRef.current = onScaleTrace;
  tracesRef.current = traces;
  xLabelRef.current = xLabel;
  activeTraceIdRef.current = activeTraceId;
  normalizeRef.current = normalize;
  stackedRef.current = stacked;
  logYRef.current = logY;
  axisRef.current = axis;
  drawModeRef.current = drawMode;
  dragModeRef.current = dragMode ?? "auto";

  // Ref-backed range callbacks (RULE 5): uPlot consults these on every scale
  // commit; without them `setData(view, false)` leaves the per-series min/max
  // caches empty and an auto range resolves to nothing.
  const xRangeRef = useRef<[number, number] | null>(null);
  const yRangeRef = useRef<[number, number] | null>(null);

  // Zoom history + current view range.
  const historyRef = useRef<{ min: number; max: number }[]>([]);
  const viewRangeRef = useRef<{ min: number; max: number }>({ min: 0, max: 1 });
  const domainKeyRef = useRef<string>("");
  const applyViewRef = useRef<((lo: number, hi: number, pushHistory: boolean, preserveY?: boolean) => void) | null>(null);
  // Previous normalize/stacked values, so the re-apply-view effect below can
  // tell a MODE change (must refit Y) apart from a pure trace data change
  // (gain/offset/visibility — must NOT refit Y). See bug-8 fix.
  const prevNormalizeForViewRef = useRef(normalize);
  const prevStackedForViewRef = useRef(stacked);

  // Hover index publishing: the setCursor hook writes hoverIdxRef and the
  // readout text to the DOM; a rAF loop (started on pointerenter, cancelled on
  // pointerleave) publishes to React state ONLY when the integer index changed.
  const hoverIdxRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastPublishedIdxRef = useRef<number | null>(null);

  // Theme tokens kept in a ref so the draw hook reads the current values; a
  // MutationObserver on <html> re-reads them when the theme flips.
  const themeRef = useRef<ThemeTokens>(readTheme());

  // Modifier-key tracking for the setSelect mode decision (plain -> zoom,
  // Shift -> select, Ctrl/Cmd -> background).
  const modifiersRef = useRef({ shift: false, ctrl: false });

  // Mousedown point (+ timestamp) for click-vs-drag-release disambiguation.
  // uPlot's own `drag.click` suppression lives on a BUBBLE-phase handler on
  // `.u-wrap`; `onClickInternal` below is bound in the CAPTURE phase on
  // `plot.root` (ABOVE `.u-wrap`) specifically so uPlot's wrap-level
  // stopPropagation() can't swallow the click before we see it — but that
  // same ordering means uPlot's drag-click suppression never gets a chance
  // to run first, so a mouseup that ends a zoom-drag still reaches us as an
  // ordinary click. We track the mousedown point ourselves and bail in
  // `onClickInternal` when the pointer travelled more than a few px.
  const mousedownPosRef = useRef<{ x: number; y: number; t: number } | null>(null);

  // --- Rebuild key ---------------------------------------------------------
  // The uPlot instance is rebuilt ONLY when [traceIdsKey, xDomainKey, logY,
  // normalize, drawMode] changes. `activeTraceId` is deliberately NOT a rebuild
  // dependency — emphasis is patched in place (RULES 2 and 3) then redraw()ed.
  const traceIdsKey = useMemo(() => traces.map((t) => t.id).join("|"), [traces]);

  // A stable string key for the fixed x-domain. The spectrum panels key their
  // trace ids off the SLOT (so `traceIdsKey` stays "live" across a scan step —
  // that's the Phase 4 fix that stopped the per-scan rebuild). But that same
  // stability means switching to a DIFFERENT document — which keeps slot "live"
  // yet hands us a new run's `mzRange` via `xDomain` — would NOT re-run the
  // rebuild effect, leaving the plot pinned to the previous run's m/z domain.
  // Folding the domain into the rebuild trigger fixes that: it changes on a doc
  // switch (mzRange differs) but not on a scan step (mzRange is a run-level
  // constant). `xDomain` is often a fresh array each render, so we key off its
  // VALUES, not its identity, to avoid rebuilding every render.
  const xDomainKey = useMemo(() => (xDomain ? `${xDomain[0]}|${xDomain[1]}` : ""), [xDomain]);

  // --- Build / rebuild the uPlot instance ----------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    // Union x range across every trace — the domain the plot renders, used
    // for the keepZoom check so a selection or visibility change (same traces)
    // preserves the zoom. Task C override: when `xDomain` is supplied (the
    // spectrum panels pass the run's stable `mzRange`), it REPLACES this
    // per-render union so the domain doesn't change from scan to scan — that
    // stability is what lets `keepZoom` below recognise "same domain" across
    // a pin/hover step and preserve the user's m/z zoom.
    let unionMin: number;
    let unionMax: number;
    const fixedDomain = xDomainRef.current;
    if (fixedDomain) {
      [unionMin, unionMax] = fixedDomain;
    } else {
      unionMin = Infinity;
      unionMax = -Infinity;
      for (const t of tracesRef.current) {
        if (t.x.length === 0) continue;
        if (t.x[0] < unionMin) unionMin = t.x[0];
        if (t.x[t.x.length - 1] > unionMax) unionMax = t.x[t.x.length - 1];
      }
    }
    if (!Number.isFinite(unionMin) || !Number.isFinite(unionMax)) {
      // No data at all: nothing to plot.
      return;
    }
    const fullRange = () => ({ min: unionMin, max: unionMax });

    const domainKey = `${unionMin}|${unionMax}|${traceIdsKey}`;
    const sameDomain = domainKey === domainKeyRef.current;
    domainKeyRef.current = domainKey;
    const prev = viewRangeRef.current;
    const keepZoom =
      sameDomain &&
      prev.max > prev.min &&
      prev.min >= unionMin - 1e-6 &&
      prev.max <= unionMax + 1e-6 &&
      (prev.min > unionMin || prev.max < unionMax);
    if (!keepZoom) {
      historyRef.current = [];
      viewRangeRef.current = fullRange();
    }
    const initLo = keepZoom ? prev.min : unionMin;
    const initHi = keepZoom ? prev.max : unionMax;

    const theme = themeRef.current;

    // Apply an [lo,hi] x view: pin the x-scale, swap in the data, and rescale
    // y so peaks fill the height from the baseline (0) up. Scale and data are
    // set together, so they never disagree (the "only the middle shows after
    // zoom" bug). RULE 6: called immediately after construction so the first
    // paint is not blank.
    const applyView = (u: uPlot, lo: number, hi: number, pushHistory: boolean, preserveY = false) => {
      if (!(hi > lo)) return;
      if (pushHistory) historyRef.current.push({ ...viewRangeRef.current });
      viewRangeRef.current = { min: lo, max: hi };
      const plotWidthPx = u.bbox.width || container.clientWidth;
      const view = buildData(
        tracesRef.current,
        axisRef.current,
        drawModeRef.current,
        lo,
        hi,
        plotWidthPx,
        normalizeRef.current,
        stackedRef.current,
      );
      u.setData(view, false);
      xRangeRef.current = [lo, hi];
      u.setScale("x", { min: lo, max: hi });
      if (!logYRef.current) {
        // Bug fix: a pure data refresh (trace gain/offset/visibility changed,
        // NOT the view/normalize/stacked mode) should keep the user's current
        // Y frame instead of silently refitting it — refitting on every trace
        // edit made a gain change look like it "did nothing" / "reset".
        if (preserveY && yRangeRef.current) {
          u.setScale("y", { min: yRangeRef.current[0], max: yRangeRef.current[1] });
        } else {
          const ymax = windowMax(view, tracesRef.current);
          yRangeRef.current = [0, ymax > 0 ? ymax * 1.05 : 1];
          u.setScale("y", { min: 0, max: ymax > 0 ? ymax * 1.05 : 1 });
        }
      }
    };

    // --- Custom stick paths builder (RULE: stick rendering) ----------------
    // Emits, per FINITE point, moveTo(xPx, y0Px) then lineTo(xPx, yPx) where
    // y0Px is the pixel of y=0 (or the scale minimum under logY). NEVER a
    // connected polyline across centroids and NEVER a bar chart. Non-finite y
    // values are skipped — exactly what unionMzColumns emits where a spectrum
    // has no point.
    const stickPaths: uPlot.Series.PathBuilder = (u, seriesIdx, idx0, idx1) => {
      const xs = u.data[0] as ArrayLike<number>;
      const ys = u.data[seriesIdx] as ArrayLike<number>;
      const stroke = new Path2D();
      // Stacked stick spectra have a per-series translated floor. Drawing all
      // of them from zero creates a solid curtain of overlapping full-height
      // stems, so use the trace's actual floor when present.
      const trace = tracesRef.current[seriesIdx - 1];
      const yMin = logYRef.current
        ? (u.scales.y.min ?? 1e-9)
        : trace?.baseline ?? 0;
      const y0Px = u.valToPos(yMin, "y", true);
      let started = false;
      for (let i = idx0; i < idx1; i += 1) {
        const y = ys[i];
        if (y == null || !Number.isFinite(y)) continue;
        const x = xs[i];
        if (x == null || !Number.isFinite(x)) continue;
        const xPx = u.valToPos(x, "x", true);
        const yPx = u.valToPos(y, "y", true);
        if (!started) {
          stroke.moveTo(xPx, y0Px);
          started = true;
        } else {
          stroke.moveTo(xPx, y0Px);
        }
        stroke.lineTo(xPx, yPx);
      }
      return { stroke, fill: null, clip: null } as unknown as uPlot.Series.Paths;
    };

    // --- Overlays: a single draw hook draws EVERYTHING over the plot -------
    // (selection band, background band, cursorX line, markers, annotations).
    const drawOverlays = (u: uPlot) => {
      const ctx = u.ctx;
      const t = themeRef.current;
      const { left, top, width, height } = u.bbox;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, width, height);
      ctx.clip();

      // --- Background band (a second, more muted, dashed band) ------------
      const bg = backgroundRef.current;
      if (bg && bg[0] !== bg[1]) {
        const loPx = u.valToPos(Math.min(bg[0], bg[1]), "x", true);
        const hiPx = u.valToPos(Math.max(bg[0], bg[1]), "x", true);
        ctx.fillStyle = t.bgAlpha;
        ctx.fillRect(loPx, top, hiPx - loPx, height);
        ctx.strokeStyle = t.primary;
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1;
        ctx.strokeRect(loPx, top, hiPx - loPx, height);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // --- Selection bands (task D: zero or more highlighted windows) ----
      // One filled band per entry in `selections` — a plain loop over the
      // Phase-4 array replaces the old single-band draw. Bug-1 fix: each band
      // uses ITS OWN colour (from `selectionColors`, aligned by index) instead
      // of one shared theme colour, so it's clear which chromatogram band
      // corresponds to which stacked spectrum panel.
      const sels = selectionsRef.current;
      const selColors = selectionColorsRef.current;
      if (sels && sels.length > 0) {
        for (let i = 0; i < sels.length; i += 1) {
          const sel = sels[i];
          if (sel[0] === sel[1]) continue;
          const loPx = u.valToPos(Math.min(sel[0], sel[1]), "x", true);
          const hiPx = u.valToPos(Math.max(sel[0], sel[1]), "x", true);
          const c = selColors?.[i];
          if (c) {
            ctx.fillStyle = c;
            ctx.globalAlpha = 0.18;
            ctx.fillRect(loPx, top, hiPx - loPx, height);
            ctx.globalAlpha = 1;
          } else {
            ctx.fillStyle = t.primaryAlpha;
            ctx.fillRect(loPx, top, hiPx - loPx, height);
          }
        }
      }

      // --- cursorX: a 1px vertical line the full plot height --------------
      const cx = cursorXRef.current;
      if (cx != null && Number.isFinite(cx)) {
        const xPx = u.valToPos(cx, "x", true);
        ctx.strokeStyle = t.primary;
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xPx, top);
        ctx.lineTo(xPx, top + height);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // --- Annotations: filter to the current view and lay out (but don't
      // draw yet — computed here, ahead of the markers block below, so that
      // when `markersFromLabels` is set the marker triangles can be derived
      // from this same `placed` set instead of re-deriving their own view
      // filter. Text + leaders are drawn AFTER markers further down, so
      // labels still render on top of triangles — the original z-order.
      const anns = annotationsRef.current;
      let placed: PlacedLabel[] = [];
      const fontSize = 10;
      const lineHeight = 11;
      const charWidth = fontSize * 0.6;
      if (anns.length > 0) {
        // View-dependent density (task B): drop annotations outside the
        // CURRENT x scale window, and below a floor that is a fraction of the
        // CURRENT resolved y-scale max — not the global data max. The wheel
        // handler (below) shrinks/grows `scales.y.max` directly, so scrolling
        // up lowers this floor and smaller peaks acquire labels for free;
        // zooming in x removes off-screen competitors so more labels survive
        // `layoutLabels`'s collision placement. Also drop annotations whose
        // anchor y is ABOVE the current y-scale max: a scroll-up shrinks the
        // y range so big peaks go off the top of the plot — their labels
        // would otherwise float at the plot top instead of on the (clipped)
        // peak, exactly what the user wants gone so the newly-visible SMALL
        // peaks get the labels instead.
        const xMin = u.scales.x.min;
        const xMax = u.scales.x.max;
        const yMax = u.scales.y.max ?? 0;
        const yMin = u.scales.y.min ?? 0;
        const floor = labelFloorFracRef.current * yMax;
        const inView = anns.filter((a) => {
          if (xMin != null && a.x < xMin) return false;
          if (xMax != null && a.x > xMax) return false;
          if (a.y < floor) return false;
          if (a.y > yMax) return false;
          if (a.y < yMin) return false;
          return true;
        });
        if (inView.length > 0) {
          // Convert each surviving annotation's DATA x/y to PLOT PIXELS
          // (RULE 9: canvas pixels — third arg true). The anchor is the
          // point the leader line points at.
          const pixelItems = inView.map((a) => ({
            x: u.valToPos(a.x, "x", true),
            y: u.valToPos(a.y, "y", true),
            lines: a.lines,
            priority: a.priority,
            color: a.color,
          }));
          // Label density follows the available width instead of a fixed
          // cap, so a narrow panel doesn't crowd and a wide one doesn't
          // starve: ~1 label per 60px, clamped to a sane [6, 40] range.
          const maxLabels = Math.max(6, Math.min(40, Math.round(width / 60)));
          placed = layoutLabels(pixelItems, {
            plotLeft: left,
            plotTop: top,
            plotWidth: width,
            plotHeight: height,
            fontSize,
            lineHeight,
            charWidth,
            maxLabels,
            minGapPx: 3,
            leaderMinPx: 10,
            // Tuned so no leader line can span more than ~40% of the plot's
            // height, and no label drifts more than ~half a short label's
            // width sideways from its anchor — the two caps that replace
            // "push to plotTop" / "clamp to the edge" with a clean drop.
            leaderMaxPx: height * 0.4,
            maxOverhangPx: 30,
          });
        }
      }

      // --- Markers: apex = filled triangle; start/end = vertical tick -----
      // When `markersFromLabels` is set, apex triangles are derived from the
      // `placed` labels above (already in plot-pixel space, no further
      // valToPos needed) instead of the `markers` prop, so the triangle count
      // automatically tracks the view-dependent label density from task B.
      if (markersFromLabelsRef.current) {
        for (const p of placed) {
          ctx.fillStyle = p.color ?? t.primary;
          ctx.beginPath();
          ctx.moveTo(p.anchorX, p.anchorY - 6);
          ctx.lineTo(p.anchorX - 5, p.anchorY - 14);
          ctx.lineTo(p.anchorX + 5, p.anchorY - 14);
          ctx.closePath();
          ctx.fill();
        }
      } else {
        const markerList = markersRef.current;
        if (markerList.length > 0) {
          const yMin = logYRef.current ? (u.scales.y.min ?? 1e-9) : 0;
          const y0Px = u.valToPos(yMin, "y", true);
          for (const m of markerList) {
            if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
            const xPx = u.valToPos(m.x, "x", true);
            if (xPx < left - 4 || xPx > left + width + 4) continue;
            if (m.kind === "apex") {
              const yPx = u.valToPos(m.y, "y", true);
              ctx.fillStyle = m.color;
              ctx.beginPath();
              ctx.moveTo(xPx, yPx - 6);
              ctx.lineTo(xPx - 5, yPx - 14);
              ctx.lineTo(xPx + 5, yPx - 14);
              ctx.closePath();
              ctx.fill();
            } else {
              // start/end: short vertical tick from y=0 upward.
              ctx.strokeStyle = m.color;
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(xPx, y0Px);
              ctx.lineTo(xPx, y0Px - 12);
              ctx.stroke();
            }
          }
        }
      }

      // --- Annotation text + leaders (drawn on top of markers) -----------
      if (placed.length > 0) {
        ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        for (const p of placed) {
          const boxW = Math.max(...p.lines.map((l) => l.length)) * charWidth;
          const boxH = p.lines.length * lineHeight;
          const boxCenterX = p.x + boxW / 2;
          const boxBottom = p.y + boxH;
          // Leader line from anchor to bottom-centre of the placed box —
          // skipped entirely when `layoutLabels` reports the box landed
          // close enough to its anchor that a connector would be pointless.
          if (p.leader) {
            ctx.strokeStyle = p.color ?? t.mutedFg;
            ctx.globalAlpha = 0.6;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p.anchorX, p.anchorY);
            ctx.lineTo(boxCenterX, boxBottom);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          // Text lines.
          ctx.fillStyle = p.color ?? t.fg;
          for (let li = 0; li < p.lines.length; li += 1) {
            ctx.fillText(p.lines[li], p.x, p.y + li * lineHeight);
          }
        }
      }

      ctx.restore();
    };

    // --- setCursor hook: write the readout to the DOM, never setState -----
    const setCursorHook = (u: uPlot) => {
      const el = readoutRef.current;
      const idx = u.cursor.idx;
      hoverIdxRef.current = idx ?? null;
      // The rAF publish loop is normally started by `pointerenter`, but if the
      // pointer was already inside the plot when this uPlot instance was built
      // (e.g. a rebuild triggered while hovering — trace toggle / logY flip),
      // the browser does NOT re-fire `pointerenter` for the new `.u-over`
      // node, so the loop would never start and hover would never reach React.
      // Starting it here on the first setCursor (which fires on every mousemove)
      // is idempotent via the `rafRef == null` guard and closes that hole.
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(rafLoop);
      if (!el) return;
      if (idx == null) {
        el.textContent = "\u00a0";
        return;
      }
      const xs = u.data[0];
      const x = xs[idx] as number | undefined;
      if (x == null || !Number.isFinite(x)) {
        el.textContent = "\u00a0";
        return;
      }
      // Pick the active trace's y for the readout, falling back to series 1.
      const ai = tracesRef.current.findIndex((t) => t.id === activeTraceIdRef.current);
      const seriesIdx = ai >= 0 ? ai + 1 : 1;
      const ys = u.data[seriesIdx] as ArrayLike<number>;
      const y = ys[idx] as number | undefined;
      const xText = axisRef.current === "rt" ? `${x.toFixed(3)} min` : `m/z ${x.toFixed(3)}`;
      if (y == null || !Number.isFinite(y)) {
        el.textContent = xText;
      } else {
        el.textContent = `${xText} · ${compactNumber(y)}`;
      }
    };

    // --- setSelect hook (RULE 7): decide mode from modifiers, swap atomically
    const setSelectHook = (u: uPlot) => {
      const { left, width } = u.select;
      if (width <= 0) return;
      const lo = u.posToVal(left, "x");
      const hi = u.posToVal(left + width, "x");
      // Clear the selection rectangle (false = don't re-fire this hook).
      u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
      const dm = dragModeRef.current;
      // Read the raw modifier state ONCE, independent of `dm`/`mode` below —
      // `additive` (Shift held at drag time) must still mean "append" for
      // "select" mode even when a forced toolbar drag mode is active, so it
      // can't live inside the `dm === "auto"` branch alone.
      const mods = modifiersRef.current;
      let mode: "zoom" | "select" | "background";
      if (dm !== "auto") {
        mode = dm;
      } else {
        mode = mods.ctrl
          ? "background"
          : mods.shift
            ? "select"
            : "zoom";
      }
      if (mode === "zoom") {
        applyView(u, lo, hi, true);
      }
      // Always notify the parent of the range + mode (the parent owns the
      // selection/background state and re-passes it as props for the overlay).
      onSelectRangeRef.current(lo, hi, mode, mods.shift);
    };

    // --- uPlot options -----------------------------------------------------
    // RULE 4: NEVER set scales.x.auto = false. RULE 5: ref-backed range
    // callbacks. RULE 7: cursor.drag.setScale:false + dblclick bound to null
    // so our own zoom-history handler wins.
    const opts: Options = {
      // The container fills its panel via CSS, so these are already the real
      // pixel dimensions. Floor them so a container that is still 0x0 (first
      // paint, or a keep-alive route parked behind `display: none`) never
      // produces a degenerate plot the ResizeObserver then has to rescue.
      width: Math.max(container.clientWidth, 120),
      height: Math.max(container.clientHeight, 80),
      scales: {
        x: { time: false, range: () => xRangeRef.current ?? [0, 1] },
        y: logY ? { distr: 3 } : { range: () => yRangeRef.current ?? [0, 1] },
      },
      cursor: { drag: { x: true, y: false, setScale: false }, bind: { dblclick: () => null } },
      // uPlot's legend is laid out INSIDE `.uplot`, below the canvas, and its
      // height is not reliably measurable at construction time — which made the
      // canvas budget wrong and squashed the plot. We render our own legend as
      // a sibling flex row instead, so the canvas container's box is exact.
      legend: { show: false },
      axes: [
        {
          label: xLabelRef.current,
          size: 34,
          labelGap: 4,
          grid: { stroke: theme.border, width: 1 },
          ticks: { stroke: theme.border, width: 1 },
          stroke: theme.mutedFg,
          font: AXIS_FONT,
          labelFont: AXIS_LABEL_FONT,
        },
        {
          label: normalize ? "rel. (%)" : "Intensity",
          size: 44,
          labelGap: 4,
          labelSize: 11,
          values: (_u, splits) => splits.map((s) => compactNumber(s as number)),
          grid: { stroke: theme.border, width: 1 },
          ticks: { stroke: theme.border, width: 1 },
          stroke: theme.mutedFg,
          font: AXIS_FONT,
          labelFont: AXIS_LABEL_FONT,
        },
      ],
      // Series 0 is the x-axis grid. RULE 1: width MUST be a plain number.
      // RULE 2: stroke MUST be a closure (so in-place recolour works). The
      // active trace is emphasised (thicker + full alpha).
      series: [
        {},
        ...tracesRef.current.map((t) => {
          const isActive = t.id === activeTraceIdRef.current;
          const color = t.color;
          return {
            label: t.label,
            stroke: () => color,
            width: isActive ? 1.6 : 0.8,
            alpha: isActive ? 1 : 0.6,
            points: { show: false },
            show: t.visible,
            // Stick mode uses the custom path builder; line mode uses uPlot's
            // default (the builder is omitted so uPlot uses its own).
            paths: drawMode === "stick" ? stickPaths : undefined,
          };
        }),
      ],
      hooks: {
        draw: [drawOverlays],
        setCursor: [setCursorHook],
        setSelect: [setSelectHook],
      },
    };

    const plot = new uPlot(opts, buildData(tracesRef.current, axisRef.current, drawModeRef.current, initLo, initHi, container.clientWidth, normalizeRef.current, stackedRef.current), container);
    plotRef.current = plot;
    applyViewRef.current = (lo, hi, push, preserveY) => applyView(plot, lo, hi, push, preserveY);
    // Expose the PNG capture function: snapshots the current canvas. Returns
    // null when there is no data (the plot effect bailed out early). The
    // optional `scale` multiplies the canvas pixel dimensions for the grab so
    // the export-scale selector is honoured; the on-screen size is restored
    // afterwards.
    if (captureRef) {
      captureRef.current = (scaleArg?: number) => {
        const plot = plotRef.current;
        if (!plot) return null;
        const scale = Math.max(1, Math.min(8, Math.round(scaleArg ?? 1)));
        try {
          if (scale === 1) {
            return plotPngWithLegend(
              plot.ctx.canvas,
              plot.width,
              tracesRef.current,
              themeRef.current,
            );
          }
          // Render at `scale`x: temporarily resize uPlot, grab, then restore.
          // setSize triggers a redraw, so the canvas holds the high-res image
          // when toDataURL runs.
          const w = plot.width;
          const h = plot.height;
          plot.setSize({ width: w * scale, height: h * scale });
          try {
            return plotPngWithLegend(
              plot.ctx.canvas,
              plot.width,
              tracesRef.current,
              themeRef.current,
            );
          } finally {
            plot.setSize({ width: w, height: h });
          }
        } catch {
          return null;
        }
      };
    }
    // RULE 6: a setScale("x", ...) issued synchronously after new uPlot(...) is
    // dropped; call applyView immediately so the first paint is not blank.
    applyView(plot, initLo, initHi, false);

    // --- Double-click: pop one zoom level, or reset to full when empty -----
    const onDblClick = () => {
      const prev = historyRef.current.pop();
      const target = prev ?? fullRange();
      applyView(plot, target.min, target.max, false);
    };

    // --- Wheel: scale Y only, minimum pinned at 0 (never negative) unless logY
    // Shift+wheel (Phase 3 task D) is a DIFFERENT gesture entirely: it leaves
    // the shared y-scale untouched and instead multiplies the ACTIVE trace's
    // own `scale` via `onScaleTrace`, so overlapping traces can be balanced
    // against each other without moving the axis every other trace draws
    // against. Returns early (after preventDefault, so the page never
    // scrolls) so the plain-wheel y-scale path below never also runs.
    const onWheel = (event: WheelEvent) => {
      if (event.shiftKey) {
        const onScaleTrace = onScaleTraceRef.current;
        const activeId = activeTraceIdRef.current;
        if (onScaleTrace && activeId) {
          event.preventDefault();
          const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25;
          onScaleTrace(activeId, factor);
        }
        return;
      }
      if (logYRef.current) return;
      event.preventDefault();
      const y = plot.scales.y;
      const curMax = y.max ?? 1;
      const curMin = 0; // pin minimum at 0
      const factor = event.deltaY < 0 ? 0.8 : 1.25;
      const newMax = Math.max(curMin + 1e-9, curMax * factor);
      yRangeRef.current = [curMin, newMax];
      plot.setScale("y", { min: curMin, max: newMax });
    };

    // --- Click listener (CAPTURE phase on the plot ROOT). ------------------
    // uPlot installs a capture-phase click handler on `.u-wrap` whose
    // `drag.click` calls stopPropagation()+stopImmediatePropagation(), so a
    // bubble-phase listener on `.u-over` NEVER fires. Attach ours to the plot
    // ROOT (`.uplot`, the ancestor ABOVE `.u-wrap`) in the CAPTURE phase so we
    // run before uPlot's handler can stop the event. Filter to clicks that land
    // inside the `.u-over` box (via getBoundingClientRect) so legend/axis
    // clicks do not pin a scan. (RULE 9: posToVal without the third arg for
    // DOM hit tests.)
    const onClickInternal = (e: MouseEvent) => {
      // Drag-release guard: if the pointer moved more than 4px since
      // mousedown, this "click" is the tail end of a drag (a zoom-box, a
      // selection, a background band), not a deliberate pin/pick. 4px is
      // comfortably above ordinary click jitter (sub-pixel to a couple of px
      // on a trackpad/mouse) but well under the smallest drag a user would
      // intentionally make, so real clicks are never dropped.
      const down = mousedownPosRef.current;
      if (down) {
        const dx = e.clientX - down.x;
        const dy = e.clientY - down.y;
        if (Math.hypot(dx, dy) > 4) return;
      }
      const rect = plot.over.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      if (localX < 0 || localX > rect.width || localY < 0 || localY > rect.height) return;
      const x = plot.posToVal(localX, "x");

      // --- Trace picking (Phase 3 task C) -------------------------------
      // Gated on onPickTrace being supplied so this is a complete no-op on
      // the spectrum panel (which never passes it). Map the click x to the
      // nearest plotted data index (u.valToIdx does the binary search over
      // u.data[0], the shared x grid every series column is aligned to), then
      // compare each VISIBLE series' rendered y AT THAT INDEX against the
      // click. `u.valToPos(v, "y", true)` returns CANVAS-pixel space (RULE 9)
      // — specifically, pixels measured from the CANVAS ELEMENT's own origin
      // (it includes the left/bottom axis-gutter offset baked in), NOT from
      // `.u-over`'s origin (`rect`, above), which is inset from the canvas by
      // exactly that gutter. So the click's DOM-space Y must be measured
      // against the CANVAS element's own bounding rect — reusing `rect`/
      // `localY` here would be off by the gutter's width on every click and
      // silently never hit anything. `devicePixelRatio` then converts that
      // canvas-relative CSS offset into the same canvas-PIXEL space valToPos
      // returns (mixing CSS-px and canvas-px would silently mis-hit on any
      // non-1 DPR display, the same trap the gutter one is). Nearest series
      // within ~8 (canvas) px wins; a miss falls through to the ordinary
      // pin-only click below, unchanged from before this trace existed.
      const onPickTrace = onPickTraceRef.current;
      if (onPickTrace) {
        const idx = plot.valToIdx(x);
        if (idx >= 0) {
          const dpr = window.devicePixelRatio || 1;
          const canvasRect = plot.ctx.canvas.getBoundingClientRect();
          const localYCanvas = (e.clientY - canvasRect.top) * dpr;
          let bestId: string | null = null;
          let bestDy = 8;
          const traceList = tracesRef.current;
          for (let s = 0; s < traceList.length; s += 1) {
            const t = traceList[s];
            if (!t.visible) continue;
            const ys = plot.data[s + 1] as ArrayLike<number> | undefined;
            if (!ys) continue;
            const yv = ys[idx];
            if (yv == null || !Number.isFinite(yv)) continue;
            const yPx = plot.valToPos(yv, "y", true);
            const dy = Math.abs(yPx - localYCanvas);
            if (dy < bestDy) {
              bestDy = dy;
              bestId = t.id;
            }
          }
          if (bestId) onPickTrace(bestId);
        }
      }

      onClickRef.current(x, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
    };

    // --- Modifier tracking: update on keydown/keyup AND on mousedown so the
    // setSelect hook reads the modifiers held during the drag ---------------
    const onKeyDown = (e: KeyboardEvent) => {
      modifiersRef.current.shift = e.shiftKey;
      modifiersRef.current.ctrl = e.ctrlKey || e.metaKey;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      modifiersRef.current.shift = e.shiftKey;
      modifiersRef.current.ctrl = e.ctrlKey || e.metaKey;
    };
    const onMouseDown = (e: MouseEvent) => {
      modifiersRef.current.shift = e.shiftKey;
      modifiersRef.current.ctrl = e.ctrlKey || e.metaKey;
      mousedownPosRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    };

    // --- Hover rAF loop: started on pointerenter, cancelled on pointerleave.
    // Publishes to React state ONLY when the integer index changed since the
    // last published value (the performance rule).
    const publishHover = () => {
      const idx = hoverIdxRef.current;
      if (idx === lastPublishedIdxRef.current) return;
      lastPublishedIdxRef.current = idx;
      const xs = plot.data[0];
      const x = idx != null && xs ? (xs[idx] as number | undefined) : undefined;
      onHoverRef.current(x ?? null, idx);
    };
    const rafLoop = () => {
      publishHover();
      rafRef.current = requestAnimationFrame(rafLoop);
    };
    const onPointerEnter = () => {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(rafLoop);
    };
    const onPointerLeave = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      hoverIdxRef.current = null;
      // Publish the cleared hover so the parent hides any crosshair.
      if (lastPublishedIdxRef.current !== null) {
        lastPublishedIdxRef.current = null;
        onHoverRef.current(null, null);
      }
      const el = readoutRef.current;
      if (el) el.textContent = "\u00a0";
    };

    plot.over.addEventListener("dblclick", onDblClick);
    plot.over.addEventListener("wheel", onWheel, { passive: false });
    // CAPTURE phase on plot.root so uPlot's wrap-level stopPropagation cannot
    // swallow the click before us.
    plot.root.addEventListener("click", onClickInternal, true);
    plot.over.addEventListener("pointerenter", onPointerEnter);
    plot.over.addEventListener("pointerleave", onPointerLeave);
    plot.over.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // RULE 8: guard the ResizeObserver — only call setSize when clientWidth
    // / clientHeight ACTUALLY changed, or the plot shakes on hover.
    // -1 so the explicit first call below always syncs, even when it agrees
    // with the size the constructor was given.
    let lastW = -1;
    let lastH = -1;
    const syncSize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      // A 0 means the plot is in a `display: none` subtree (an inactive
      // keep-alive route). Keep the last good size rather than collapsing.
      if (w === 0 || h === 0) return;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      // uPlot's own legend is disabled (we render it in React, outside this
      // container), so the container's box IS the canvas box — no measuring.
      plot.setSize({ width: w, height: h });
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(container);
    // The container is CSS-sized, so its box is already correct here; sync once
    // straight away instead of waiting on the observer's first delivery.
    syncSize();

    // Theme observer: re-read the CSS variables when <html> class changes
    // (the app toggles .dark), then redraw so the canvas picks up the new
    // colours. Also update the axis grid/tick strokes in place.
    const themeObserver = new MutationObserver(() => {
      const t = readTheme();
      // Nothing to do unless a token actually changed. <html>'s class list is
      // touched by things other than the theme toggle (scroll locks, etc.), and
      // this observer fires for every one of them.
      const prev = themeRef.current;
      if (t.border === prev.border && t.mutedFg === prev.mutedFg && t.fg === prev.fg && t.primary === prev.primary) {
        return;
      }
      themeRef.current = t;
      // RULE: axis `stroke` / `grid.stroke` / `ticks.stroke` are NORMALISED
      // INTO FUNCTIONS by uPlot at construction and invoked as `stroke(self, i)`
      // on every paint. Assigning a plain STRING here makes drawAxesGrid throw,
      // and because that throw happens AFTER uPlot has already cleared the
      // canvas the plot goes permanently blank. Always assign a FUNCTION — and
      // mutate `.stroke` in place rather than replacing the whole grid/ticks
      // object, which would drop uPlot's other normalised properties.
      for (const axis of plot.axes) {
        const a = axis as unknown as {
          stroke: () => string;
          grid?: { stroke: () => string };
          ticks?: { stroke: () => string };
        };
        a.stroke = () => t.mutedFg;
        if (a.grid) a.grid.stroke = () => t.border;
        if (a.ticks) a.ticks.stroke = () => t.border;
      }
      plot.redraw();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      ro.disconnect();
      themeObserver.disconnect();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Reset the hover-publish guard so the first hover after a rebuild
      // always publishes — the underlying data/view may have changed even
      // if the cursor lands on the same index, and the setCursorHook-restarts-
      // the-loop path depends on this to surface a new readout.
      lastPublishedIdxRef.current = null;
      hoverIdxRef.current = null;
      plot.over.removeEventListener("dblclick", onDblClick);
      plot.over.removeEventListener("wheel", onWheel);
      plot.root.removeEventListener("click", onClickInternal, true);
      plot.over.removeEventListener("pointerenter", onPointerEnter);
      plot.over.removeEventListener("pointerleave", onPointerLeave);
      plot.over.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      plot.destroy();
      plotRef.current = null;
      applyViewRef.current = null;
      if (captureRef) captureRef.current = null;
    };
    // Rebuild ONLY on [traceIdsKey, xDomainKey, logY, normalize, drawMode].
    // activeTraceId is NOT a rebuild dep — emphasis is patched in place.
  }, [traceIdsKey, xDomainKey, logY, normalize, drawMode, captureRef]);

  // --- In-place styling + data refresh (no uPlot rebuild) ------------------
  // RULE 2: stroke as a closure + invalidate _stroke. RULE 3: setSeries only
  // for show/focus; width/alpha/label/stroke mutated in place + redraw().
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    if (plot.series.length !== 1 + tracesRef.current.length) return;
    const activeId = activeTraceId;
    let needsRedraw = false;
    tracesRef.current.forEach((t, i) => {
      const seriesIdx = i + 1;
      const s = plot.series[seriesIdx] as unknown as {
        show?: boolean;
        stroke?: unknown;
        _stroke?: unknown;
        width?: unknown;
        _width?: unknown;
        alpha?: number;
        label?: string;
      };
      if (!s) return;
      const show = t.visible;
      if (s.show !== show) {
        plot.setSeries(seriesIdx, { show });
        needsRedraw = true;
      }
      const isActive = t.id === activeId;
      // RULE 2: stroke MUST be a closure; invalidate _stroke so the next paint
      // re-resolves it. Recolouring in place (without rebuild) is the whole
      // point — this is how the active trace is emphasised.
      const color = t.color;
      const curStroke = s.stroke;
      const curIsFn = typeof curStroke === "function";
      const curResolved = curIsFn ? (curStroke as () => string)() : (curStroke as string);
      if (curResolved !== color || !curIsFn) {
        s.stroke = () => color;
        s._stroke = color;
        needsRedraw = true;
      }
      // RULE 1: width MUST be a plain number (never a function). A function
      // yields NaN and the series is SILENTLY skipped.
      const width = t.width ?? (isActive ? 1.6 : 0.8);
      const curWidth = s.width;
      const curWidthResolved = typeof curWidth === "function" ? (curWidth as () => number)() : (curWidth as number);
      if (curWidthResolved !== width || typeof curWidth === "function") {
        s.width = width;
        s._width = width;
        needsRedraw = true;
      }
      const alpha = isActive ? 1 : 0.6;
      if (s.alpha !== alpha) {
        s.alpha = alpha;
        needsRedraw = true;
      }
      if (s.label !== t.label) {
        s.label = t.label;
        needsRedraw = true;
      }
    });
    if (needsRedraw) plot.redraw();
  }, [traces, activeTraceId]);

  // --- Update axis labels in place when xLabel / normalize change (no rebuild)
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    let needsRedraw = false;
    const ax0 = plot.axes[0] as unknown as { label?: string };
    if (ax0 && ax0.label !== xLabel) {
      ax0.label = xLabel;
      needsRedraw = true;
    }
    const yLabel = normalize ? "rel. (%)" : "Intensity";
    const ax1 = plot.axes[1] as unknown as { label?: string };
    if (ax1 && ax1.label !== yLabel) {
      ax1.label = yLabel;
      needsRedraw = true;
    }
    if (needsRedraw) plot.redraw();
  }, [xLabel, normalize]);

  // --- Re-apply the data view when offset/normalize/stacked/selection change
  // (keeps the uPlot instance and its zoom). -------------------------------
  // Bug 8 fix: a pure `traces` change (gain/offset/visibility edit) must NOT
  // refit the Y axis — only a real normalize/stacked MODE change should.
  // Otherwise every gain tweak silently reset the user's Y zoom.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    if (plot.series.length !== 1 + tracesRef.current.length) return;
    const apply = applyViewRef.current;
    const lo = viewRangeRef.current.min;
    const hi = viewRangeRef.current.max;
    const structural =
      normalize !== prevNormalizeForViewRef.current || stacked !== prevStackedForViewRef.current;
    prevNormalizeForViewRef.current = normalize;
    prevStackedForViewRef.current = stacked;
    if (hi > lo && apply) apply(lo, hi, false, !structural);
  }, [traces, normalize, stacked]);

  // --- Redraw overlays when annotations / markers / cursor / selection change
  useEffect(() => {
    plotRef.current?.redraw();
  }, [annotations, markers, labelFloorFrac, markersFromLabels, cursorX, selections, selectionColors, background]);

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ minHeight }}>
      <div className="mb-1 flex shrink-0 items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{title}</span>
        <span
          ref={readoutRef}
          className="inline-block w-[160px] whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-muted-foreground"
        >
          &nbsp;
        </span>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
      {/* Legend. Capped + scrollable so a long overlay stack can never eat the
          plot area. Rendered here, OUTSIDE the uPlot container, so the canvas
          box is exactly the flex-1 box. */}
      {traces.length > 1 ? (
        <div className="mt-1 flex max-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 overflow-y-auto">
          {traces.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              {/* The per-trace colour is user-chosen data, not a theme token —
                  the one place an inline colour is allowed. */}
              <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: t.color }} />
              {t.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
