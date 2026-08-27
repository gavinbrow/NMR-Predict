// The TGA workspace's on-screen plot (WP4): every visible run's mass curve on
// the left axis, its DTG on a second uPlot scale drawn as a right-hand axis,
// with box-zoom, a hover readout, and the analysis markers (onset/endset
// tangent verticals, Td drop-lines, Tmax verticals, the residue level) drawn
// over the canvas.
//
// Modelled on `components/gcms/GcmsPlot.tsx`, and it obeys the same hard-won
// uPlot rules that file documents:
//   - never set `scales.x.auto = false`; drive ranges from ref-backed `range()`
//     callbacks so `setData(view, false)` can't leave the scale resolving to
//     nothing;
//   - `cursor.drag.setScale: false` plus `bind.dblclick: () => null`, so our own
//     zoom-history handler owns both gestures;
//   - axis `stroke` / `grid.stroke` / `ticks.stroke` are normalised into
//     FUNCTIONS at construction — assigning a plain string afterwards throws
//     inside `drawAxesGrid` and blanks the canvas permanently;
//   - guard the ResizeObserver on an actual size change, and ignore a 0×0 box
//     (the TGA route is kept alive behind `display: none` when another tab is
//     showing, and collapsing to 0 there would lose the good size).
//
// Runs arrive on their own temperature/time grids, so the component builds a
// union x grid and resamples each run onto it (the same `unionGrid` +
// `resampleOntoGappy` pair the GC/MS panel uses) — uPlot's aligned-data format
// needs one shared x column.

import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import { downsample, resampleOntoGappy, unionGrid } from "@/lib/gcms/view";
import type { XYSeries } from "@/lib/gcms/types";

/** One run as the plot draws it. `y` is already gain/offset-adjusted by the
 *  host, so the plot never re-applies a run's scale — what it draws is exactly
 *  what the figure adapter builds. */
export interface TgaPlotTrace {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  /** x values (temperature °C or time min, per the host's toggle). */
  x: Float64Array;
  /** Primary-axis y (weight % or mg). */
  y: Float64Array;
  /** DTG on the same x grid, or null when the run has none. */
  dtg: Float64Array | null;
}

/** One analysis marker drawn over the canvas. Vertical markers carry `x`;
 *  the residue marker is horizontal and carries `y`. */
export interface TgaPlotMarker {
  id: string;
  kind: "onset" | "endset" | "tmax" | "td" | "residue";
  color: string;
  label: string;
  /** Data x for a vertical marker. */
  x?: number;
  /** Data y for a horizontal marker (and the label anchor for verticals). */
  y?: number;
}

export interface TgaPlotProps {
  traces: TgaPlotTrace[];
  markers: TgaPlotMarker[];
  xLabel: string;
  yLabel: string;
  y2Label: string;
  showDtg: boolean;
  /** Draw the marker labels next to their lines. */
  showMarkerLabels?: boolean;
  /** Floor for the plot height in px; the container otherwise fills its parent. */
  minHeight?: number;
}

// --- Theme tokens ----------------------------------------------------------
// Read the app's CSS variables (HSL component triples like "190 90% 38%") and
// wrap them for canvas use, re-reading when <html>'s class attribute mutates so
// the plot follows the light/dark toggle. No hard-coded colours except each
// run's own.
interface ThemeTokens {
  border: string;
  mutedFg: string;
  fg: string;
}

function hslVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  return raw.startsWith("hsl") ? raw : `hsl(${raw})`;
}

function readTheme(): ThemeTokens {
  return {
    border: hslVar("--border", "hsl(214 25% 88%)"),
    mutedFg: hslVar("--muted-foreground", "hsl(215 16% 45%)"),
    fg: hslVar("--foreground", "hsl(222 47% 11%)"),
  };
}

