import { Crosshair, Download, Eye, ListPlus, Ruler, RotateCcw, Tag, Trash2 } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { downsample, sliceRange } from "@/lib/maldi/view";
import type { Peak, SpectrumData } from "@/lib/maldi/types";

/** Imperative handle so the page can grab the rendered canvas for reports. */
export interface MaldiSpectrumPlotHandle {
  getPng: () => string | null;
}

/** A simulated isotope stick (m/z, relative abundance 0..1) drawn over the data. */
export interface OverlayStick {
  mz: number;
  abundance: number;
}

interface MaldiSpectrumPlotProps {
  raw: SpectrumData | null;
  processed: SpectrumData | null;
  peaks: Peak[];
  /** Peak ids to emphasize (e.g. a clicked series or Kendrick cluster). */
  highlightedPeakIds?: Set<string>;
  /** Color-coded peak groups (the distinct ladders of one repeat unit). Each
   *  group's peaks are drawn in its colour; takes precedence over
   *  `highlightedPeakIds` for any peak it contains. */
  highlightGroups?: { color: string; ids: Set<string> }[];
  /** Simulated isotope pattern to overlay as sticks (null/empty hides it). */
  overlaySticks?: OverlayStick[] | null;
  /** Manually add a peak (click-to-pick mode snaps to the nearest apex). */
  onAddPeak?: (mz: number, intensity: number) => void;
  /** Manually remove a peak by id (clicking it in click-to-pick mode). */
  onRemovePeak?: (id: string) => void;
  /** Toggle a peak in/out of the currently-selected series (provided only while a
   *  series is selected). Enables the plot's "Edit ladder" click mode. */
  onToggleSeriesMember?: (peakId: string) => void;
  /** Controlled "isolate selection" state. When provided, the page owns it (e.g.
   *  to auto-hide other peaks the moment a series/end-group is clicked); the
   *  toolbar switch reflects and updates it. Omit for internal (uncontrolled) state. */
  isolate?: boolean;
  onIsolateChange?: (on: boolean) => void;
}

/**
 * Snap a clicked m/z to the nearest spectral apex: locate the closest sample,
 * hill-climb to the local crest, then refine over a tiny window. Lets the user
 * click *near* a peak and have the exact apex (m/z + intensity) picked.
 */
function apexNear(
  spectrum: SpectrumData,
  targetMz: number,
): { mz: number; intensity: number } | null {
  const { mz, intensity } = spectrum;
  const n = mz.length;
  if (n === 0) return null;
  // Binary-search the nearest index to the click.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (mz[mid] < targetMz) lo = mid + 1;
    else hi = mid;
  }
  let idx = lo;
  if (idx > 0 && Math.abs(mz[idx - 1] - targetMz) < Math.abs(mz[idx] - targetMz)) idx -= 1;
  // Hill-climb to the nearest local maximum (bounded so noise can't run away).
  for (let step = 0; step < 512; step += 1) {
    const left = idx > 0 ? intensity[idx - 1] : -Infinity;
    const right = idx < n - 1 ? intensity[idx + 1] : -Infinity;
    if (left <= intensity[idx] && right <= intensity[idx]) break;
    idx = right > left ? idx + 1 : idx - 1;
  }
  // Refine over a small window in case the crest is a noisy plateau.
  let best = idx;
  for (let j = Math.max(0, idx - 3); j <= Math.min(n - 1, idx + 3); j += 1) {
    if (intensity[j] > intensity[best]) best = j;
  }
  return { mz: mz[best], intensity: intensity[best] };
}

/** The single tallest sample within an m/z range — the apex a drag-selection box
 *  picks. Returns null if the range contains no samples. */
