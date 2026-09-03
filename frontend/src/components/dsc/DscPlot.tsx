// The DSC workspace's on-screen plot (WP4): every visible run's heat-flow
// curve on the left axis, an optional derivative/temperature-program trace on
// a second uPlot scale drawn as a right-hand axis, with box-zoom, a hover
// readout, and the analysis marker overlay (baselines, tangents, onset/
// midpoint/peak/endset verticals, callout labels).
//
// A close adaptation of `components/tga/TgaPlot.tsx` — read that file's doc
// comments in full, because every uPlot rule it records still applies here:
//   - never set `scales.x.auto = false`; drive ranges from ref-backed `range()`
//     callbacks so `setData(view, false)` can't leave the scale resolving to
//     nothing;
//   - `cursor.drag.setScale: false` plus `bind.dblclick: () => null`, so our
//     own zoom-history handler owns both gestures;
//   - axis `stroke` / `grid.stroke` / `ticks.stroke` are normalised into
//     FUNCTIONS at construction — assigning a plain string afterwards throws
//     inside `drawAxesGrid` and blanks the canvas permanently;
//   - guard the ResizeObserver on an actual size change, and ignore a 0×0 box
//     (the `/dsc` route is kept alive behind `display: none` when another tab
//     is showing, and collapsing to 0 there would lose the good size).
//
// Differences from `TgaPlot`:
//   - traces may be individually DASHED (a cooling segment in "all" segment
//     mode) — `series[].dash` is a plain array, not subject to the
//     stroke-must-be-a-function rule above (that rule is about `stroke`/
//     `grid.stroke`/`ticks.stroke` specifically, which patch in place on a
//     theme change; `dash` never needs to);
//   - the marker overlay draws THREE marker shapes (line, vertical, label)
//     instead of TGA's single "vertical-or-horizontal" shape — see
//     `lib/dsc/plot.ts`'s `DscPlotMarker` union;
//   - with a feature selected, Shift+drag sets that feature's window and
//     Alt+drag sets its baseline anchors, instead of always box-zooming — the
//     modifier is read from the `mousedown` that starts the drag (uPlot's
//     `setSelect` hook fires on mouseup with no reliable modifier state of
//     its own) and stashed in a ref for the `setSelect` hook to read.
//
// `x`/`y` and `x2`/`y2` on each trace may not share an index basis (each is
// independently downsampled in `lib/dsc/plot.ts`), so — exactly like TGA's
// DTG column — the data builder below unions the visible primary x grids and
// resamples every column, primary AND secondary, onto that union via linear
// interpolation.

import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import { downsample, resampleOntoGappy, unionGrid } from "@/lib/gcms/view";
import type { XYSeries } from "@/lib/gcms/types";
import type { DscPlotMarker, DscPlotMarkerLabel, DscPlotTrace } from "@/lib/dsc/plot";

export interface DscPlotProps {
  traces: DscPlotTrace[];
  markers: DscPlotMarker[];
  xLabel: string;
  yLabel: string;
  /** Empty string when the right axis is off — the axis is hidden either
   *  way (see `showY2`), but callers built this from `dscPlotY2Label`. */
  y2Label: string;
  showY2: boolean;
  /** Draw the marker labels next to their lines/verticals. */
  showMarkerLabels?: boolean;
  /** The feature `FeaturePanel` currently has selected, or `null`. Gates
   *  Shift/Alt-drag: with nothing selected, every drag box-zooms. */
  selectedFeatureId: string | null;
  /** Shift+drag with a feature selected: `[lo, hi]` in data-x units (°C, or
   *  minutes for an OIT feature). The plot never calls the store directly. */
  onSetFeatureWindow: (featureId: string, window: [number, number]) => void;
  /** Alt+drag with a feature selected: sets that feature's baseline anchors. */
  onSetFeatureBaseline: (featureId: string, baseline: [number, number]) => void;
  /** Floor for the plot height in px; the container otherwise fills its parent. */
  minHeight?: number;
}

// --- Theme tokens ----------------------------------------------------------
// Read the app's CSS variables (HSL component triples like "190 90% 38%") and
// wrap them for canvas use, re-reading when <html>'s class attribute mutates
// so the plot follows the light/dark toggle. No hard-coded colours except
// each run's own.
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