const AXIS_FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif';
const AXIS_FONT = `10px ${AXIS_FONT_FAMILY}`;
const AXIS_LABEL_FONT = `bold 10px ${AXIS_FONT_FAMILY}`;
const MARKER_FONT = `10px ${AXIS_FONT_FAMILY}`;

/** Per-run point budget before the union grid is built. A TRIOS Excel run can
 *  be 30 000+ points and there can be a dozen of them; the union of the raw
 *  grids would then be a few hundred thousand columns per series. */
const MAX_POINTS_PER_TRACE = 3000;

/** Format a number for the hover readout / marker labels: enough precision to
 *  be useful, never so much that the readout jitters. */
function fmt(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return "—";
  return Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(decimals);
}

/**
 * Build uPlot's aligned data from the traces: one shared x column (the union of
 * every visible run's decimated x grid) followed by one column per run for the
 * primary axis and, when DTG is on, one column per run for the secondary axis.
 * Columns are NaN wherever a run has no data (uPlot draws a gap).
 */
function buildData(traces: TgaPlotTrace[], showDtg: boolean): AlignedData {
  const visible = traces.filter((t) => t.visible && t.x.length > 0);
  if (visible.length === 0) return [new Float64Array(0)] as unknown as AlignedData;

  // Decimate first, then union — the union of raw grids would be enormous.
  const decimated: { trace: TgaPlotTrace; primary: XYSeries; dtg: XYSeries | null }[] = visible.map(
    (t) => ({
      trace: t,
      primary: downsample({ x: t.x, y: t.y }, MAX_POINTS_PER_TRACE),
      dtg: t.dtg ? downsample({ x: t.x, y: t.dtg }, MAX_POINTS_PER_TRACE) : null,
    }),
  );

  const grid = unionGrid(decimated.map((d) => d.primary));
  const cols: Float64Array[] = [];
  for (const d of decimated) {
    // A gap wider than ~5 median steps of this run's own grid breaks the line
    // rather than bridging it, so a run that covers only part of the union
    // range does not draw a straight segment across the rest.
    const gap = medianStep(d.primary.x) * 5;
    cols.push(resampleOntoGappy(d.primary, grid, gap));
  }
  if (showDtg) {
    for (const d of decimated) {
      if (!d.dtg) {
        const empty = new Float64Array(grid.length);
        empty.fill(NaN);
        cols.push(empty);
        continue;
      }
      const gap = medianStep(d.dtg.x) * 5;
      cols.push(resampleOntoGappy(d.dtg, grid, gap));
    }
  }
  return [grid, ...cols] as unknown as AlignedData;
}

/** Median spacing of an ascending x grid; falls back to the full span when the
 *  grid is too short to have one. */
function medianStep(x: Float64Array): number {
  const n = x.length;
  if (n < 3) return n === 2 ? Math.abs(x[1] - x[0]) || 1 : 1;
  // Sampling ~64 evenly spaced gaps is enough for a robust median and keeps
  // this O(1) on a 30 000-point run.
  const steps: number[] = [];
  const stride = Math.max(1, Math.floor(n / 64));
  for (let i = stride; i < n; i += stride) {
    const d = x[i] - x[i - stride];
    if (Number.isFinite(d) && d > 0) steps.push(d / stride);
  }
  if (steps.length === 0) return Math.abs(x[n - 1] - x[0]) / Math.max(1, n - 1) || 1;
  steps.sort((a, b) => a - b);
  return steps[steps.length >> 1];
}

/** Min/max of the finite values of `cols` inside the x window `[lo, hi]`,
 *  padded by 4 % so curves don't touch the frame. Returns null when nothing is
 *  in range. */
function rangeOf(
  x: ArrayLike<number>,
  cols: ArrayLike<number>[],
  lo: number,
  hi: number,
): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < x.length; i += 1) {
    const xv = x[i];
    if (xv < lo || xv > hi) continue;
    for (const col of cols) {
      const v = col[i];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    return [min - pad, max + pad];
  }
  const pad = (max - min) * 0.04;
  return [min - pad, max + pad];
}