function apexInRange(
  spectrum: SpectrumData,
  lo: number,
  hi: number,
): { mz: number; intensity: number } | null {
  const { mz, intensity } = spectrum;
  const n = mz.length;
  if (n === 0) return null;
  // Binary-search the first sample ≥ lo.
  let a = 0;
  let b = n - 1;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (mz[mid] < lo) a = mid + 1;
    else b = mid;
  }
  let bestIdx = -1;
  let bestVal = -Infinity;
  for (let i = a; i < n && mz[i] <= hi; i += 1) {
    if (intensity[i] > bestVal) {
      bestVal = intensity[i];
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  return { mz: mz[bestIdx], intensity: intensity[bestIdx] };
}

/** Above this many points we render a min/max-bucketed view and re-slice on zoom. */
const MAX_RENDER_POINTS = 12000;
/** Bright colour used for highlighted (selected-series) peaks. */
const HIGHLIGHT = "#d946ef";

/** Compact y-axis tick label (e.g. 3.0M, 12k) so wide intensity numbers don't run
 *  over the rotated "Intensity" axis label. */
function compactNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1)}G`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${Math.round(v)}`;
}

/** Color for a non-highlighted peak marker by its flag/state. */
function peakColor(peak: Peak): string {
  if (peak.color) return peak.color;
  if (peak.accepted === false || peak.ignored) return "#cbd5e1";
  if (peak.flag === "isotope") return "#94a3b8";
  if (peak.flag === "shoulder") return "#f59e0b";
  if (peak.flag && peak.flag !== "shoulder") return "#ef4444"; // matrix / salt / contaminant
  return "#0ea5e9";
}

/**
 * uPlot-based MALDI spectrum viewer. Renders a downsampled full view and swaps in
 * a full-resolution slice when the user zooms in. Interactions: drag-select to
 * zoom in (x), double-click to step back out (zoom history), scroll wheel to
 * scale the y-axis (reveal small peaks without zooming), hover readout,
 * click-to-measure Δm. Selected-series peaks are drawn as bright bold stems, and
 * an "isolate" mode hides everything except the selection for a clean diagram.
 */
