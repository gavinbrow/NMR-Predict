import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  dashArray,
  decimateMinMax,
  formatTick,
  pickVisibleLabels,
  resolveAxis,
  seriesPathD,
  sticksPathD,
  windowSlice,
  type FigureData,
  type FigureOptions,
  type FigureSeriesData,
  type PeakLabelDatum,
  type SeriesStyle,
} from "@/lib/ir/figure";

/** Above this many points a previewed series is decimated for responsiveness. */
const DECIMATE_ABOVE = 2000;
const DECIMATE_BUCKETS = 800;
/** Markers are suppressed for series denser than this (they'd be a smear). */
const MARKER_LIMIT = 1000;
/** Minimum drag (viewBox px) before a gesture counts as a zoom on that axis. */
const DRAG_MIN = 6;

/** Title / legend / annotation text colour (axis text is user-controlled). */
const TEXT_COLOR = "#0f172a";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Thinning rank for a peak label: the host's own priority when it supplied one
 *  (see {@link PeakLabelDatum.priority}), else the drawn height. A non-finite
 *  value sorts last rather than poisoning the comparison. */
function rankOf(p: PeakLabelDatum): number {
  const v = p.priority ?? p.y;
  return Number.isFinite(v) ? v : -Infinity;
}

/** Scroll-up / scroll-down y-axis scale factors (smaller max → taller peaks),
 *  matching the live MALDI viewer's wheel behaviour. */
const Y_SCALE_IN = 0.8;
const Y_SCALE_OUT = 1.25;

/** Plot-area bounds a label is clamped inside. */
interface LabelBounds {
  marginLeft: number;
  marginTop: number;
  plotW: number;
  plotH: number;
}

/** The estimated axis-aligned box (pre-rotation) of a drawn peak label.
 *  `x`/`y` are the clamped draw anchor; `middle` is the text-anchor mode. */