/** Format a number for the hover readout: enough precision to be useful,
 *  never so much that the readout jitters. */
function fmt(v: number, decimals = 3): string {
  if (!Number.isFinite(v)) return "—";
  return Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(decimals);
}

/** Median spacing of an ascending x grid; falls back to the full span when
 *  the grid is too short to have one. Mirrors `TgaPlot`'s helper. */
function medianStep(x: Float64Array): number {
  const n = x.length;
  if (n < 3) return n === 2 ? Math.abs(x[1] - x[0]) || 1 : 1;
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

/**
 * Build uPlot's aligned data: one shared x column (the union of every
 * visible trace's primary x grid) followed by one primary column per trace
 * and, when `showY2` is on, one secondary column per trace. A trace with no
 * `x2`/`y2` (or `showY2` off) contributes an all-NaN secondary column so
 * uPlot's series/column counts stay in lockstep with `visible`.
 */
function buildData(traces: DscPlotTrace[], showY2: boolean): AlignedData {
  const visible = traces.filter((t) => t.visible && t.x.length > 0);
  if (visible.length === 0) return [new Float64Array(0)] as unknown as AlignedData;

  const primaries: XYSeries[] = visible.map((t) => ({ x: t.x, y: t.y }));
  const grid = unionGrid(primaries);
  const cols: Float64Array[] = [];
  for (const p of primaries) {
    const gap = medianStep(p.x) * 5;
    cols.push(resampleOntoGappy(p, grid, gap));
  }
  if (showY2) {
    for (const t of visible) {
      if (!t.x2 || !t.y2 || t.x2.length === 0) {
        const empty = new Float64Array(grid.length);
        empty.fill(NaN);
        cols.push(empty);
        continue;
      }
      const s: XYSeries = { x: t.x2, y: t.y2 };
      const gap = medianStep(s.x) * 5;
      cols.push(resampleOntoGappy(s, grid, gap));
    }
  }
  return [grid, ...cols] as unknown as AlignedData;
}

/** Min/max of the finite values of `cols` inside the x window `[lo, hi]`,
 *  padded by 4 % so curves don't touch the frame. */
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

type DragMode = "zoom" | "window" | "baseline";

export function DscPlot({
  traces,
  markers,
  xLabel,
  yLabel,
  y2Label,
  showY2,
  showMarkerLabels = true,
  selectedFeatureId,
  onSetFeatureWindow,
  onSetFeatureBaseline,
  minHeight = 380,
}: DscPlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  // Every prop the uPlot callbacks read goes through a ref: uPlot keeps the
  // closures it was constructed with, so reading props directly would pin
  // them to the values at build time.
  const tracesRef = useRef(traces);
  tracesRef.current = traces;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const showY2Ref = useRef(showY2);
  showY2Ref.current = showY2;
  const showMarkerLabelsRef = useRef(showMarkerLabels);
  showMarkerLabelsRef.current = showMarkerLabels;
  const xLabelRef = useRef(xLabel);
  xLabelRef.current = xLabel;
  const selectedFeatureIdRef = useRef(selectedFeatureId);
  selectedFeatureIdRef.current = selectedFeatureId;
  const onSetFeatureWindowRef = useRef(onSetFeatureWindow);
  onSetFeatureWindowRef.current = onSetFeatureWindow;
  const onSetFeatureBaselineRef = useRef(onSetFeatureBaseline);
  onSetFeatureBaselineRef.current = onSetFeatureBaseline;
  const themeRef = useRef<ThemeTokens>(readTheme());

  // The modifier key held when the current drag STARTED — uPlot's
  // `setSelect` hook fires on mouseup with no reliable modifier state of its
  // own, so `mousedown` stashes the intended mode here for it to read.
  const dragModeRef = useRef<DragMode>("zoom");

  const xRangeRef = useRef<[number, number] | null>(null);
  const yRangeRef = useRef<[number, number] | null>(null);
  const y2RangeRef = useRef<[number, number] | null>(null);
  const yGainRef = useRef(1);
  const y2GainRef = useRef(1);
  const dataRef = useRef<AlignedData | null>(null);
  const historyRef = useRef<{ min: number; max: number }[]>([]);
  const fullRangeRef = useRef<{ min: number; max: number }>({ min: 0, max: 1 });
  const applyViewRef = useRef<((lo: number, hi: number, push: boolean) => void) | null>(null);

  // Rebuild key: the instance is rebuilt only when the SET of series changes
  // (ids, visibility, dashed flags, y2 on/off) or an axis label changes.
  // Data-only updates go through `setData` in the effect below.
  const buildKey = useMemo(
    () =>
      [
        traces.map((t) => `${t.id}:${t.visible ? 1 : 0}:${t.dashed ? 1 : 0}`).join("|"),
        showY2 ? "y2" : "",
        xLabel,
        yLabel,
        y2Label,
      ].join("//"),
    [traces, showY2, xLabel, yLabel, y2Label],
  );

  // A cheap signature of the actual numbers, so the data effect fires when
  // the analysis changes but not on every render.
  const dataKey = useMemo(
    () =>
      traces
        .map(
          (t) =>
            `${t.id}:${t.x.length}:${t.y.length ? t.y[0].toFixed(4) : ""}:${
              t.y.length ? t.y[t.y.length - 1].toFixed(4) : ""
            }:${t.y2 && t.y2.length ? t.y2[t.y2.length >> 1].toFixed(6) : ""}`,
        )
        .join("|"),
    [traces],
  );

  const colorKey = useMemo(() => traces.map((t) => t.color).join("|"), [traces]);
  const markerKey = useMemo(
    () => markers.map((m) => `${m.id}:${m.kind === "line" ? `${m.x0},${m.y0},${m.x1},${m.y1}` : `${m.x},${"y" in m ? m.y : ""}`}`).join("|"),
    [markers],
  );

  // --- Build / rebuild the uPlot instance ---------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const data = buildData(tracesRef.current, showY2Ref.current);
    dataRef.current = data;
    const xs = data[0] as unknown as Float64Array;
    if (xs.length === 0) return;

    const visible = tracesRef.current.filter((t) => t.visible && t.x.length > 0);
    const nPrimary = visible.length;

    fullRangeRef.current = { min: xs[0], max: xs[xs.length - 1] };
    historyRef.current = [];

    const refit = (lo: number, hi: number) => {
      const d = dataRef.current;
      if (!d) return;
      const x = d[0] as unknown as ArrayLike<number>;
      const primaryCols: ArrayLike<number>[] = [];
      const secondaryCols: ArrayLike<number>[] = [];
      for (let i = 0; i < nPrimary; i += 1) primaryCols.push(d[i + 1] as ArrayLike<number>);
      if (showY2Ref.current) {
        for (let i = 0; i < nPrimary; i += 1) {
          const col = d[nPrimary + 1 + i];
          if (col) secondaryCols.push(col as ArrayLike<number>);
        }
      }
      xRangeRef.current = [lo, hi];
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
      if (showY2Ref.current) {
        u.setScale("y2", { min: y2RangeRef.current![0], max: y2RangeRef.current![1] });
      }
    };

    refit(fullRangeRef.current.min, fullRangeRef.current.max);

    // --- Marker overlay -----------------------------------------------------
    // Two passes: every LINE/VERTICAL marker first, then LABEL markers, so a
    // label is never painted under a line drawn after it. The label pass
    // keeps the boxes it has already placed and nudges each new one up (then
    // down) until it clears them.
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

      const wanted: { m: DscPlotMarkerLabel; xPx: number; yPx: number; align: CanvasTextAlign }[] = [];

      for (const m of ms) {
        if (m.kind === "line") {
          const x0 = u.valToPos(m.x0, "x", true);
          const x1 = u.valToPos(m.x1, "x", true);
          const y0 = u.valToPos(m.y0, "y", true);
          const y1 = u.valToPos(m.y1, "y", true);
          if (![x0, x1, y0, y1].every((v) => Number.isFinite(v))) continue;
          ctx.strokeStyle = m.color;
          ctx.globalAlpha = m.sub === "baseline" ? 0.85 : 0.6;
          ctx.setLineDash(m.sub === "tangent" ? [3, 2] : []);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
          continue;
        }
        if (m.kind === "vertical") {
          const xPx = u.valToPos(m.x, "x", true);
          if (!Number.isFinite(xPx) || xPx < left || xPx > left + width) continue;
          const clampY = (v: number) => Math.max(top, Math.min(top + height, v));
          const anchorY = m.y != null ? u.valToPos(m.y, "y", true) : top + 12;
          const capY = Number.isFinite(anchorY) ? clampY(anchorY) : top;
          // `y2` (a feature's own baseline, when it has one) stops the line
          // there instead of running to the plot floor — otherwise fall back
          // to today's floor behaviour exactly as before.
          const endYRaw = m.y2 != null ? u.valToPos(m.y2, "y", true) : NaN;
          const endY = Number.isFinite(endYRaw) ? clampY(endYRaw) : top + height;
          ctx.strokeStyle = m.color;
          ctx.globalAlpha = 0.75;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(xPx, capY);
          ctx.lineTo(xPx, endY);
          ctx.stroke();
          continue;
        }
        // "label": positioned but drawn in pass 2.
        const xPx = u.valToPos(m.x, "x", true);
        const yPx = u.valToPos(m.y, "y", true);
        if (!Number.isFinite(xPx) || !Number.isFinite(yPx) || xPx < left || xPx > left + width) continue;
        const nearRight = xPx > left + width - 70;
        wanted.push({ m, xPx: xPx + (nearRight ? -3 : 3), yPx: yPx - 3, align: nearRight ? "right" : "left" });
      }

      // Pass 2 — labels, de-collided.
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (showMarkerLabelsRef.current) {
        const lineH = 12;
        const placed: { l: number; r: number; t: number; b: number }[] = [];
        const order = [...wanted].sort((a, b) => a.yPx - b.yPx || a.xPx - b.xPx);
        for (const w of order) {
          const textW = ctx.measureText(w.m.text).width;
          const l0 = w.align === "right" ? w.xPx - textW : w.xPx;
          let y = w.yPx;
          for (let k = 0; k <= 12; k += 1) {
            const cand = k === 0 ? [w.yPx] : [w.yPx - k * lineH, w.yPx + k * lineH];
            let found = false;
            for (const cy of cand) {
              if (cy - lineH < top || cy > top + height) continue;
              const box = { l: l0 - 1, r: l0 + textW + 1, t: cy - lineH, b: cy };
              if (placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) continue;
              placed.push(box);
              y = cy;
              found = true;
              break;
            }
            if (found) break;
          }
          ctx.fillStyle = w.m.color;
          ctx.textAlign = w.align;
          ctx.fillText(w.m.text, w.xPx, y);
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
        el.textContent = " ";
        return;
      }
      const d = u.data;
      const x = (d[0] as ArrayLike<number>)[idx];
      if (!Number.isFinite(x)) {
        el.textContent = " ";
        return;
      }
      const parts: string[] = [`${xLabelRef.current.replace(/\s*\(.*\)$/, "")} ${fmt(x, 1)}`];
      for (let i = 0; i < nPrimary; i += 1) {
        const y = (d[i + 1] as ArrayLike<number>)[idx];
        if (!Number.isFinite(y)) continue;
        const y2Col = showY2Ref.current ? d[nPrimary + 1 + i] : undefined;
        const y2v = y2Col ? (y2Col as ArrayLike<number>)[idx] : NaN;
        parts.push(`${visible[i].label}: ${fmt(y)}${Number.isFinite(y2v) ? ` · ${fmt(y2v, 4)}` : ""}`);
      }
      el.textContent = parts.join("   ");
    };

    // --- Drag: box zoom, or (Shift/Alt + a feature selected) set its window
    //     or baseline anchors instead. ------------------------------------
    const setSelectHook = (u: uPlot) => {
      const { left: sl, width: sw } = u.select;
      if (sw <= 2) return;
      const lo = u.posToVal(sl, "x");
      const hi = u.posToVal(sl + sw, "x");
      u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);

      const featureId = selectedFeatureIdRef.current;
      const mode = dragModeRef.current;
      if (featureId && mode === "window") {
        onSetFeatureWindowRef.current(featureId, lo <= hi ? [lo, hi] : [hi, lo]);
        return;
      }
      if (featureId && mode === "baseline") {
        onSetFeatureBaselineRef.current(featureId, lo <= hi ? [lo, hi] : [hi, lo]);
        return;
      }
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
      // its height isn't reliably measurable at construction — render a
      // legend in React as a sibling instead, so the container's box IS the
      // canvas box.
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
          size: 56,
          labelGap: 2,
          labelSize: 12,
          grid: { stroke: theme.border, width: 1 },
          ticks: { stroke: theme.border, width: 1 },
          stroke: theme.mutedFg,
          font: AXIS_FONT,
          labelFont: AXIS_LABEL_FONT,
        },
        // Right-hand axis. Gridlines off — two gridded y-scales double-draw
        // and the picture turns to mush.
        {
          scale: "y2",
          side: 1,
          show: showY2,
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
        // Primary (heat flow) series — RULE: `stroke` must be a FUNCTION so
        // the colour effect below can patch it in place without a rebuild.
        // `dash` is per-trace (cooling segments in "all" mode) and static,
        // not subject to that rule.
        ...visible.map((t, i) => ({
          label: t.label,
          scale: "y",
          stroke: () => tracesRef.current.find((r) => r.id === visible[i].id)?.color ?? t.color,
          width: 1.6,
          dash: t.dashed ? [4, 3] : undefined,
          points: { show: false },
        })),
        // Secondary series (derivative or temperature program), dashed, same
        // colour, only when the right axis is on.
        ...(showY2
          ? visible.map((t, i) => ({
              label: `${t.label} (y2)`,
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

    // Capture the modifier key at drag START — `setSelect` fires on mouseup
    // with no reliable modifier state of its own.
    const onMouseDown = (e: MouseEvent) => {
      dragModeRef.current = e.shiftKey ? "window" : e.altKey ? "baseline" : "zoom";
    };
    plot.over.addEventListener("mousedown", onMouseDown);

    // Double-click pops one zoom level, or — once the history is empty —
    // resets to the full range AND clears both scroll gains.
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

    // Scroll = scale a y-axis with its floor pinned. WHERE the pointer is
    // decides WHICH axis: over the plot both move together, over the left
    // gutter only the primary axis, over the right gutter only y2.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      const box = plot.over.getBoundingClientRect();
      if (e.clientY < box.top - 8 || e.clientY > box.bottom + 8) return;
      const overPlot = e.clientX >= box.left && e.clientX <= box.right;
      const overLeftAxis = e.clientX < box.left;
      const overRightAxis = showY2Ref.current && e.clientX > box.right;
      if (!overPlot && !overLeftAxis && !overRightAxis) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 0.8 : 1.25;
      const clampGain = (g: number) => Math.min(50, Math.max(0.02, g));
      if (overPlot || overLeftAxis) yGainRef.current = clampGain(yGainRef.current * factor);
      if (overPlot || overRightAxis) y2GainRef.current = clampGain(y2GainRef.current * factor);
      const cur = xRangeRef.current ?? [fullRangeRef.current.min, fullRangeRef.current.max];
      applyView(plot, cur[0], cur[1], false);
    };
    container.addEventListener("wheel", onWheel, { passive: false });

    const onPointerLeave = () => {
      const el = readoutRef.current;
      if (el) el.textContent = " ";
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
      plot.over.removeEventListener("mousedown", onMouseDown);
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
    const data = buildData(tracesRef.current, showY2Ref.current);
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
  }, [colorKey, markerKey, showMarkerLabels]);

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
                style={{
                  backgroundColor: t.dashed ? "transparent" : t.color,
                  borderTop: t.dashed ? `2px dashed ${t.color}` : undefined,
                }}
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
        Drag to zoom in x · double-click to step back out · scroll to scale the y-axes.{" "}
        {selectedFeatureId
          ? "Shift+drag sets the selected transition's window · Alt+drag sets its baseline."
          : "Select a transition to Shift+drag its window or Alt+drag its baseline."}
      </p>
    </div>
  );
}