export const MaldiSpectrumPlot = forwardRef<MaldiSpectrumPlotHandle, MaldiSpectrumPlotProps>(
  function MaldiSpectrumPlot(
    {
      raw,
      processed,
      peaks,
      highlightedPeakIds,
      highlightGroups,
      overlaySticks,
      onAddPeak,
      onRemovePeak,
      onToggleSeriesMember,
      isolate: isolateProp,
      onIsolateChange,
    }: MaldiSpectrumPlotProps,
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const plotRef = useRef<uPlot | null>(null);
    const [showProcessed, setShowProcessed] = useState(true);
    const [showLabels, setShowLabels] = useState(true);
    const [logY, setLogY] = useState(false);
    // Isolate selection: controlled by the page when `isolate` prop is supplied
    // (so clicking a series/end-group can hide other peaks), else local state.
    const [isolateLocal, setIsolateLocal] = useState(false);
    const isolate = isolateProp ?? isolateLocal;
    const setIsolate = (on: boolean) => (onIsolateChange ? onIsolateChange(on) : setIsolateLocal(on));
    const [measureMode, setMeasureMode] = useState(false);
    // Region tools: drag a box to add a peak (apex in range) or delete peaks in it.
    const [regionMode, setRegionMode] = useState<"none" | "add" | "delete">("none");
    // "Edit ladder" mode: click peaks to add/remove them from the selected series.
    const [editSeries, setEditSeries] = useState(false);
    // The hover readout is written straight to the DOM (not React state) so moving
    // the mouse never re-renders this component — a re-render on every mousemove was
    // what nudged the plot's layout/scale on hover.
    const readoutRef = useRef<HTMLSpanElement>(null);
    const [measure, setMeasure] = useState<{ a: number; b: number | null } | null>(null);

    // The spectrum actually displayed (processed when available and toggled on).
    const active = useMemo<SpectrumData | null>(() => {
      if (showProcessed && processed) return processed;
      return raw;
    }, [showProcessed, processed, raw]);

    // Peak id → group colour, flattened from highlightGroups for O(1) draw lookup.
    const groupColors = useMemo(() => {
      const m = new Map<string, string>();
      if (highlightGroups) for (const g of highlightGroups) for (const id of g.ids) m.set(id, g.color);
      return m;
    }, [highlightGroups]);

    // Mutable refs the uPlot draw hook reads, so we can redraw without recreating.
    const peaksRef = useRef(peaks);
    const showLabelsRef = useRef(showLabels);
    const highlightRef = useRef(highlightedPeakIds);
    const groupColorsRef = useRef(groupColors);
    const measureRef = useRef(measure);
    const overlayRef = useRef(overlaySticks);
    const isolateRef = useRef(isolate);
    const onAddPeakRef = useRef(onAddPeak);
    const onRemovePeakRef = useRef(onRemovePeak);
    const onToggleSeriesMemberRef = useRef(onToggleSeriesMember);
    const activeRef = useRef<SpectrumData | null>(null);
    const regionModeRef = useRef(regionMode);
    regionModeRef.current = regionMode;
    onToggleSeriesMemberRef.current = onToggleSeriesMember;
    peaksRef.current = peaks;
    showLabelsRef.current = showLabels;
    highlightRef.current = highlightedPeakIds;
    groupColorsRef.current = groupColors;
    measureRef.current = measure;
    overlayRef.current = overlaySticks;
    isolateRef.current = isolate;
    onAddPeakRef.current = onAddPeak;
    onRemovePeakRef.current = onRemovePeak;
    activeRef.current = active;

    // Zoom-history machinery (persists across redraws; reset on a new spectrum).
    const historyRef = useRef<{ min: number; max: number }[]>([]);
    const viewRangeRef = useRef<{ min: number; max: number }>({ min: 0, max: 1 });
    // Identifies the current spectrum's m/z domain so we can tell a *reprocess*
    // (baseline/smoothing toggles — same domain) from a brand-new import, and
    // preserve the zoom across the former.
    const domainKeyRef = useRef<string>("");
    // Set inside the plot effect so the toolbar's Reset button can re-apply a view.
    const applyViewRef = useRef<((lo: number, hi: number, pushHistory: boolean) => void) | null>(null);

    // Capture the spectrum as a PNG showing the FULL m/z range (every peak), not
    // the user's current zoom. We momentarily apply the full view, snapshot the
    // canvas, then restore the previous view — uPlot redraws synchronously, so the
    // flip is invisible. Used by both the report export and the toolbar PNG button.
    const captureFullPng = (): string | null => {
      const plot = plotRef.current;
      if (!plot) return null;
      const apply = applyViewRef.current;
      const act = activeRef.current;
      if (apply && act && act.mz.length > 1) {
        const saved = { ...viewRangeRef.current };
        apply(act.mz[0], act.mz[act.mz.length - 1], false); // full range → all peaks
        const url = plot.ctx.canvas.toDataURL("image/png");
        apply(saved.min, saved.max, false); // restore the user's view
        return url;
      }
      return plot.ctx.canvas.toDataURL("image/png");
    };
    const captureFullPngRef = useRef(captureFullPng);
    captureFullPngRef.current = captureFullPng;

    useImperativeHandle(
      ref,
      () => ({
        getPng: () => captureFullPngRef.current(),
      }),
      [],
    );

    // AlignedData for an x-window, downsampling when dense. Always returns ≥2
    // points so a too-tight zoom never feeds uPlot an empty/degenerate array
    // (which would throw on the next draw).
    const buildView = (spectrum: SpectrumData, lo: number, hi: number): AlignedData => {
      const n = spectrum.mz.length;
      if (n === 0) return [[], []];
      let windowed =
        lo < hi && (lo > spectrum.mz[0] || hi < spectrum.mz[n - 1])
          ? sliceRange(spectrum, lo, hi)
          : spectrum;
      if (windowed.mz.length < 2) {
        const center = (lo + hi) / 2;
        let idx = 0;
        while (idx < n - 1 && spectrum.mz[idx] < center) idx += 1;
        const start = Math.max(0, idx - 1);
        const end = Math.min(n, Math.max(start + 2, idx + 2));
        windowed = { mz: spectrum.mz.slice(start, end), intensity: spectrum.intensity.slice(start, end) };
      }
      const view = windowed.mz.length > MAX_RENDER_POINTS ? downsample(windowed, MAX_RENDER_POINTS) : windowed;
      return [view.mz as unknown as number[], view.intensity as unknown as number[]];
    };

    const windowMax = (data: AlignedData): number => {
      let m = 0;
      const ys = data[1] as number[];
      for (let i = 0; i < ys.length; i += 1) if (ys[i] > m) m = ys[i];
      return m;
    };

    // Create / recreate the plot when the active spectrum or scale type changes.
    useEffect(() => {
      if (!containerRef.current || !active || active.mz.length === 0) return;
      const container = containerRef.current;
      const lastIdx = active.mz.length - 1;
      const fullRange = () => ({ min: active.mz[0], max: active.mz[lastIdx] });

      // Reprocessing (baseline/smooth/normalize, or a log-y toggle) keeps the m/z
      // domain identical; only a new import / crop / calibrate changes it. Preserve
      // the current zoom across the former so tweaking a setting doesn't snap the
      // view back to full — the behaviour the user found maddening.
      const domainKey = `${active.mz[0]}|${active.mz[lastIdx]}|${active.mz.length}`;
      const sameDomain = domainKey === domainKeyRef.current;
      domainKeyRef.current = domainKey;
      const prev = viewRangeRef.current;
      const keepZoom =
        sameDomain &&
        prev.max > prev.min &&
        prev.min >= active.mz[0] - 1e-6 &&
        prev.max <= active.mz[lastIdx] + 1e-6 &&
        (prev.min > active.mz[0] || prev.max < active.mz[lastIdx]);
      if (!keepZoom) {
        historyRef.current = [];
        viewRangeRef.current = fullRange();
      }
      const initLo = keepZoom ? prev.min : active.mz[0];
      const initHi = keepZoom ? prev.max : active.mz[lastIdx];

      const drawPeaks = (u: uPlot) => {
        const ctx = u.ctx;
        const list = peaksRef.current;
        const highlights = highlightRef.current;
        const groupColors = groupColorsRef.current;
        const hasHighlight = (highlights?.size ?? 0) > 0 || groupColors.size > 0;
        const isolating = isolateRef.current && hasHighlight;
        const { left, top, width, height } = u.bbox;
        const baseline = top + height;
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, width, height);
        ctx.clip();
        ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";

        for (const peak of list) {
          const groupColor = groupColors.get(peak.id);
          const highlighted = groupColor != null || (highlights?.has(peak.id) ?? false);
          if (isolating && !highlighted) continue;
          if (!isolating && peak.accepted === false && !peak.flag) continue;
          const mz = peak.centroid ?? peak.mz;
          const x = u.valToPos(mz, "x", true);
          if (x < left || x > left + width) continue;
          const y = u.valToPos(Math.max(peak.intensity, u.scales.y.min ?? 0), "y", true);

          if (highlighted) {
            // Bright bold stem from baseline to apex + larger marker + bold label.
            // When the peak belongs to a coloured group (split-series view) use
            // that group's colour so interleaved ladders are told apart.
            const color = groupColor ?? HIGHLIGHT;
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, baseline);
            ctx.lineTo(x, y);
            ctx.stroke();
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(x, y - 9);
            ctx.lineTo(x - 6, y - 19);
            ctx.lineTo(x + 6, y - 19);
            ctx.closePath();
            ctx.fill();
            if (showLabelsRef.current) {
              ctx.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
              ctx.fillText(mz.toFixed(2), x, y - 22);
              ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
            }
          } else {
            ctx.fillStyle = peakColor(peak);
            ctx.beginPath();
            ctx.moveTo(x, y - 10);
            ctx.lineTo(x - 4, y - 17);
            ctx.lineTo(x + 4, y - 17);
            ctx.closePath();
            ctx.fill();
            if (showLabelsRef.current) {
              ctx.fillStyle = "#475569";
              ctx.fillText(mz.toFixed(2), x, y - 20);
            }
          }
        }

        // Δm measurement markers.
        const m = measureRef.current;
        if (m) {
          ctx.strokeStyle = "#a855f7";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          for (const value of [m.a, m.b]) {
            if (value == null) continue;
            const x = u.valToPos(value, "x", true);
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + height);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }

        // Simulated isotope-pattern overlay (green sticks scaled to plot height).
        const sticks = overlayRef.current;
        if (sticks && sticks.length) {
          ctx.strokeStyle = "#16a34a";
          ctx.fillStyle = "#16a34a";
          ctx.lineWidth = 1.5;
          for (const stick of sticks) {
            const x = u.valToPos(stick.mz, "x", true);
            if (x < left || x > left + width) continue;
            const yTop = top + (1 - Math.max(0, Math.min(1, stick.abundance))) * height;
            ctx.beginPath();
            ctx.moveTo(x, baseline);
            ctx.lineTo(x, yTop);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, yTop, 2, 0, 2 * Math.PI);
            ctx.fill();
          }
        }
        ctx.restore();
      };

      // Apply an [lo,hi] m/z view: pin the x-scale, swap in a full-resolution
      // slice for that window, and rescale y so peaks fill the height from the
      // baseline (0) up. Scale and data are set together, so they never disagree
      // (the cause of the old "only the middle shows after zoom" bug).
      const applyView = (u: uPlot, lo: number, hi: number, pushHistory: boolean) => {
        if (!(hi > lo)) return;
        if (pushHistory) historyRef.current.push({ ...viewRangeRef.current });
        viewRangeRef.current = { min: lo, max: hi };
        const view = buildView(active, lo, hi);
        u.setScale("x", { min: lo, max: hi });
        u.setData(view, false);
        if (!logY) {
          const ymax = windowMax(view);
          u.setScale("y", { min: 0, max: ymax > 0 ? ymax * 1.05 : 1 });
        }
      };

      const opts: Options = {
        width: container.clientWidth,
        height: container.clientHeight,
        // time:false → x axis is numeric m/z, not a date/time axis.
        // Linear y is pinned to 0 at the bottom so the baseline sits on the axis
        // and peaks grow upward (rather than the trace floating mid-plot).
        scales: {
          x: { time: false },
          y: logY ? { distr: 3 } : { range: (_u, _min, max) => [0, max > 0 ? max * 1.05 : 1] },
        },
        // setScale:false → uPlot draws the drag rectangle but leaves the zoom to
        // our setSelect hook, which swaps in the full-res slice atomically.
        cursor: { drag: { x: true, y: false, setScale: false }, bind: { dblclick: () => null } },
        legend: { show: false },
        axes: [
          { label: "m/z", labelGap: 8, grid: { stroke: "#e2e8f0", width: 1 } },
          {
            label: "Intensity",
            // Reserve a wide gutter and abbreviate tick values so the numbers never
            // overlap the rotated axis label.
            size: 64,
            labelGap: 8,
            labelSize: 14,
            values: (_u, splits) => splits.map((s) => compactNumber(s as number)),
            grid: { stroke: "#e2e8f0", width: 1 },
          },
        ],
        series: [{}, { stroke: "#1e293b", width: 1, points: { show: false } }],
        hooks: {
          draw: [drawPeaks],
          setCursor: [
            (u) => {
              const el = readoutRef.current;
              if (!el) return;
              const idx = u.cursor.idx;
              if (idx == null) {
                el.textContent = " "; // keep a constant line-box height
                return;
              }
              const xs = u.data[0];
              const ys = u.data[1];
              const mz = xs[idx] as number | undefined;
              // After a zoom the data array is swapped; a stale cursor idx can
              // point past the shorter array, leaving mz undefined.
              if (mz == null || !Number.isFinite(mz)) {
                el.textContent = " ";
                return;
              }
              el.textContent = `m/z ${mz.toFixed(3)} · ${((ys[idx] as number) ?? 0).toFixed(0)}`;
            },
          ],
          setSelect: [
            (u) => {
              // A drag-zoom completed: convert the selection rectangle to an m/z
              // window and apply it (full-res slice + pinned scale, in one step).
              const { left, width } = u.select;
              if (width <= 0) return;
              const lo = u.posToVal(left, "x");
              const hi = u.posToVal(left + width, "x");
              // Clear the rectangle (false = don't re-fire this hook).
              u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
              applyView(u, lo, hi, true);
            },
          ],
        },
      };

      const plot = new uPlot(opts, buildView(active, initLo, initHi), container);
      plotRef.current = plot;
      applyViewRef.current = (lo, hi, push) => applyView(plot, lo, hi, push);
      // When we kept a zoomed view, pin the x/y scales to it (the constructor only
      // auto-fit x to the windowed data; this makes the y-scale match too).
      if (keepZoom) applyView(plot, initLo, initHi, false);

      // Double-click → step back out one zoom level (or all the way to full).
      const onDblClick = () => {
        const prev = historyRef.current.pop();
        const target = prev ?? fullRange();
        applyView(plot, target.min, target.max, false);
      };

      // Scroll wheel → scale the y-axis (reveal small peaks without zooming x).
      // Min stays pinned at the baseline (0) so peaks grow upward rather than the
      // whole trace sliding up the view.
      const onWheel = (event: WheelEvent) => {
        if (logY) return;
        event.preventDefault();
        const y = plot.scales.y;
        const curMax = y.max ?? windowMax(plot.data);
        const curMin = y.min ?? 0;
        const factor = event.deltaY < 0 ? 0.8 : 1.25; // scroll up → smaller max → taller peaks
        const newMax = Math.max(curMin + 1e-9, curMax * factor);
        plot.setScale("y", { min: curMin, max: newMax });
      };

      plot.over.addEventListener("dblclick", onDblClick);
      plot.over.addEventListener("wheel", onWheel, { passive: false });

      // Guard against a ResizeObserver feedback loop: only resize when the box
      // actually changed. Without this, a sub-pixel reflow while hovering (the
      // readout updating) re-triggers the observer and the plot visibly "shakes".
      let lastW = container.clientWidth;
      let lastH = container.clientHeight;
      const ro = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === lastW && h === lastH) return;
        lastW = w;
        lastH = h;
        plot.setSize({ width: w, height: h });
      });
      ro.observe(container);

      return () => {
        ro.disconnect();
        plot.over.removeEventListener("dblclick", onDblClick);
        plot.over.removeEventListener("wheel", onWheel);
        plot.destroy();
        plotRef.current = null;
        applyViewRef.current = null;
      };
       
    }, [active, logY]);

    // Redraw markers when peaks / labels / highlights / measurement / overlay / isolate change.
    useEffect(() => {
      plotRef.current?.redraw();
    }, [peaks, showLabels, highlightedPeakIds, groupColors, measure, overlaySticks, isolate]);

    // Click-to-measure Δm: collect two m/z clicks, then show their difference.
    useEffect(() => {
      const plot = plotRef.current;
      if (!plot || !measureMode) return;
      const over = plot.over;
      const handler = (event: MouseEvent) => {
        const rect = over.getBoundingClientRect();
        const mz = plot.posToVal(event.clientX - rect.left, "x");
        setMeasure((prev) => {
          if (!prev || prev.b != null) return { a: mz, b: null };
          return { a: prev.a, b: mz };
        });
      };
      over.addEventListener("click", handler);
      return () => over.removeEventListener("click", handler);
    }, [measureMode]);

    // When no series is selected, the page stops passing onToggleSeriesMember, so
    // leave edit mode automatically.
    useEffect(() => {
      if (!onToggleSeriesMember) setEditSeries(false);
    }, [onToggleSeriesMember]);

    // "Edit ladder": a near-stationary left click toggles the nearest peak in/out of
    // the selected series. Drags are ignored so the left-drag zoom still works.
    useEffect(() => {
      const plot = plotRef.current;
      if (!plot || !editSeries) return;
      const over = plot.over;
      let downX = 0;
      let downY = 0;
      const onDown = (event: MouseEvent) => {
        if (event.button !== 0) return;
        downX = event.clientX;
        downY = event.clientY;
      };
      const onClick = (event: MouseEvent) => {
        if (Math.abs(event.clientX - downX) > 4 || Math.abs(event.clientY - downY) > 4) return;
        const rect = over.getBoundingClientRect();
        const px = event.clientX - rect.left;
        let nearestId: string | null = null;
        let nearestDist = 12;
        for (const peak of peaksRef.current) {
          if (peak.accepted === false && !peak.flag) continue;
          const d = Math.abs(plot.valToPos(peak.centroid ?? peak.mz, "x") - px);
          if (d <= nearestDist) {
            nearestDist = d;
            nearestId = peak.id;
          }
        }
        if (nearestId) onToggleSeriesMemberRef.current?.(nearestId);
      };
      over.addEventListener("mousedown", onDown);
      over.addEventListener("click", onClick);
      return () => {
        over.removeEventListener("mousedown", onDown);
        over.removeEventListener("click", onClick);
      };
    }, [editSeries]);

    // Region tools (right-drag): in "add" mode, dragging a box over a peak adds a
    // peak at the tallest sample inside it (a quick click snaps to the nearest
    // apex / removes a peak you hit); in "delete" mode, dragging a RED box removes
    // every peak whose m/z falls inside. Right-button only, so the usual LEFT-drag
    // zoom keeps working while a region tool is active.
    useEffect(() => {
      const plot = plotRef.current;
      if (!plot || regionMode === "none" || !active) return;
      const over = plot.over;
      const rgb = regionMode === "delete" ? "239,68,68" : "14,165,233"; // red / sky
      let startX: number | null = null;
      let box: HTMLDivElement | null = null;

      const removeBox = () => {
        box?.remove();
        box = null;
      };
      const onContext = (event: MouseEvent) => event.preventDefault();
      const onDown = (event: MouseEvent) => {
        if (event.button !== 2) return; // right button drives the region box
        event.preventDefault();
        const rect = over.getBoundingClientRect();
        startX = event.clientX - rect.left;
        box = document.createElement("div");
        box.style.cssText =
          `position:absolute;top:0;bottom:0;pointer-events:none;z-index:20;` +
          `background:rgba(${rgb},0.15);border-left:1.5px solid rgba(${rgb},0.9);` +
          `border-right:1.5px solid rgba(${rgb},0.9);`;
        box.style.left = `${startX}px`;
        box.style.width = "0px";
        over.appendChild(box);
      };
      const onMove = (event: MouseEvent) => {
        if (startX == null || !box) return;
        const rect = over.getBoundingClientRect();
        const cur = event.clientX - rect.left;
        box.style.left = `${Math.min(startX, cur)}px`;
        box.style.width = `${Math.abs(cur - startX)}px`;
      };
      const onUp = (event: MouseEvent) => {
        if (startX == null) return;
        const rect = over.getBoundingClientRect();
        const endX = event.clientX - rect.left;
        const aPx = Math.min(startX, endX);
        const bPx = Math.max(startX, endX);
        const sx = startX;
        startX = null;
        removeBox();
        const mode = regionModeRef.current;
        // Tiny drag → treat as a click (point selection).
        if (bPx - aPx < 4) {
          const clickMz = plot.posToVal(sx, "x");
          if (mode === "delete") {
            // Remove the nearest drawn peak within ~8 px.
            let nearestId: string | null = null;
            let nearestDist = 8;
            for (const peak of peaksRef.current) {
              if (peak.accepted === false && !peak.flag) continue;
              const d = Math.abs(plot.valToPos(peak.centroid ?? peak.mz, "x") - sx);
              if (d <= nearestDist) {
                nearestDist = d;
                nearestId = peak.id;
              }
            }
            if (nearestId) onRemovePeakRef.current?.(nearestId);
          } else {
            const apex = apexNear(active, clickMz);
            if (apex) onAddPeakRef.current?.(apex.mz, apex.intensity);
          }
          return;
        }
        const loMz = plot.posToVal(aPx, "x");
        const hiMz = plot.posToVal(bPx, "x");
        if (mode === "delete") {
          for (const peak of peaksRef.current) {
            const m = peak.centroid ?? peak.mz;
            if (m >= loMz && m <= hiMz) onRemovePeakRef.current?.(peak.id);
          }
        } else {
          const apex = apexInRange(active, loMz, hiMz);
          if (apex) onAddPeakRef.current?.(apex.mz, apex.intensity);
        }
      };

      over.addEventListener("contextmenu", onContext);
      over.addEventListener("mousedown", onDown);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return () => {
        over.removeEventListener("contextmenu", onContext);
        over.removeEventListener("mousedown", onDown);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        removeBox();
      };
    }, [regionMode, active]);

    const resetZoom = () => {
      if (!active) return;
      historyRef.current = [];
      applyViewRef.current?.(active.mz[0], active.mz[active.mz.length - 1], false);
    };

    const exportPng = () => {
      // Export the full m/z range with every peak (not the current zoom).
      const url = captureFullPngRef.current();
      if (!url) return;
      const link = document.createElement("a");
      link.href = url;
      link.download = "maldi-spectrum.png";
      link.click();
    };

    const deltaM = measure && measure.b != null ? Math.abs(measure.b - measure.a) : null;

    if (!active) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Import a spectrum to view it here.
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5">
            <Switch id="plot-processed" checked={showProcessed} onCheckedChange={setShowProcessed} disabled={!processed} />
            <label htmlFor="plot-processed" className="text-muted-foreground">
              {showProcessed && processed ? "Processed" : "Raw"}
            </label>
          </div>
          <div className="flex items-center gap-1.5">
            <Switch id="plot-log" checked={logY} onCheckedChange={setLogY} />
            <label htmlFor="plot-log" className="text-muted-foreground">Log y</label>
          </div>
          <div className="flex items-center gap-1.5">
            <Switch id="plot-labels" checked={showLabels} onCheckedChange={setShowLabels} />
            <label htmlFor="plot-labels" className="text-muted-foreground">Labels</label>
          </div>
          <div className="flex items-center gap-1.5">
            <Switch id="plot-isolate" checked={isolate} onCheckedChange={setIsolate} />
            <label htmlFor="plot-isolate" className="flex items-center gap-1 text-muted-foreground">
              <Eye className="h-3 w-3" /> Isolate selection
            </label>
          </div>
          <Button
            size="sm"
            variant={measureMode ? "default" : "outline"}
            className="h-7"
            onClick={() => {
              setMeasureMode((v) => !v);
              setMeasure(null);
              setRegionMode("none");
              setEditSeries(false);
            }}
          >
            <Ruler className="mr-1 h-3.5 w-3.5" />
            Measure Δm
          </Button>
          {onAddPeak && (
            <Button
              size="sm"
              variant={regionMode === "add" ? "default" : "outline"}
              className="h-7"
              onClick={() => {
                setRegionMode((v) => (v === "add" ? "none" : "add"));
                setMeasureMode(false);
                setMeasure(null);
                setEditSeries(false);
              }}
            >
              <Crosshair className="mr-1 h-3.5 w-3.5" />
              Add peak
            </Button>
          )}
          {onRemovePeak && (
            <Button
              size="sm"
              variant={regionMode === "delete" ? "destructive" : "outline"}
              className="h-7"
              onClick={() => {
                setRegionMode((v) => (v === "delete" ? "none" : "delete"));
                setMeasureMode(false);
                setMeasure(null);
                setEditSeries(false);
              }}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              Delete peaks
            </Button>
          )}
          {onToggleSeriesMember && (
            <Button
              size="sm"
              variant={editSeries ? "default" : "outline"}
              className="h-7"
              onClick={() => {
                const next = !editSeries;
                setEditSeries(next);
                if (next) setIsolate(false); // reveal every peak so any can be added
                setMeasureMode(false);
                setMeasure(null);
                setRegionMode("none");
              }}
            >
              <ListPlus className="mr-1 h-3.5 w-3.5" />
              Edit ladder
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-7" onClick={resetZoom}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            Reset zoom
          </Button>
          <Button size="sm" variant="outline" className="h-7" onClick={exportPng}>
            <Download className="mr-1 h-3.5 w-3.5" />
            PNG
          </Button>

          <div className="ml-auto flex shrink-0 items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground">
            {/* Fixed width + DOM-updated text so the hover readout never changes the
                toolbar's layout — the reflow that made the plot "shake" on hover. */}
            <span ref={readoutRef} className="inline-block w-[150px] whitespace-nowrap text-right leading-5">
              &nbsp;
            </span>
            {deltaM != null && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">
                Δm {deltaM.toFixed(3)} Da
              </span>
            )}
          </div>
        </div>
        <div ref={containerRef} className="min-h-0 flex-1" />
        <p className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          <Tag className="h-3 w-3" />
          {measureMode
            ? "Click two points to measure the mass difference."
            : editSeries
              ? "Click a peak to add/remove it from the selected ladder · left-drag still zooms."
              : regionMode === "add"
                ? "Right-click-drag a box over a peak to add it (or click to snap to the nearest apex) · left-drag still zooms."
                : regionMode === "delete"
                  ? "Right-click-drag a red box to delete every peak inside it (or click a peak to remove it) · left-drag still zooms."
                  : "Drag to zoom · double-click to zoom out · scroll to scale the y-axis."}
        </p>
      </div>
    );
  },
);