interface LabelBoxRect {
  x: number;
  y: number;
  middle: boolean;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Where a label draws at the given nudge. Text width is *estimated* from the
 * glyph count — never measured with `getBBox`, which would race the exporter's
 * two-rAF settle — so the declutter pass, the renderer and the pointer hit-test
 * all agree by construction.
 */
function labelBoxAt(
  p: { anchorPx: number; apexY: number; text: string },
  dx: number,
  dy: number,
  pl: { fontSize: number; rotation: number; offset: number },
  b: LabelBounds,
): LabelBoxRect {
  const x = clamp(p.anchorPx + dx, b.marginLeft, b.marginLeft + b.plotW);
  // Rotated text extends vertically by its (horizontal) text width: -90° grows
  // upward from the anchor, +90° downward. Peak labels render outside the clip
  // group, so clamp the anchor by the rotated extent to keep the whole glyph
  // inside the figure frame.
  const textW = p.text.length * pl.fontSize * 0.6;
  const rotated = pl.rotation !== 0;
  const upExt = rotated ? (pl.rotation < 0 ? textW : 0) : pl.fontSize;
  const downExt = rotated ? (pl.rotation < 0 ? 0 : textW) : 0;
  const y = clamp(p.apexY - pl.offset + dy, b.marginTop + upExt, b.marginTop + b.plotH - downExt);
  const halfW = textW / 2;
  const middle = pl.rotation === 0;
  return {
    x,
    y,
    middle,
    left: middle ? x - halfW - 2 : x - 2,
    right: middle ? x + halfW + 2 : x + halfW * 2 + 2,
    top: y - pl.fontSize * 0.9,
    bottom: y + pl.fontSize * 0.3,
  };
}

/** Overlapping area of two label boxes (0 when they clear each other), used
 *  both as the collision test and as the tie-break when nothing is free. */
function overlapArea(a: LabelBoxRect, b: LabelBoxRect, pad: number): number {
  const w = Math.min(a.right + pad, b.right + pad) - Math.max(a.left - pad, b.left - pad);
  const h = Math.min(a.bottom + pad, b.bottom + pad) - Math.max(a.top - pad, b.top - pad);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Vertical steps tried on each side of a colliding label. 40 steps of ~1.5 line
 * heights reaches the whole of a 600px-tall figure from anywhere in it, which is
 * what a TGA overlay of half a dozen runs needs — its callouts all crowd into
 * the same 150px of x.
 */
const DECLUTTER_STEPS = 40;

/**
 * Push overlapping labels apart vertically (see {@link PeakLabelOptions.declutter}).
 *
 * `minGap` thins labels that crowd in x, which is the right tool for a
 * spectrum's peak ladder — but it can't help a figure whose labels are all
 * pinned (custom text bypasses thinning), which is exactly a TGA overlay's
 * onset/Td/Tmax callouts across several runs. Labels the user has placed by
 * hand keep their spot and act as fixed obstacles; the rest get the first free
 * slot above (then below) their anchor.
 */
function declutterLabels<T extends { anchorPx: number; apexY: number; text: string; dx: number; dy: number; fixed: boolean }>(
  items: T[],
  pl: { fontSize: number; rotation: number; offset: number },
  b: LabelBounds,
): T[] {
  if (items.length < 2) return items;
  // A full line height plus the box padding, so one step always clears a
  // neighbour outright — a shorter step leaves a sliver of overlap that the
  // search then has to spend candidates escaping.
  const step = Math.max(2, pl.fontSize * 1.5);
  const placed: LabelBoxRect[] = [];
  const out = new Map<T, number>();

  // Hand-placed labels first: they never move, so everything else works around
  // where the user put them.
  for (const it of items) {
    if (!it.fixed) continue;
    placed.push(labelBoxAt(it, it.dx, it.dy, pl, b));
  }
  // Top-down (then left-to-right) so the packing fills the plot in reading
  // order and stays stable as the view changes.
  const free = items.filter((it) => !it.fixed).sort((a, c) => a.apexY - c.apexY || a.anchorPx - c.anchorPx);
  for (const it of free) {
    let chosen = it.dy;
    let chosenBox = labelBoxAt(it, it.dx, it.dy, pl, b);
    // Track the least-bad placement too: past a certain density no arrangement
    // is collision-free, and "wherever it started" is a much worse answer than
    // "wherever it overlaps least".
    let bestCost = Infinity;
    let settled = false;
    for (let k = 0; k <= DECLUTTER_STEPS && !settled; k += 1) {
      // Upward first (labels already sit above their anchor), then down.
      for (const dy of k === 0 ? [it.dy] : [it.dy - k * step, it.dy + k * step]) {
        const box = labelBoxAt(it, it.dx, dy, pl, b);
        let cost = 0;
        for (const q of placed) cost += overlapArea(box, q, 1);
        if (cost === 0) {
          chosen = dy;
          chosenBox = box;
          settled = true;
          break;
        }
        if (cost < bestCost) {
          bestCost = cost;
          chosen = dy;
          chosenBox = box;
        }
      }
    }
    placed.push(chosenBox);
    out.set(it, chosen);
  }
  return items.map((it) => (out.has(it) ? { ...it, dy: out.get(it)! } : it));
}

/** A drag in progress on the interactive preview. Coordinates are viewBox px. */
type Drag =
  | { kind: "zoom"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "legend"; lx: number; ly: number; offX: number; offY: number }
  // Dragging a peak label: `dx0/dy0` are the override's starting nudge, `dx/dy`
  // the live nudge, `moved` whether the pointer passed the click threshold (a
  // click just selects the label; a real drag re-places it).
  | {
      kind: "label";
      id: string;
      startX: number;
      startY: number;
      dx0: number;
      dy0: number;
      dx: number;
      dy: number;
      moved: boolean;
    };

/**
 * One legend row. `style` is present when the row keys a real series (and gives
 * the key its line width / dash / marker); a {@link LegendNote} row has none.
 * `color` is the key colour, or null for a plain caption row with no key.
 */
type LegendEntry = { style?: SeriesStyle; text: string; color: string | null };

export interface FigureSvgProps {
  data: FigureData;
  options: FigureOptions;
  /**
   * Decimate dense series for a responsive live preview. Exports render with
   * `decimate={false}` so the saved figure is always full resolution.
   */
  decimate?: boolean;
  /** Enable drag-to-zoom on the plot and drag-to-move on the legend. */
  interactive?: boolean;
  /** A drag-zoom committed a new range (an axis is omitted if barely dragged). */
  onZoom?: (next: {
    x?: { min: number; max: number };
    y?: { min: number; max: number };
    /** The secondary y2 axis, when the figure has one. Drag-zoom acts on the
     *  primary y only — y2 keeps its own (auto or manual) range, because trying
     *  to couple two independent scales through one gesture is worse than leaving
     *  them independent. Wheel-scale is primary-y-only for the same reason. */
    y2?: { min: number; max: number };
  }) => void;
  /** Scrolling fully back out asks the host to clear manual bounds (auto fit). */
  onResetZoom?: () => void;
  /** The legend was dropped; position is the box top-left as plot-area fractions. */
  onLegendMove?: (custom: { x: number; y: number }) => void;
  /**
   * MS-only (data-anchored peak labels). The currently selected label id, drawn
   * with a selection ring; a click on a label or on empty plot space reports the
   * new selection through {@link onLabelSelect}.
   */
  selectedLabelId?: string | null;
  onLabelSelect?: (id: string | null) => void;
  /** A peak label was dragged to a new placement (px offset from its anchor). */
  onLabelMove?: (id: string, offset: { dx: number; dy: number }) => void;
  /** Reports how many in-view labels are drawn vs. dropped by thinning, so the
   *  host can surface "N labels hidden" (why a low ladder silently vanished). */
  onLabelStats?: (stats: { shown: number; hiddenByThinning: number }) => void;
  className?: string;
}

/**
 * The figure renderer: a pure SVG drawing of the data under the user's options.
 * The on-screen preview and the exported file come from this one component, so
 * what you see is exactly what you save (SVG = serialization, PNG = raster of
 * the same SVG). When `interactive`, the preview also supports scroll-to-zoom
 * (wheel = zoom x around the cursor, shift/horizontal = pan, alt = zoom y),
 * drag-to-zoom, and a draggable legend; all write back through the callbacks
 * into `options`, so exports faithfully reproduce the zoom and legend placement.
 */
export function FigureSvg({
  data,
  options,
  decimate = true,
  interactive = false,
  onZoom,
  onResetZoom,
  onLegendMove,
  selectedLabelId,
  onLabelSelect,
  onLabelMove,
  onLabelStats,
  className,
}: FigureSvgProps) {
  // useId() returns ":r1:"-style ids; strip the colons for url(#…) references.
  const clipId = `figclip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const svgRef = useRef<SVGSVGElement | null>(null);
  // The wheel handler is attached as a non-passive native listener (so it can
  // preventDefault the page scroll); this ref always holds the latest closure.
  const wheelRef = useRef<((e: WheelEvent) => void) | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const fig = useMemo(() => {
    const visible = options.series
      .map((st) => ({ st, sd: data.series.find((s) => s.id === st.id) }))
      .filter((p): p is { st: SeriesStyle; sd: FigureSeriesData } => p.st.visible && !!p.sd);

    // Partition by axis: the left ("y") is the IR/MALDI/GC-MS default; the
    // right ("y2") only exists when the host supplied a y2Label AND at least one
    // visible series claims it. When no series uses y2, the right axis is not
    // drawn even if `options.y2` is set — hiding those series hides the axis,
    // with no extra visibility flag to track.
    const primary = visible.filter((v) => (v.st.axis ?? "y") === "y");
    const secondary = visible.filter((v) => v.st.axis === "y2");
    const hasY2 = !!options.y2 && secondary.length > 0;

    // Series may carry their own x (mass-spectra overlays / stick series); the
    // x-axis spans the union, falling back to the shared grid when none do.
    const anyOwnX = visible.some((v) => v.sd.x);
    const xValues = anyOwnX ? visible.flatMap((v) => v.sd.x ?? data.x) : data.x;
    const yValues = primary.flatMap((v) =>
      v.sd.baseline == null ? v.sd.y : [...v.sd.y, v.sd.baseline],
    );
    const y2Values = secondary.flatMap((v) =>
      v.sd.baseline == null ? v.sd.y : [...v.sd.y, v.sd.baseline],
    );
    const xAxis = resolveAxis(options.x, xValues);
    const yAxis = resolveAxis(options.y, yValues);
    // The secondary axis resolves against the secondary series only. When the
    // host has no y2 series, `y2Values` is empty and `resolveAxis` falls back to
    // [0, 1] — but we never read the result because `hasY2` is false.
    const y2Axis = hasY2 ? resolveAxis(options.y2!, y2Values) : null;

    // Margins sized from the fonts and what's shown on each side.
    const titleH = options.title ? options.titleFontSize * 1.6 : 0;
    const marginTop = 14 + titleH;
    // The right margin grows when a y2 axis is drawn, mirroring the left
    // margin's tick + label arithmetic. Without y2 it stays 16 — the exact
    // value every IR/MALDI/GC-MS figure already uses, so those hosts render
    // byte-identically to before.
    const marginRightBase = 16;
    const y2TickChars =
      hasY2 && options.y2!.showTickLabels
        ? Math.max(1, ...y2Axis!.ticks.map((t) => formatTick(t, y2Axis!.decimals).length))
        : 0;
    const y2TickW = hasY2 && options.y2!.showTickLabels ? y2TickChars * options.tickFontSize * 0.62 + 10 : 0;
    const y2LabelW = hasY2 && options.y2!.label ? options.axisFontSize * 1.6 : 0;
    const marginRight = marginRightBase + (hasY2 ? y2TickW + y2LabelW : 0);
    const xTickH = options.x.showTickLabels ? options.tickFontSize * 1.5 : 6;
    const xLabelH = options.x.label ? options.axisFontSize * 1.8 : 0;
    const marginBottom = 10 + xTickH + xLabelH;
    const yTickChars = options.y.showTickLabels
      ? Math.max(1, ...yAxis.ticks.map((t) => formatTick(t, yAxis.decimals).length))
      : 0;
    const yTickW = options.y.showTickLabels ? yTickChars * options.tickFontSize * 0.62 + 10 : 6;
    const yLabelW = options.y.label ? options.axisFontSize * 1.6 : 0;
    const marginLeft = 10 + yLabelW + yTickW;

    const plotW = Math.max(10, options.width - marginLeft - marginRight);
    const plotH = Math.max(10, options.height - marginTop - marginBottom);

    const xSpan = xAxis.hi - xAxis.lo;
    const ySpan = yAxis.hi - yAxis.lo;
    const sx = (v: number) =>
      marginLeft + ((options.reversedX ? xAxis.hi - v : v - xAxis.lo) / xSpan) * plotW;
    const sy = (v: number) => marginTop + ((yAxis.hi - v) / ySpan) * plotH;
    // The secondary y-scale. Mirrors `sy` but over the y2 range. When there is
    // no y2 axis, this is never read (no series uses it).
    const y2Span = y2Axis ? y2Axis.hi - y2Axis.lo : 1;
    const sy2 = (v: number) => marginTop + ((y2Axis!.hi - v) / y2Span) * plotH;
    // Stems grow from the zero line when it is in view, else from the axis floor.
    const stickBaseY = sy(yAxis.lo <= 0 && yAxis.hi >= 0 ? 0 : yAxis.lo);
    const stickBaseY2 = y2Axis
      ? sy2(y2Axis.lo <= 0 && y2Axis.hi >= 0 ? 0 : y2Axis.lo)
      : stickBaseY;

    const paths = visible.map(({ st, sd }) => {
      const ownX = sd.x ?? data.x;
      const onY2 = st.axis === "y2";
      const syThis = onY2 && hasY2 ? sy2 : sy;
      const baseThis = onY2 && hasY2 ? stickBaseY2 : stickBaseY;
      // A uniform stick colour paints every stem one colour so the series
      // colours live only in the labels and the legend ("colour the labels, not
      // the spectrum"). Line series always keep their own colour.
      const color = st.kind === "sticks" && options.stickColor ? options.stickColor : st.color;
      if (st.kind === "sticks") {
        // Stems are the sparse peak set already — never decimated.
        const baseY = sd.baseline == null ? baseThis : syThis(sd.baseline);
        const d = sticksPathD(ownX, sd.y, sx, syThis, baseY);
        const markers =
          st.markers && sd.y.length <= MARKER_LIMIT
            ? ownX
                .map((xv, i) => ({ cx: sx(xv), cy: syThis(sd.y[i]), ok: Number.isFinite(xv) && Number.isFinite(sd.y[i]) }))
                .filter((p) => p.ok)
            : [];
        return { st, d, markers, color };
      }
      let xs = ownX;
      let ys = sd.y;
      if (decimate) {
        // Clip to the visible x-window FIRST, then decimate only that window to
        // roughly one column-pair per on-screen pixel. Decimating the whole
        // series (as before) meant a zoomed-in view drew from a handful of
        // global buckets — fine structure like isotopes vanished. Now zooming
        // in resolves it, while the full-resolution export (decimate=false) is
        // untouched.
        const [a, b] = windowSlice(ownX, xAxis.lo, xAxis.hi);
        xs = ownX.slice(a, b + 1);
        ys = sd.y.slice(a, b + 1);
        if (xs.length > DECIMATE_ABOVE) {
          const dec = decimateMinMax(xs, ys, Math.max(DECIMATE_BUCKETS, Math.ceil(plotW)));
          xs = dec.x;
          ys = dec.y;
        }
      }
      const d = st.lineStyle !== "none" ? seriesPathD(xs, ys, sx, syThis) : "";
      const markers =
        st.markers && ys.length <= MARKER_LIMIT
          ? xs
              .map((xv, i) => ({ cx: sx(xv), cy: syThis(ys[i]), ok: Number.isFinite(xv) && Number.isFinite(ys[i]) }))
              .filter((p) => p.ok)
          : [];
      return { st, d, markers, color };
    });

    return {
      visible,
      hasY2,
      xAxis,
      yAxis,
      y2Axis,
      marginTop,
      marginRight,
      marginLeft,
      plotW,
      plotH,
      paths,
      sx,
      sy,
      sy2,
    };
  }, [data, options, decimate]);

  const { visible, hasY2, xAxis, yAxis, y2Axis, marginTop, marginRight, marginLeft, plotW, plotH, paths } = fig;
  const { width, height } = options;
  const axisWeight = options.axisBold ? 700 : 400;

  // Legend box geometry (corner-anchored or custom-placed inside the plot area).
  // The legend is clamped to the plot height: when it would overflow, entries
  // flow into additional columns sized to their widest label, and if those
  // columns would swallow too much of the plot the extra entries are dropped in
  // favour of a "+M more" row. Text width is estimated from the glyph count
  // (never measured — see labelBox note).
  const legend = options.legend;
  // Which series get a row, and what each row says. A series is in the legend
  // when it is visible, unless a per-entry override says otherwise; the row's
  // wording is the override's text, else the series' own label. Driven off
  // `options.series` (not the drawn set) so an override can name a series the
  // plot is currently hiding.
  const legendOverrides = legend.entries ?? {};
  const legendEntries: LegendEntry[] = legend.show
    ? [
        ...options.series
          .filter((st) => {
            const forced = legendOverrides[st.id]?.show;
            if (forced !== undefined) return forced;
            return st.visible && !data.series.find((s) => s.id === st.id)?.legendHidden;
          })
          .map((st) => ({
            style: st,
            text: legendOverrides[st.id]?.text?.trim() || st.label,
            color: st.color,
          })),
        // Free-text rows the analyst added for things the figure doesn't draw as
        // a series. Last, so they read as footnotes to the keys above them; blank
        // ones are skipped so a half-typed row never widens the box.
        ...(legend.notes ?? [])
          .filter((note) => note.text.trim().length > 0)
          .map((note) => ({ text: note.text.trim(), color: note.color })),
      ]
    : [];
  const lf = legend.fontSize;
  const rowH = lf * 1.5;
  const sampleW = 22;
  const colGap = 12;
  const padX = 16;
  const inset = 10;
  const labelW = (e: LegendEntry) => e.text.length * lf * 0.6;
  const moreText = (m: number) => `+${m} more`;
  const maxRows = Math.max(1, Math.floor((plotH - 12) / rowH));
  const n = legendEntries.length;

  type LegendCell = {
    e?: LegendEntry;
    text: string;
    col: number;
    row: number;
    isMore: boolean;
  };
  const colContentW: number[] = [];
  let legendCells: LegendCell[] = [];
  let legendW = padX + sampleW + 6 + (n ? Math.max(1, ...legendEntries.map(labelW)) : 0);
  let legendH = 12 + rowH * n;
  let omitted = 0;

  if (n > 0) {
    if (n <= maxRows) {
      colContentW.push(sampleW + 6 + Math.max(1, ...legendEntries.map(labelW)));
      legendW = padX + colContentW[0];
      legendH = 12 + rowH * n;
      legendCells = legendEntries.map((e, i) => ({
        e,
        text: e.text,
        col: 0,
        row: i,
        isMore: false,
      }));
    } else {
      const maxPlotW = plotW * 0.4;
      const measure = (cols: number, withMore: boolean) => {
        const realToShow = Math.min(n, cols * maxRows - (withMore ? 1 : 0));
        const widths: number[] = [];
        for (let c = 0; c < cols; c += 1) {
          const start = c * maxRows;
          const end = Math.min(realToShow, (c + 1) * maxRows);
          let mw = 0;
          for (let i = start; i < end; i += 1) mw = Math.max(mw, labelW(legendEntries[i]));
          if (withMore && c === cols - 1) {
            mw = Math.max(mw, moreText(n - realToShow).length * lf * 0.6);
          }
          widths.push(sampleW + 6 + Math.max(mw, 1));
        }
        const totalW = padX + widths.reduce((a, b) => a + b, 0) + colGap * (cols - 1);
        return { widths, totalW, realToShow };
      };
      let cols = Math.ceil(n / maxRows);
      let m = measure(cols, false);
      if (m.totalW > maxPlotW) {
        while (cols > 1) {
          cols -= 1;
          m = measure(cols, true);
          if (m.totalW <= maxPlotW) break;
        }
      }
      const realToShow = m.realToShow;
      omitted = n - realToShow;
      const withMore = omitted > 0;
      for (let c = 0; c < cols; c += 1) colContentW.push(m.widths[c]);
      legendW = m.totalW;
      legendH = 12 + rowH * maxRows;
      for (let c = 0; c < cols; c += 1) {
        const start = c * maxRows;
        const end = Math.min(realToShow, (c + 1) * maxRows);
        for (let i = start; i < end; i += 1) {
          legendCells.push({
            e: legendEntries[i],
            text: legendEntries[i].text,
            col: c,
            row: i - start,
            isMore: false,
          });
        }
      }
      if (withMore) {
        legendCells.push({
          text: moreText(omitted),
          col: cols - 1,
          row: maxRows - 1,
          isMore: true,
        });
      }
    }
  }

  // Column x-offsets within the legend frame (left padding 8, then each
  // column's content + the inter-column gap).
  const colX: number[] = [];
  {
    let acc = 8;
    for (let c = 0; c < colContentW.length; c += 1) {
      colX.push(acc);
      acc += colContentW[c] + colGap;
    }
  }

  // Base position: free placement (fractions) if set, else the chosen corner.
  let baseLx: number;
  let baseLy: number;
  if (legend.custom) {
    baseLx = clamp(marginLeft + legend.custom.x * plotW, marginLeft, marginLeft + plotW - legendW);
    baseLy = clamp(marginTop + legend.custom.y * plotH, marginTop, marginTop + plotH - legendH);
  } else {
    baseLx = legend.position.endsWith("right")
      ? marginLeft + plotW - inset - legendW
      : marginLeft + inset;
    baseLy = legend.position.startsWith("top")
      ? marginTop + inset
      : marginTop + plotH - inset - legendH;
  }
  // While dragging the legend, follow the pointer live (no options churn).
  const lx = drag?.kind === "legend" ? drag.lx : baseLx;
  const ly = drag?.kind === "legend" ? drag.ly : baseLy;

  // Look-up of each series' current style colour, for colour-by-series labels.
  const seriesColorById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of options.series) m.set(s.id, s.color);
    return m;
  }, [options.series]);

  // Data-anchored peak labels (m/z values etc.): resolve each label's text,
  // colour and placement, drop hidden ones and those scrolled out of the
  // x-range, then thin to the most intense non-overlapping few so a dense
  // spectrum stays legible. Returns both the drawn set and the pre-thinning
  // candidate count so the host can report how many the thinner dropped.
  const peakLabels = useMemo(() => {
    const pl = options.peakLabels;
    const labels = data.peakLabels;
    if (!pl.show || !labels || labels.length === 0) return { drawn: [], candidates: 0 };
    const eps = 0.5;
    const projected = labels
      // Per-label "hidden" drops the label from the pool BEFORE thinning, so
      // deleting one never frees a slot for a previously-thinned neighbour.
      .filter((p) => !pl.overrides[p.id]?.hidden)
      .map((p) => {
        const ov = pl.overrides[p.id];
        const custom = p.customText === true;
        // Text: a datum carrying custom text wins verbatim; Decimals only
        // reformats the plain-anchor (m/z) labels that have none.
        const text =
          !custom && pl.decimals >= 0 && Number.isFinite(p.x) ? p.x.toFixed(pl.decimals) : p.text;
        // Colour precedence: the datum's own colour (the peak's colour) →
        // the owning series' colour when "colour by series" is on → the single
        // label colour.
        const color =
          p.color ??
          (pl.colorBySeries && p.seriesId ? seriesColorById.get(p.seriesId) : undefined) ??
          pl.color;
        // Pinned = the user has touched this label (a placement/hide override, a
        // custom colour/text, or the current selection). Pinned labels bypass
        // thinning so an edit can't make them vanish.
        const pinned = !!ov || custom || p.id === selectedLabelId;
        const anchorPx = fig.sx(p.x);
        // A label whose owning series is on the right-hand y2 axis anchors
        // against that axis; otherwise the left. Treated as left when there is
        // no owning series, or no y2 axis is in use.
        const owningStyle = p.seriesId
          ? options.series.find((s) => s.id === p.seriesId)
          : undefined;
        const useY2 = !!owningStyle && owningStyle.axis === "y2" && hasY2;
        const apexY = useY2 ? fig.sy2(p.y) : fig.sy(p.y);
        return {
          id: p.id,
          px: anchorPx, // thinning key (min-gap uses the anchor position)
          anchorPx,
          apexY,
          dx: ov?.dx ?? 0,
          dy: ov?.dy ?? 0,
          // Rank by the host's priority when it supplied one (a stacked
          // multi-file figure ranks by the peak's own intensity, not by how
          // high its offset trace happens to sit), else by the drawn height.
          weight: rankOf(p),
          text,
          color,
          pinned,
          // A hand-placed label is never moved by the declutter pass.
          fixed: !!ov,
        };
      })
      // A pinned/"force show" label must still sit in the x-window and carry a
      // finite weight — pinning bypasses thinning, not the basic drawability gate.
      .filter(
        (p) =>
          Number.isFinite(p.anchorPx) &&
          Number.isFinite(p.weight) &&
          p.anchorPx >= marginLeft - eps &&
          p.anchorPx <= marginLeft + plotW + eps,
      );
    const picked = pickVisibleLabels(projected, pl.maxLabels, pl.minGap);
    return {
      drawn: pl.declutter
        ? declutterLabels(picked, pl, { marginLeft, marginTop, plotW, plotH })
        : picked,
      candidates: projected.length,
    };
  }, [
    data.peakLabels,
    options.peakLabels,
    options.series,
    fig,
    hasY2,
    marginLeft,
    marginTop,
    plotW,
    plotH,
    seriesColorById,
    selectedLabelId,
  ]);
  const peakLabelEls = peakLabels.drawn;

  // Report drawn-vs-thinned counts to the host (used to surface "N hidden").
  useEffect(() => {
    onLabelStats?.({
      shown: peakLabels.drawn.length,
      hiddenByThinning: peakLabels.candidates - peakLabels.drawn.length,
    });
  }, [onLabelStats, peakLabels]);

  // Where a label draws at the given nudge — the renderer, the pointer
  // hit-test and the declutter pass all go through `labelBoxAt`, so they can
  // never drift apart.
  const labelBox = (
    p: { anchorPx: number; apexY: number; text: string },
    dx: number,
    dy: number,
  ) => labelBoxAt(p, dx, dy, options.peakLabels, { marginLeft, marginTop, plotW, plotH });

  // Hit-test the (already drawn) labels top-most first, un-rotating the pointer
  // into each label's local frame so rotated labels test correctly.
  const hitTestLabel = (vx: number, vy: number): { id: string } | null => {
    const rotDeg = options.peakLabels.rotation;
    for (let i = peakLabelEls.length - 1; i >= 0; i -= 1) {
      const p = peakLabelEls[i];
      const box = labelBox(p, p.dx, p.dy);
      let lx = vx;
      let ly = vy;
      if (rotDeg) {
        const t = (rotDeg * Math.PI) / 180;
        const cos = Math.cos(t);
        const sin = Math.sin(t);
        lx = box.x + (vx - box.x) * cos + (vy - box.y) * sin;
        ly = box.y - (vx - box.x) * sin + (vy - box.y) * cos;
      }
      if (lx >= box.left && lx <= box.right && ly >= box.top && ly <= box.bottom) {
        return { id: p.id };
      }
    }
    return null;
  };

  // Label editing is live only when a host wired it (MALDI). Off for IR/exports.
  const labelInteractive = interactive && (!!onLabelSelect || !!onLabelMove);

  // --- interactive pointer handling -------------------------------------------

  // Map client (screen) coordinates into the SVG's viewBox space. The SVG scales
  // to its container (w-full / h-auto), so divide by the measured box, not width.
  const clientToVb = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { vx: 0, vy: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      vx: rect.width ? ((clientX - rect.left) / rect.width) * width : 0,
      vy: rect.height ? ((clientY - rect.top) / rect.height) * height : 0,
    };
  };
  const toViewbox = (e: React.PointerEvent) => clientToVb(e.clientX, e.clientY);
  const invX = (vx: number) => {
    const frac = (vx - marginLeft) / plotW;
    const span = xAxis.hi - xAxis.lo;
    return options.reversedX ? xAxis.hi - frac * span : xAxis.lo + frac * span;
  };
  const invY = (vy: number) => yAxis.hi - ((vy - marginTop) / plotH) * (yAxis.hi - yAxis.lo);

  // Scroll = scale an intensity axis with its floor pinned, so curves grow and
  // shrink from the baseline — the same gesture as the live MALDI viewer
  // (scroll up → smaller max → taller peaks, revealing small ones; down →
  // shorter). WHERE the pointer is decides WHICH axis moves: over the plot it
  // scales both y-axes together (so a TGA figure's mass curve and its DTG keep
  // their relative sizes), over the left gutter only the primary, over the
  // right gutter only y2. The x-axis is left to drag-to-zoom. Kept in a ref +
  // native non-passive listener so we can preventDefault the page scroll.
  wheelRef.current = (e: WheelEvent) => {
    if (!interactive || !onZoom || e.deltaY === 0) return;
    const { vx, vy } = clientToVb(e.clientX, e.clientY);
    // A generous band around the plot rows, so the gutters are easy to hit.
    if (vy < marginTop - 8 || vy > marginTop + plotH + 8) return;
    const overPlot = vx >= marginLeft && vx <= marginLeft + plotW;
    const overLeftAxis = vx >= 0 && vx < marginLeft;
    const overRightAxis = hasY2 && vx > marginLeft + plotW && vx <= width;
    if (!overPlot && !overLeftAxis && !overRightAxis) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? Y_SCALE_IN : Y_SCALE_OUT;
    const scaled = (axis: { lo: number; hi: number }) => {
      const max = axis.lo + (axis.hi - axis.lo) * factor;
      return max > axis.lo ? { min: axis.lo, max } : null;
    };
    const next: { y?: { min: number; max: number }; y2?: { min: number; max: number } } = {};
    if (overPlot || overLeftAxis) {
      const y = scaled(yAxis);
      if (y) next.y = y;
    }
    if ((overPlot || overRightAxis) && y2Axis) {
      const y2 = scaled(y2Axis);
      if (y2) next.y2 = y2;
    }
    if (next.y || next.y2) onZoom(next);
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !interactive) return;
    const handler = (e: WheelEvent) => wheelRef.current?.(e);
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, [interactive]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive) return;
    const { vx, vy } = toViewbox(e);
    // A peak label is the smallest, most specific target — check it first so a
    // click near a label grabs the label, not a zoom/legend drag underneath.
    if (labelInteractive && options.peakLabels.show) {
      const hit = hitTestLabel(vx, vy);
      if (hit) {
        svgRef.current?.setPointerCapture(e.pointerId);
        // Start from the placement the label is DRAWN at, not from its stored
        // override — with declutter on those differ, and seeding from the
        // override would make the label jump the instant it is grabbed.
        const drawn = peakLabelEls.find((p) => p.id === hit.id);
        const dx0 = drawn?.dx ?? options.peakLabels.overrides[hit.id]?.dx ?? 0;
        const dy0 = drawn?.dy ?? options.peakLabels.overrides[hit.id]?.dy ?? 0;
        setDrag({
          kind: "label",
          id: hit.id,
          startX: vx,
          startY: vy,
          dx0,
          dy0,
          dx: dx0,
          dy: dy0,
          moved: false,
        });
        onLabelSelect?.(hit.id);
        e.preventDefault();
        return;
      }
    }
    // Legend takes precedence when the pointer lands on it.
    if (
      onLegendMove &&
      legendEntries.length > 0 &&
      vx >= lx &&
      vx <= lx + legendW &&
      vy >= ly &&
      vy <= ly + legendH
    ) {
      svgRef.current?.setPointerCapture(e.pointerId);
      setDrag({ kind: "legend", lx, ly, offX: vx - lx, offY: vy - ly });
      e.preventDefault();
      return;
    }
    if (
      onZoom &&
      vx >= marginLeft &&
      vx <= marginLeft + plotW &&
      vy >= marginTop &&
      vy <= marginTop + plotH
    ) {
      svgRef.current?.setPointerCapture(e.pointerId);
      setDrag({ kind: "zoom", x0: vx, y0: vy, x1: vx, y1: vy });
      e.preventDefault();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const { vx, vy } = toViewbox(e);
    if (drag.kind === "zoom") {
      setDrag({
        ...drag,
        x1: clamp(vx, marginLeft, marginLeft + plotW),
        y1: clamp(vy, marginTop, marginTop + plotH),
      });
    } else if (drag.kind === "legend") {
      setDrag({
        ...drag,
        lx: clamp(vx - drag.offX, marginLeft, marginLeft + plotW - legendW),
        ly: clamp(vy - drag.offY, marginTop, marginTop + plotH - legendH),
      });
    } else {
      // Label drag: accumulate the pointer delta onto the starting nudge. A move
      // past a small threshold promotes the gesture from a click to a re-place.
      const ndx = drag.dx0 + (vx - drag.startX);
      const ndy = drag.dy0 + (vy - drag.startY);
      const moved =
        drag.moved || Math.abs(vx - drag.startX) >= 2 || Math.abs(vy - drag.startY) >= 2;
      setDrag({ ...drag, dx: ndx, dy: ndy, moved });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    if (drag.kind === "zoom") {
      const dx = Math.abs(drag.x1 - drag.x0);
      const dy = Math.abs(drag.y1 - drag.y0);
      if (dx >= DRAG_MIN || dy >= DRAG_MIN) {
        const next: {
          x?: { min: number; max: number };
          y?: { min: number; max: number };
          y2?: { min: number; max: number };
        } = {};
        if (dx >= DRAG_MIN) {
          const a = invX(drag.x0);
          const b = invX(drag.x1);
          next.x = { min: Math.min(a, b), max: Math.max(a, b) };
        }
        if (dy >= DRAG_MIN) {
          const a = invY(drag.y0);
          const b = invY(drag.y1);
          next.y = { min: Math.min(a, b), max: Math.max(a, b) };
        }
        onZoom?.(next);
      } else {
        // A click on empty plot space (no drag) clears any label selection.
        onLabelSelect?.(null);
      }
    } else if (drag.kind === "legend") {
      onLegendMove?.({ x: (drag.lx - marginLeft) / plotW, y: (drag.ly - marginTop) / plotH });
    } else {
      // Commit the new placement only if the label actually moved (a click just
      // selected it, which already happened on pointer-down).
      if (drag.moved) onLabelMove?.(drag.id, { dx: drag.dx, dy: drag.dy });
    }
    setDrag(null);
  };

  const interactiveProps = interactive
    ? {
        onPointerDown,
        onPointerMove,
        onPointerUp: endDrag,
        onPointerCancel: () => setDrag(null),
        // Double-click anywhere on the plot snaps both axes back to auto-fit.
        onDoubleClick: () => onResetZoom?.(),
        style: { cursor: "crosshair", touchAction: "none" as const },
      }
    : {};

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      data-figure-svg=""
      {...interactiveProps}
    >
      {options.background === "white" && (
        <rect x={0} y={0} width={width} height={height} fill="#ffffff" />
      )}
      {/* Transparent hit target so pointer events fire over empty (or
          transparent-background) areas too. Sits behind the plot content. */}
      {interactive && (
        <rect x={0} y={0} width={width} height={height} fill="transparent" pointerEvents="all" />
      )}

      <g fontFamily={options.fontFamily}>
        {/* Gridlines (behind everything in the plot) */}
        {options.x.showGrid &&
          xAxis.ticks.map((t) => (
            <line
              key={`gx${t}`}
              x1={fig.sx(t)}
              x2={fig.sx(t)}
              y1={marginTop}
              y2={marginTop + plotH}
              stroke={options.x.gridColor}
              strokeWidth={options.x.gridWidth}
              strokeDasharray={dashArray(options.x.gridStyle, options.x.gridWidth)}
            />
          ))}
        {options.y.showGrid &&
          yAxis.ticks.map((t) => (
            <line
              key={`gy${t}`}
              x1={marginLeft}
              x2={marginLeft + plotW}
              y1={fig.sy(t)}
              y2={fig.sy(t)}
              stroke={options.y.gridColor}
              strokeWidth={options.y.gridWidth}
              strokeDasharray={dashArray(options.y.gridStyle, options.y.gridWidth)}
            />
          ))}
        {/* Secondary y2 gridlines — off by default; two gridded axes
            double-draw, so this only renders when the user turns it on. */}
        {hasY2 && options.y2!.showGrid &&
          y2Axis!.ticks.map((t) => (
            <line
              key={`gy2${t}`}
              x1={marginLeft}
              x2={marginLeft + plotW}
              y1={fig.sy2(t)}
              y2={fig.sy2(t)}
              stroke={options.y2!.gridColor}
              strokeWidth={options.y2!.gridWidth}
              strokeDasharray={dashArray(options.y2!.gridStyle, options.y2!.gridWidth)}
            />
          ))}

        {/* Series (clipped to the plot area) */}
        <defs>
          <clipPath id={clipId}>
            <rect x={marginLeft} y={marginTop} width={plotW} height={plotH} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          {paths.map(({ st, d, color }) =>
            d ? (
              <path
                key={`p${st.id}`}
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={st.lineWidth}
                strokeDasharray={dashArray(st.lineStyle, st.lineWidth)}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null,
          )}
          {paths.map(({ st, markers, color }) =>
            markers.map((m, i) => (
              <circle key={`m${st.id}-${i}`} cx={m.cx} cy={m.cy} r={st.markerSize} fill={color} />
            )),
          )}
        </g>

        {/* Plot frame (border box) */}
        {options.frameShow && (
          <rect
            x={marginLeft}
            y={marginTop}
            width={plotW}
            height={plotH}
            fill="none"
            stroke={options.frameColor}
            strokeWidth={options.frameWidth}
          />
        )}

        {/* X ticks + labels */}
        {xAxis.ticks.map((t) => (
          <g key={`tx${t}`}>
            <line
              x1={fig.sx(t)}
              x2={fig.sx(t)}
              y1={marginTop + plotH}
              y2={marginTop + plotH + 5}
              stroke={options.frameColor}
              strokeWidth={options.frameWidth}
            />
            {options.x.showTickLabels && (
              <text
                x={fig.sx(t)}
                y={marginTop + plotH + 7 + options.tickFontSize}
                textAnchor="middle"
                fontSize={options.tickFontSize}
                fontWeight={axisWeight}
                fill={options.axisColor}
              >
                {formatTick(t, xAxis.decimals)}
              </text>
            )}
          </g>
        ))}

        {/* Y ticks + labels */}
        {yAxis.ticks.map((t) => (
          <g key={`ty${t}`}>
            <line
              x1={marginLeft - 5}
              x2={marginLeft}
              y1={fig.sy(t)}
              y2={fig.sy(t)}
              stroke={options.frameColor}
              strokeWidth={options.frameWidth}
            />
            {options.y.showTickLabels && (
              <text
                x={marginLeft - 8}
                y={fig.sy(t) + options.tickFontSize * 0.35}
                textAnchor="end"
                fontSize={options.tickFontSize}
                fontWeight={axisWeight}
                fill={options.axisColor}
              >
                {formatTick(t, yAxis.decimals)}
              </text>
            )}
          </g>
        ))}

        {/* Y2 (right-hand) ticks + labels — mirrors the left, drawing ticks
            outside the frame and labels to their right. Rendered only when a
            y2 axis is in use (host supplied y2Label and at least one visible
            series claims it); without y2 the block is absent, so IR/MALDI/GC-MS
            produce byte-identical markup to before. */}
        {hasY2 &&
          y2Axis!.ticks.map((t) => (
            <g key={`ty2${t}`}>
              <line
                x1={marginLeft + plotW}
                x2={marginLeft + plotW + 5}
                y1={fig.sy2(t)}
                y2={fig.sy2(t)}
                stroke={options.frameColor}
                strokeWidth={options.frameWidth}
              />
              {options.y2!.showTickLabels && (
                <text
                  x={marginLeft + plotW + 8}
                  y={fig.sy2(t) + options.tickFontSize * 0.35}
                  textAnchor="start"
                  fontSize={options.tickFontSize}
                  fontWeight={axisWeight}
                  fill={options.axisColor}
                >
                  {formatTick(t, y2Axis!.decimals)}
                </text>
              )}
            </g>
          ))}

        {/* Axis labels + title */}
        {options.x.label && (
          <text
            x={marginLeft + plotW / 2}
            y={height - options.axisFontSize * 0.5}
            textAnchor="middle"
            fontSize={options.axisFontSize}
            fontWeight={axisWeight}
            fill={options.axisColor}
          >
            {options.x.label}
          </text>
        )}
        {options.y.label && (
          <text
            x={10 + options.axisFontSize * 0.8}
            y={marginTop + plotH / 2}
            textAnchor="middle"
            fontSize={options.axisFontSize}
            fontWeight={axisWeight}
            fill={options.axisColor}
            transform={`rotate(-90 ${10 + options.axisFontSize * 0.8} ${marginTop + plotH / 2})`}
          >
            {options.y.label}
          </text>
        )}
        {/* Y2 axis label, rotated +90° at the far right so it reads
            bottom-to-top on the correct side. */}
        {hasY2 && options.y2!.label && (
          <text
            x={width - 10 - options.axisFontSize * 0.8}
            y={marginTop + plotH / 2}
            textAnchor="middle"
            fontSize={options.axisFontSize}
            fontWeight={axisWeight}
            fill={options.axisColor}
            transform={`rotate(90 ${width - 10 - options.axisFontSize * 0.8} ${marginTop + plotH / 2})`}
          >
            {options.y2!.label}
          </text>
        )}
        {options.title && (
          <text
            x={width / 2}
            y={12 + options.titleFontSize}
            textAnchor="middle"
            fontSize={options.titleFontSize}
            fontWeight={600}
            fill={TEXT_COLOR}
          >
            {options.title}
          </text>
        )}

        {/* Legend */}
        {legendEntries.length > 0 && (
          <g style={interactive && onLegendMove ? { cursor: "move" } : undefined}>
            {legend.frame && (
              <rect
                x={lx}
                y={ly}
                width={legendW}
                height={legendH}
                fill="#ffffff"
                fillOpacity={0.9}
                stroke="#cbd5e1"
                strokeWidth={1}
                rx={4}
              />
            )}
            {legendCells.map((cell, i) => {
              const cx = lx + colX[cell.col] + sampleW / 2;
              const cy = ly + 6 + rowH * cell.row + rowH / 2;
              const st = cell.e?.style;
              // A note row has no series behind it, so it borrows the default
              // line weight and a solid dash — and a note with no colour draws no
              // key at all, leaving its text aligned with the rows above.
              const key = cell.isMore ? null : cell.e?.color ?? null;
              // "dot" replaces the whole line sample with one filled circle —
              // the clearer key for a stick spectrum, where a horizontal line
              // resembles nothing that is actually drawn.
              const dot = legend.marker === "dot";
              const drawLine = !dot && (st ? st.lineStyle !== "none" : true);
              return (
                <g key={`l${i}`}>
                  {key && dot && <circle cx={cx} cy={cy} r={Math.max(2, lf * 0.32)} fill={key} />}
                  {key && drawLine && (
                    <line
                      x1={lx + colX[cell.col]}
                      x2={lx + colX[cell.col] + sampleW}
                      y1={cy}
                      y2={cy}
                      stroke={key}
                      strokeWidth={st?.lineWidth ?? 2}
                      strokeDasharray={st ? dashArray(st.lineStyle, st.lineWidth) : undefined}
                    />
                  )}
                  {st && !dot && st.markers && (
                    <circle cx={cx} cy={cy} r={st.markerSize} fill={st.color} />
                  )}
                  <text
                    x={lx + colX[cell.col] + sampleW + 6}
                    y={cy + lf * 0.35}
                    fontSize={lf}
                    fill={TEXT_COLOR}
                  >
                    {cell.text}
                  </text>
                </g>
              );
            })}
          </g>
        )}

        {/* Host annotations (e.g. trendline equation + R²) */}
        {(data.annotations ?? []).map((a) => (
          <text
            key={a.id}
            x={marginLeft + clamp(a.x, 0, 1) * plotW}
            y={marginTop + clamp(a.y, 0, 1) * plotH}
            fontSize={a.fontSize ?? options.tickFontSize}
            fontWeight={600}
            fill={a.color}
          >
            {a.text}
          </text>
        ))}

        {/* Data-anchored peak labels (m/z values over mass-spectrum peaks). Each
            is a group so the transparent hit-rect, selection ring and glyph
            rotate together about the label anchor. A label being dragged follows
            the pointer live via `drag`. */}
        {peakLabelEls.map((p) => {
          const live = drag?.kind === "label" && drag.id === p.id;
          const box = labelBox(p, live ? drag.dx : p.dx, live ? drag.dy : p.dy);
          const selected = p.id === selectedLabelId;
          const rot = options.peakLabels.rotation
            ? `rotate(${options.peakLabels.rotation} ${box.x} ${box.y})`
            : undefined;
          return (
            <g
              key={`pl-${p.id}`}
              transform={rot}
              style={labelInteractive ? { cursor: "move" } : undefined}
            >
              {/* Transparent hit-rect: glyph-only hit-testing is unreliable, so
                  give the label a comfortable, cursor-move-able grab area. */}
              {labelInteractive && (
                <rect
                  x={box.left}
                  y={box.top}
                  width={box.right - box.left}
                  height={box.bottom - box.top}
                  fill="transparent"
                  pointerEvents="all"
                />
              )}
              {selected && labelInteractive && (
                <rect
                  x={box.left}
                  y={box.top}
                  width={box.right - box.left}
                  height={box.bottom - box.top}
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth={1}
                  strokeDasharray="3 2"
                  rx={2}
                  pointerEvents="none"
                />
              )}
              <text
                x={box.x}
                y={box.y}
                textAnchor={box.middle ? "middle" : "start"}
                fontSize={options.peakLabels.fontSize}
                fontWeight={options.peakLabels.bold ? 700 : 400}
                fill={p.color}
              >
                {p.text}
              </text>
            </g>
          );
        })}

        {/* Rubber-band zoom rectangle */}
        {drag?.kind === "zoom" && (
          <rect
            x={Math.min(drag.x0, drag.x1)}
            y={Math.min(drag.y0, drag.y1)}
            width={Math.abs(drag.x1 - drag.x0)}
            height={Math.abs(drag.y1 - drag.y0)}
            fill="#2563eb"
            fillOpacity={0.12}
            stroke="#2563eb"
            strokeWidth={1}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        )}
      </g>
    </svg>
  );
}