export function TgaPlot({
  traces,
  markers,
  xLabel,
  yLabel,
  y2Label,
  showDtg,
  showMarkerLabels = true,
  minHeight = 380,
}: TgaPlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  // Every prop the uPlot callbacks read goes through a ref: uPlot keeps the
  // closures it was constructed with, so reading props directly would pin them
  // to the values at build time.
  const tracesRef = useRef(traces);
  tracesRef.current = traces;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const showDtgRef = useRef(showDtg);
  showDtgRef.current = showDtg;
  const showMarkerLabelsRef = useRef(showMarkerLabels);
  showMarkerLabelsRef.current = showMarkerLabels;
  const xLabelRef = useRef(xLabel);
  xLabelRef.current = xLabel;
  const themeRef = useRef<ThemeTokens>(readTheme());

  const xRangeRef = useRef<[number, number] | null>(null);
  const yRangeRef = useRef<[number, number] | null>(null);
  const y2RangeRef = useRef<[number, number] | null>(null);
  // Scroll-to-scale factors, one per y-axis. They multiply the auto-fitted span
  // (floor pinned) rather than replacing the range, so a scaled axis keeps
  // auto-fitting as the x-window changes — scroll once and the emphasis sticks.
  const yGainRef = useRef(1);
  const y2GainRef = useRef(1);
  const dataRef = useRef<AlignedData | null>(null);
  const historyRef = useRef<{ min: number; max: number }[]>([]);
  const fullRangeRef = useRef<{ min: number; max: number }>({ min: 0, max: 1 });
  const applyViewRef = useRef<((lo: number, hi: number, push: boolean) => void) | null>(null);

  // Rebuild key: the instance is rebuilt only when the SET of series changes
  // (ids, DTG on/off) or an axis label changes. Data-only updates (a param
  // tweak, a colour change, a scale/offset edit) go through `setData` and an
  // in-place series patch in the effects below.
  const buildKey = useMemo(
    () =>
      [
        traces.map((t) => `${t.id}:${t.visible ? 1 : 0}`).join("|"),
        showDtg ? "dtg" : "",
        xLabel,
        yLabel,
        y2Label,
      ].join("//"),
    [traces, showDtg, xLabel, yLabel, y2Label],
  );

  // A cheap signature of the actual numbers, so the data effect fires when the
  // analysis changes but not on every render.
  const dataKey = useMemo(
    () =>
      traces
        .map(
          (t) =>
            `${t.id}:${t.x.length}:${t.y.length ? t.y[0].toFixed(4) : ""}:${
              t.y.length ? t.y[t.y.length - 1].toFixed(4) : ""
            }:${t.dtg && t.dtg.length ? t.dtg[t.dtg.length >> 1].toFixed(6) : ""}`,
        )
        .join("|"),
    [traces],
  );

  const colorKey = useMemo(() => traces.map((t) => t.color).join("|"), [traces]);

  // --- Build / rebuild the uPlot instance ---------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const data = buildData(tracesRef.current, showDtgRef.current);
    dataRef.current = data;
    const xs = data[0] as unknown as Float64Array;
    if (xs.length === 0) return;

    const visible = tracesRef.current.filter((t) => t.visible && t.x.length > 0);
    const nPrimary = visible.length;

    fullRangeRef.current = { min: xs[0], max: xs[xs.length - 1] };
    historyRef.current = [];

    /** Recompute both y ranges for the current x window, then commit the view. */
    const refit = (lo: number, hi: number) => {
      const d = dataRef.current;
      if (!d) return;
      const x = d[0] as unknown as ArrayLike<number>;
      const primaryCols: ArrayLike<number>[] = [];
      const secondaryCols: ArrayLike<number>[] = [];
      for (let i = 0; i < nPrimary; i += 1) primaryCols.push(d[i + 1] as ArrayLike<number>);
      if (showDtgRef.current) {
        for (let i = 0; i < nPrimary; i += 1) {
          const col = d[nPrimary + 1 + i];
          if (col) secondaryCols.push(col as ArrayLike<number>);
        }
      }
      xRangeRef.current = [lo, hi];
      /** Auto-fitted range with the axis' scroll gain applied (floor pinned). */
      const gained = (r: [number, number], gain: number): [number, number] =>
        gain === 1 ? r : [r[0], r[0] + (r[1] - r[0]) * gain];
      yRangeRef.current = gained(rangeOf(x, primaryCols, lo, hi) ?? [0, 1], yGainRef.current);
      y2RangeRef.current = gained(
        secondaryCols.length ? (rangeOf(x, secondaryCols, lo, hi) ?? [0, 1]) : [0, 1],
        y2GainRef.current,
      );
    };

    const applyView = (u: uPlot, lo: number, hi: number, push: boolean) => {
      if (!(hi > lo)) return;
      if (push) {
        const cur = xRangeRef.current;
        if (cur) historyRef.current.push({ min: cur[0], max: cur[1] });
      }
      refit(lo, hi);
      u.setScale("x", { min: lo, max: hi });
      u.setScale("y", { min: yRangeRef.current![0], max: yRangeRef.current![1] });
      if (showDtgRef.current) {
        u.setScale("y2", { min: y2RangeRef.current![0], max: y2RangeRef.current![1] });
      }
    };

    refit(fullRangeRef.current.min, fullRangeRef.current.max);

    // --- Marker + crosshair overlay ---------------------------------------
    // Two passes: every marker LINE first, then the labels, so a label is never
    // painted under a line drawn after it. The label pass keeps the boxes it has
    // already placed and nudges each new one up (then down) until it clears
    // them — with a handful of runs overlaid there are dozens of callouts at
    // similar temperatures and, unnudged, they print on top of each other.
    const drawOverlays = (u: uPlot) => {
      const ms = markersRef.current;
      if (ms.length === 0) return;
      const ctx = u.ctx;
      const t = themeRef.current;
      const { left, top, width, height } = u.bbox;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, width, height);
      ctx.clip();
      ctx.font = MARKER_FONT;
      ctx.textBaseline = "bottom";
      ctx.lineWidth = 1;

      // Pass 1 — lines. Remember where each label wants to go.
      const wanted: { m: TgaPlotMarker; xPx: number; yPx: number; align: CanvasTextAlign }[] = [];
      for (const m of ms) {
        ctx.strokeStyle = m.color;
        ctx.globalAlpha = 0.75;
        ctx.setLineDash(m.kind === "tmax" ? [4, 3] : [2, 3]);
        if (m.kind === "residue") {
          if (m.y == null) continue;
          const yPx = u.valToPos(m.y, "y", true);
          if (!Number.isFinite(yPx)) continue;
          ctx.beginPath();
          ctx.moveTo(left, yPx);
          ctx.lineTo(left + width, yPx);
          ctx.stroke();
          wanted.push({ m, xPx: left + width - 4, yPx: yPx - 2, align: "right" });
          continue;
        }
        if (m.x == null) continue;
        const xPx = u.valToPos(m.x, "x", true);
        if (!Number.isFinite(xPx) || xPx < left || xPx > left + width) continue;
        // From the plot floor up to the run's own curve, so the marker visibly
        // belongs to one line rather than spanning every run in the overlay.
        const anchorY = m.y != null ? u.valToPos(m.y, "y", true) : top + 12;
        const capY = Number.isFinite(anchorY) ? Math.max(top, Math.min(top + height, anchorY)) : top;
        ctx.beginPath();
        ctx.moveTo(xPx, capY);
        ctx.lineTo(xPx, top + height);
        ctx.stroke();
        const nearRight = xPx > left + width - 70;
        wanted.push({
          m,
          xPx: xPx + (nearRight ? -3 : 3),
          yPx: capY - 3,
          align: nearRight ? "right" : "left",
        });
      }

      // Pass 2 — labels, de-collided.
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (showMarkerLabelsRef.current) {
        const lineH = 12;
        const placed: { l: number; r: number; t: number; b: number }[] = [];
        // Top-down keeps the result stable as the view changes.
        const order = [...wanted].sort((a, b) => a.yPx - b.yPx || a.xPx - b.xPx);
        for (const w of order) {
          const textW = ctx.measureText(w.m.label).width;
          const l0 = w.align === "right" ? w.xPx - textW : w.xPx;
          let y = w.yPx;
          for (let k = 0; k <= 12; k += 1) {
            const cand = k === 0 ? [w.yPx] : [w.yPx - k * lineH, w.yPx + k * lineH];
            let found = false;
            for (const cy of cand) {
              if (cy - lineH < top || cy > top + height) continue;
              const box = { l: l0 - 1, r: l0 + textW + 1, t: cy - lineH, b: cy };
              if (placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) {
                continue;
              }
              placed.push(box);
              y = cy;
              found = true;
              break;
            }
            if (found) break;
          }
          ctx.fillStyle = w.m.color;
          ctx.textAlign = w.align;
          ctx.fillText(w.m.label, w.xPx, y);
        }
      }
      ctx.fillStyle = t.fg;
      ctx.restore();
    };

    // --- Hover readout: written straight to the DOM, never through state ---
    const setCursorHook = (u: uPlot) => {
      const el = readoutRef.current;
      if (!el) return;
      const idx = u.cursor.idx;
      if (idx == null) {
        el.textContent = " ";
        return;
      }
      const d = u.data;
      const x = (d[0] as ArrayLike<number>)[idx];
      if (!Number.isFinite(x)) {
        el.textContent = " ";
        return;
      }
      const parts: string[] = [`${xLabelRef.current.replace(/\s*\(.*\)$/, "")} ${fmt(x, 1)}`];
      for (let i = 0; i < nPrimary; i += 1) {
        const y = (d[i + 1] as ArrayLike<number>)[idx];
        if (!Number.isFinite(y)) continue;
        const dtgCol = showDtgRef.current ? d[nPrimary + 1 + i] : undefined;
        const dv = dtgCol ? (dtgCol as ArrayLike<number>)[idx] : NaN;
        parts.push(
          `${visible[i].label}: ${fmt(y)}${Number.isFinite(dv) ? ` · ${fmt(dv, 4)}` : ""}`,
        );
      }
      el.textContent = parts.join("   ");
    };

    // --- Box zoom: uPlot draws the selection, we commit it ------------------
    const setSelectHook = (u: uPlot) => {
      const { left: sl, width: sw } = u.select;
      if (sw <= 2) return;
      const lo = u.posToVal(sl, "x");
      const hi = u.posToVal(sl + sw, "x");
      u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
      applyView(u, lo, hi, true);
    };

    const theme = themeRef.current;
    const opts: Options = {
      width: Math.max(container.clientWidth, 120),
      height: Math.max(container.clientHeight, 80),
      scales: {
        x: { time: false, range: () => xRangeRef.current ?? [0, 1] },
        y: { range: () => yRangeRef.current ?? [0, 1] },
        y2: { range: () => y2RangeRef.current ?? [0, 1] },
      },
      cursor: { drag: { x: true, y: false, setScale: false }, bind: { dblclick: () => null } },
      // uPlot's own legend is laid out inside `.uplot`, below the canvas, and
      // its height isn't reliably measurable at construction — which makes the
      // canvas budget wrong and squashes the plot. We render a legend in React
      // as a sibling instead, so the container's box IS the canvas box.
      legend: { show: false },
      axes: [
        {
          label: xLabel,
          size: 38,
          labelGap: 2,
          labelSize: 12,
          grid: { stroke: theme.border, width: 1 },
          ticks: { stroke: theme.border, width: 1 },
          stroke: theme.mutedFg,
          font: AXIS_FONT,
          labelFont: AXIS_LABEL_FONT,
        },
        {
          scale: "y",
          label: yLabel,
          size: 52,
          labelGap: 2,
          labelSize: 12,
          grid: { stroke: theme.border, width: 1 },
          ticks: { stroke: theme.border, width: 1 },
          stroke: theme.mutedFg,
          font: AXIS_FONT,
          labelFont: AXIS_LABEL_FONT,
        },
        // Right-hand DTG axis. Its gridlines are off — two gridded y-scales
        // double-draw and the picture turns to mush.
        {
          scale: "y2",
          side: 1,
          show: showDtg,
          label: y2Label,
          size: 58,
          labelGap: 2,
          labelSize: 12,
          grid: { show: false },
          ticks: { stroke: theme.border, width: 1 },
          stroke: theme.mutedFg,
          font: AXIS_FONT,
          labelFont: AXIS_LABEL_FONT,
        },
      ],
      series: [
        {},
        // Primary (mass) series — RULE: `stroke` must be a FUNCTION so the
        // colour effect below can patch it in place without a rebuild.
        ...visible.map((t, i) => ({
          label: t.label,
          scale: "y",
          stroke: () => tracesRef.current.find((r) => r.id === visible[i].id)?.color ?? t.color,
          width: 1.6,
          points: { show: false },
        })),
        // Secondary (DTG) series, dashed, same colour.
        ...(showDtg
          ? visible.map((t, i) => ({
              label: `${t.label} DTG`,
              scale: "y2",
              stroke: () => tracesRef.current.find((r) => r.id === visible[i].id)?.color ?? t.color,
              width: 1,
              dash: [4, 3],
              alpha: 0.8,
              points: { show: false },
            }))
          : []),
      ],
      hooks: {
        draw: [drawOverlays],
        setCursor: [setCursorHook],
        setSelect: [setSelectHook],
      },
    };

    const plot = new uPlot(opts, data, container);
    plotRef.current = plot;
    applyViewRef.current = (lo, hi, push) => applyView(plot, lo, hi, push);
    // A setScale issued synchronously after `new uPlot(...)` is dropped, so
    // commit the initial view explicitly or the first paint is blank.
    applyView(plot, fullRangeRef.current.min, fullRangeRef.current.max, false);

    // Double-click pops one zoom level, or — once the history is empty — resets
    // to the full range AND clears both scroll gains, so one gesture undoes
    // everything the wheel and the drag did.
    const onDblClick = () => {
      const prev = historyRef.current.pop();
      if (!prev) {
        yGainRef.current = 1;
        y2GainRef.current = 1;
      }
      const target = prev ?? fullRangeRef.current;
      applyView(plot, target.min, target.max, false);
    };
    plot.over.addEventListener("dblclick", onDblClick);

    // Scroll = scale a y-axis with its floor pinned, so curves grow and shrink
    // from the baseline. WHERE the pointer is decides WHICH axis: over the plot
    // both move together (mass and DTG keep their relative sizes), over the
    // left gutter only weight, over the right gutter only DTG. Attached to the
    // container rather than `plot.over` so the axis gutters — which are outside
    // the overlay — are reachable, and non-passive so it can eat the page
    // scroll.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      const box = plot.over.getBoundingClientRect();
      if (e.clientY < box.top - 8 || e.clientY > box.bottom + 8) return;
      const overPlot = e.clientX >= box.left && e.clientX <= box.right;
      const overLeftAxis = e.clientX < box.left;
      const overRightAxis = showDtgRef.current && e.clientX > box.right;
      if (!overPlot && !overLeftAxis && !overRightAxis) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 0.8 : 1.25;
      // Bounded so a fast scroll can't flatten the curve into the axis or blow
      // the range up past anything readable.
      const clampGain = (g: number) => Math.min(50, Math.max(0.02, g));
      if (overPlot || overLeftAxis) yGainRef.current = clampGain(yGainRef.current * factor);
      if (overPlot || overRightAxis) y2GainRef.current = clampGain(y2GainRef.current * factor);
      const cur = xRangeRef.current ?? [fullRangeRef.current.min, fullRangeRef.current.max];
      applyView(plot, cur[0], cur[1], false);
    };
    container.addEventListener("wheel", onWheel, { passive: false });

    const onPointerLeave = () => {
      const el = readoutRef.current;
      if (el) el.textContent = " ";
    };
    plot.over.addEventListener("pointerleave", onPointerLeave);

    // Guard the observer on a real size change, and never act on a 0×0 box —
    // that means the whole route is parked behind `display: none`.
    let lastW = -1;
    let lastH = -1;
    const syncSize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      plot.setSize({ width: w, height: h });
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(container);
    syncSize();

    // Follow the app's light/dark toggle. Axis strokes are normalised into
    // functions by uPlot; assigning a string here would throw inside
    // drawAxesGrid AFTER the canvas is cleared, blanking the plot for good.
    const themeObserver = new MutationObserver(() => {
      const next = readTheme();
      const prev = themeRef.current;
      if (next.border === prev.border && next.mutedFg === prev.mutedFg && next.fg === prev.fg) return;
      themeRef.current = next;
      for (const axis of plot.axes) {
        const a = axis as unknown as {
          stroke: () => string;
          grid?: { stroke: () => string };
          ticks?: { stroke: () => string };
        };
        a.stroke = () => next.mutedFg;
        if (a.grid) a.grid.stroke = () => next.border;
        if (a.ticks) a.ticks.stroke = () => next.border;
      }
      plot.redraw();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      ro.disconnect();
      themeObserver.disconnect();
      container.removeEventListener("wheel", onWheel);
      plot.over.removeEventListener("dblclick", onDblClick);
      plot.over.removeEventListener("pointerleave", onPointerLeave);
      plot.destroy();
      plotRef.current = null;
      applyViewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildKey]);

  // --- Data-only updates: recompute the columns and keep the current zoom ---
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const data = buildData(tracesRef.current, showDtgRef.current);
    const xs = data[0] as unknown as Float64Array;
    if (xs.length === 0) return;
    dataRef.current = data;
    fullRangeRef.current = { min: xs[0], max: xs[xs.length - 1] };
    plot.setData(data, false);
    const cur = xRangeRef.current;
    const lo = cur ? Math.max(cur[0], xs[0]) : xs[0];
    const hi = cur ? Math.min(cur[1], xs[xs.length - 1]) : xs[xs.length - 1];
    applyViewRef.current?.(hi > lo ? lo : xs[0], hi > lo ? hi : xs[xs.length - 1], false);
  }, [dataKey]);

  // --- Colour / marker updates: redraw only ---------------------------------
  useEffect(() => {
    plotRef.current?.redraw();
  }, [colorKey, markers, showMarkerLabels]);

  const visibleTraces = traces.filter((t) => t.visible && t.x.length > 0);

  if (visibleTraces.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-border/60 text-sm text-muted-foreground"
        style={{ height: minHeight }}
      >
        No visible runs — enable one in Files / Runs.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {visibleTraces.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1.5 text-[11px] text-foreground">
              <span
                className="inline-block h-0.5 w-4 rounded-full"
                style={{ backgroundColor: t.color }}
              />
              {t.label}
            </span>
          ))}
        </div>
        <span
          ref={readoutRef}
          className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground"
        >
          &nbsp;
        </span>
      </div>
      <div ref={containerRef} className="w-full" style={{ height: minHeight }} />
      <p className="text-[10px] text-muted-foreground">
        Drag to zoom in x · double-click to step back out · scroll over the plot to scale both
        y-axes, or over one axis to scale just that one.
      </p>
    </div>
  );
}
