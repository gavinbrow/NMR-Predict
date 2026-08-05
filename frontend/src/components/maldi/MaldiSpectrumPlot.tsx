import { Crosshair, Download, Eye, ListPlus, Ruler, RotateCcw, Tag, Trash2 } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { applyOffset, downsample, normalizeTrace, peakMarkerScale, resampleOntoGappy, sliceRange, unionGrid } from "@/lib/maldi/view";
import type { Peak, SpectrumData } from "@/lib/maldi/types";

/** Imperative handle so the page can grab the rendered canvas for reports. */
export interface MaldiSpectrumPlotHandle {
  /**
   * Snapshot the rendered canvas at the FULL m/z range (every peak, not the
   * current zoom). `primaryOnly` hides overlay traces for the grab so a PNG or
   * report about the active document doesn't silently contain the other open
   * documents' traces — then restores both the view and the overlay visibility.
   */
  getPng: (opts?: { primaryOnly?: boolean }) => string | null;
  /**
   * Snapshot the rendered canvas for a report: full m/z range, all assigned
   * series shown in their ladder colours, and no isolation. Restores the user's
   * on-screen state after the capture.
   */
  getReportPng: () => string | null;
}

/** A simulated isotope stick (m/z, relative abundance 0..1) drawn over the data. */
export interface OverlayStick {
  mz: number;
  abundance: number;
}

/**
 * One document rendered as a trace on the plot. The plot draws the set of
 * VISIBLE documents; it does not care which one is ACTIVE. Selecting a
 * document changes only what analysis acts on — the rendered picture (x
 * range, y scale, normalisation, colours, offsets, draw order) is identical
 * before and after a selection change; the only visible difference is stroke
 * emphasis (the active trace is thicker + full opacity, the rest are thinner
 * + ~60% opacity). Draw order is document order, never selection order.
 */
export interface PlotTrace {
  id: string;
  name: string;
  spectrum: SpectrumData;
  /** Per-trace stroke colour (the document's own colour — never black). */
  color: string;
  /** When false the trace is hidden from the plot. Toggling this does NOT rebuild
   *  the uPlot instance — `setSeries(i, {show})` is used so the zoom is preserved. */
  visible: boolean;
  /** Vertical offset (stacked-style) applied to the (optionally normalised) trace. */
  offset: number;
}

interface MaldiSpectrumPlotProps {
  raw: SpectrumData | null;
  processed: SpectrumData | null;
  peaks: Peak[];
  /** Peak ids to emphasize (e.g. a clicked series or repeat-unit ladder). */
  highlightedPeakIds?: Set<string>;
  /** Color-coded peak groups (the distinct ladders of one repeat unit). Each
   *  group's peaks are drawn in its colour; takes precedence over
   *  `highlightedPeakIds` for any peak it contains. */
  highlightGroups?: { color: string; ids: Set<string> }[];
  /**
   * Peak-id → colour map for report captures. When non-empty,
   * `getReportPng()` will temporarily force every listed peak to be coloured
   * (in its series colour) and will ignore the current isolate/highlight state.
   * Hosts build this from the full set of confirmed series.
   */
  reportSeriesColors?: Map<string, string>;
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
  /**
   * ALL open documents, in document order, the active one INCLUDED. The plot
   * renders the set of visible documents and does not care which one is
   * active. Draw order is document order; the active trace is emphasised
   * (thicker + full opacity) but is otherwise just another row in the list.
   * Changes to a trace's `color`/`visible`/`offset` are applied in place — the
   * uPlot instance is NOT rebuilt, so zoom is preserved.
   */
  traces: PlotTrace[];
  /** Id of the active trace (emphasised) or null. Switching this MUST NOT
   *  destroy/recreate the uPlot instance; only the in-place styling effect
   *  patches width/alpha/colour and calls `redraw()`. */
  activeTraceId: string | null;
  /**
   * Scale every trace to a 100 % max. Default ON when more than one document is
   * visible, OFF for a single document — a weak spectrum is invisible under a
   * strong one, but normalising a lone spectrum would change today's behaviour
   * and the Peak table's intensity numbers (which read the primary, un-normalised).
   */
  normalize?: boolean;
  /**
   * When set, draw a single `active − reference` trace INSTEAD of the primary
   * trace. The reference is the first visible overlay (the user marks one as
   * "reference" in the Documents panel). The wheel handler pins y-min at 0 for
   * ordinary spectra; in difference mode it switches to cursor-centred y-zoom
   * moving both bounds (a signed delta trace has negative excursions).
   */
  differenceWith?: SpectrumData | null;
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
      reportSeriesColors,
      overlaySticks,
      onAddPeak,
      onRemovePeak,
      onToggleSeriesMember,
      isolate: isolateProp,
      onIsolateChange,
      traces,
      activeTraceId,
      normalize,
      differenceWith,
    }: MaldiSpectrumPlotProps,
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const plotRef = useRef<uPlot | null>(null);
    const [showProcessed, setShowProcessed] = useState(true);
    const [showLabels, setShowLabels] = useState(true);
    const [logY, setLogY] = useState(false);
    // Reflected into a ref so the in-place styling effect can read `logY`
    // without listing it in its deps (a logY change rebuilds the plot via the
    // construction effect; the in-place effect only needs the current value
    // for its inline scale-pinning fallback).
    const logYRef = useRef(false);
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

    // The spectrum actually displayed for the ACTIVE document (processed when
    // available and toggled on). `raw`/`processed` describe the active document
    // only; the in-plot "show processed" toggle reads them. The other traces
    // carry their own stored spectrum via `traces`.
    const active = useMemo<SpectrumData | null>(() => {
      if (showProcessed && processed) return processed;
      return raw;
    }, [showProcessed, processed, raw]);

    // The active trace's PlotTrace row (looked up by id). Its `spectrum` is
    // substituted with the live `processed ?? raw` choice above so editing the
    // active document's pipeline reflects on the plot immediately.
    const activeTrace = useMemo<PlotTrace | null>(() => {
      const t = traces.find((x) => x.id === activeTraceId);
      if (!t) return null;
      const spectrum = active ?? t.spectrum;
      return { ...t, spectrum };
    }, [traces, activeTraceId, active]);

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
    const reportSeriesColorsRef = useRef(reportSeriesColors);
    const measureRef = useRef(measure);
    const overlayRef = useRef(overlaySticks);
    const isolateRef = useRef(isolate);
    const onAddPeakRef = useRef(onAddPeak);
    const onRemovePeakRef = useRef(onRemovePeak);
    const onToggleSeriesMemberRef = useRef(onToggleSeriesMember);
    const activeRef = useRef<SpectrumData | null>(null);
    const activeTraceRef = useRef<PlotTrace | null>(null);
    const regionModeRef = useRef(regionMode);
    // Traces / normalize / difference: read via refs inside the plot effect so
    // a colour / visibility / offset change can be applied in place (via
    // `setSeries`) WITHOUT rebuilding the uPlot instance and losing zoom. The
    // `useEffect` that owns the plot reads these refs, not the props directly,
    // so the deps array stays `[traceIdsKey, logY, normalize, differenceOn]`
    // and the rebuild stays scoped to a trace-set change, a log-y toggle, a
    // normalize toggle, or a difference toggle — switching the active document
    // is handled by the in-place styling effect and never rebuilds.
    const tracesRef = useRef<PlotTrace[]>([]);
    const activeTraceIdRef = useRef<string | null>(null);
    const normalizeRef = useRef<boolean | undefined>(undefined);
    const differenceWithRef = useRef<SpectrumData | null>(null);
    // The transform that took the active trace's RAW counts to plotted units
    // (FP3): `scale = peakMarkerScale(normalize, activeWindowMax)` and the
    // per-trace offset. `difference` flags the signed-delta case, where the
    // peak marker's height is read from the rendered array instead.
    const activeTransformRef = useRef<{ scale: number; offset: number; difference: boolean }>({
      scale: 1,
      offset: 0,
      difference: false,
    });
    logYRef.current = logY;
    regionModeRef.current = regionMode;
    onToggleSeriesMemberRef.current = onToggleSeriesMember;
    peaksRef.current = peaks;
    showLabelsRef.current = showLabels;
    highlightRef.current = highlightedPeakIds;
    groupColorsRef.current = groupColors;
    reportSeriesColorsRef.current = reportSeriesColors;
    measureRef.current = measure;
    overlayRef.current = overlaySticks;
    isolateRef.current = isolate;
    onAddPeakRef.current = onAddPeak;
    onRemovePeakRef.current = onRemovePeak;
    activeRef.current = active;
    activeTraceRef.current = activeTrace;
    tracesRef.current = traces;
    activeTraceIdRef.current = activeTraceId;
    normalizeRef.current = normalize;
    differenceWithRef.current = differenceWith ?? null;

    // Zoom-history machinery (persists across redraws; reset on a new spectrum).
    const historyRef = useRef<{ min: number; max: number }[]>([]);
    const viewRangeRef = useRef<{ min: number; max: number }>({ min: 0, max: 1 });
    // Ref-backed y range so the `range` callback on the linear y scale can return
    // the computed extent without depending on uPlot's per-series min/max caches
    // (which are never populated here because we always `setData(view, false)`).
    // uPlot consults this callback on every scale commit, so storing the pair
    // here keeps the y range immune to the empty caches while leaving uPlot's
    // autoscale machinery (and therefore series path generation) fully enabled.
    const yRangeRef = useRef<[number, number] | null>(null);
    // Mirror of `yRangeRef` for the x scale: uPlot's `setScale("x", …)` call
    // issued synchronously right after `new uPlot(...)` is dropped because the
    // instance is not yet ready to commit it. A ref-backed `range` callback on
    // the x scale (just like y) is consulted on every later commit, so the
    // initial x range survives the construction race.
    const xRangeRef = useRef<[number, number] | null>(null);
    // Identifies the current spectrum's m/z domain so we can tell a *reprocess*
    // (baseline/smoothing toggles — same domain) from a brand-new import, and
    // preserve the zoom across the former.
    const domainKeyRef = useRef<string>("");
    // Set inside the plot effect so the toolbar's Reset button can re-apply a view.
    const applyViewRef = useRef<((lo: number, hi: number, pushHistory: boolean) => void) | null>(null);

    // --- Trace identity keys ----------------------------------------------------
    // `traceIdsKey` — a compact key identifying WHICH traces (by id, in order)
    //   the plot was built with. A change here (a trace added or removed) means
    //   the series list length changed and the uPlot instance must be rebuilt;
    //   a colour/visibility/offset/active change leaves it stable.
    // `traceDataKey` — covers everything `setData` would need to reflect
    //   (offset + normalize + difference, plus the id key for safety). Used by
    //   the in-place styling effect to know whether to swap the data array.
    // Both are derived from props via `useMemo` so the same string identity is
    // returned across renders that don't change the inputs.
    const traceIdsKey = useMemo(
      () => traces.map((t) => t.id).join("|"),
      [traces],
    );
    const differenceOn = differenceWith != null;
    const traceDataKey = (
      list: PlotTrace[],
      norm: boolean | undefined,
      diff: boolean,
    ): string =>
      `${list.map((t) => `${t.id}:${t.offset ?? 0}`).join("|")}#${norm ? 1 : 0}#${diff ? 1 : 0}`;
    const traceDataKeyRef = useRef<string>("");

    // Capture the spectrum as a PNG showing the FULL m/z range (every peak), not
    // the user's current zoom. We momentarily apply the full view, snapshot the
    // canvas, then restore the previous view — uPlot redraws synchronously, so the
    // flip is invisible. Used by both the report export and the toolbar PNG button.
    //
    // `primaryOnly` hides the overlay traces for the grab (via `setSeries(i,
    // {show:false})`) then restores their previous visibility — so a PNG or PDF
    // report about the active document doesn't silently embed the other open
    // documents' traces. (WP3 §9 — once overlays share the canvas, the report's
    // `spectrumPng` would otherwise contain every visible document.)
    const doCapturePng = (primaryOnly: boolean, reportMode: boolean): string | null => {
      const plot = plotRef.current;
      if (!plot) return null;
      const apply = applyViewRef.current;
      const act = activeRef.current;
      // Remember each non-active trace's current `show` so we can restore it
      // exactly. `primaryOnly` hides every trace EXCEPT the active one for the
      // grab (via `setSeries(i, {show:false})`) then restores their previous
      // visibility — so a PNG or PDF report about the active document doesn't
      // silently embed the other open documents' traces.
      const savedShow: boolean[] = [];
      if (primaryOnly) {
        const activeId = activeTraceIdRef.current;
        for (let i = 0; i < tracesRef.current.length; i += 1) {
          const t = tracesRef.current[i];
          // uPlot series indices: 0 = x, 1.. = traces in document order.
          const seriesIdx = i + 1;
          const s = plot.series[seriesIdx];
          savedShow[i] = s ? Boolean(s.show) : false;
          if (t.id !== activeId && s) plot.setSeries(seriesIdx, { show: false });
        }
      }
      let url: string | null = null;
      try {
        if (apply && act && act.mz.length > 1) {
          // Reset to the union m/z range across every trace so the PNG captures
          // every peak of every visible document, then restore the user's view.
          let unionMin = act.mz[0];
          let unionMax = act.mz[act.mz.length - 1];
          for (const t of tracesRef.current) {
            if (t.spectrum.mz.length === 0) continue;
            if (t.spectrum.mz[0] < unionMin) unionMin = t.spectrum.mz[0];
            if (t.spectrum.mz[t.spectrum.mz.length - 1] > unionMax) unionMax = t.spectrum.mz[t.spectrum.mz.length - 1];
          }
          const saved = { ...viewRangeRef.current };
          apply(unionMin, unionMax, false); // full range → all peaks
          url = plot.ctx.canvas.toDataURL("image/png");
          apply(saved.min, saved.max, false); // restore the user's view
        } else {
          url = plot.ctx.canvas.toDataURL("image/png");
        }
      } finally {
        // Restore trace visibility even if `apply` threw.
        if (primaryOnly) {
          for (let i = 0; i < tracesRef.current.length; i += 1) {
            const seriesIdx = i + 1;
            if (plot.series[seriesIdx]) plot.setSeries(seriesIdx, { show: savedShow[i] });
          }
        }
      }
      return url;
    };

    const captureFullPng = (primaryOnly = false): string | null => doCapturePng(primaryOnly, false);

    const captureReportPng = (): string | null => {
      const reportColors = reportSeriesColorsRef.current;
      const plot = plotRef.current;
      if (!plot) return null;
      const savedIsolate = isolateRef.current;
      const savedHighlight = highlightRef.current;
      const savedGroupColors = groupColorsRef.current;
      const reportGroupSet = reportColors && reportColors.size > 0
        ? new Map(reportColors)
        : new Map<string, string>();
      try {
        isolateRef.current = false;
        highlightRef.current = undefined;
        groupColorsRef.current = reportGroupSet;
        plot.redraw();
        const url = captureFullPng(true);
        return url;
      } finally {
        isolateRef.current = savedIsolate;
        highlightRef.current = savedHighlight;
        groupColorsRef.current = savedGroupColors;
        plot.redraw();
      }
    };

    const captureFullPngRef = useRef(captureFullPng);
    captureFullPngRef.current = captureFullPng;
    const captureReportPngRef = useRef(captureReportPng);
    captureReportPngRef.current = captureReportPng;

    useImperativeHandle(
      ref,
      () => ({
        getPng: (opts?: { primaryOnly?: boolean }) => captureFullPngRef.current(opts?.primaryOnly ?? false),
        getReportPng: () => captureReportPngRef.current(),
      }),
      [],
    );

    // AlignedData for an x-window, downsampling when dense. Always returns ≥2
    // points so a too-tight zoom never feeds uPlot an empty/degenerate array
    // (which would throw on the next draw).
    //
    // Data layout: `data = [grid, ...traces in document order]`. Hidden traces
    // KEEP their column (filled with NaN) so series indices never shift; they
    // are hidden via `setSeries(i, {show:false})`. Series index `i+1`
    // corresponds to `traces[i]`.
    //
    // If EXACTLY ONE trace is visible the grid is that trace's own
    // sliceRange + downsample envelope (pixel-identical to the single-document
    // path). If TWO OR MORE are visible the grid is a uniform ascending
    // `MAX_RENDER_POINTS`-sample grid spanning the UNION m/z range of every
    // visible trace intersected with `[lo, hi]`; every trace (active included)
    // is resampled onto it with `resampleOntoGappy` so a narrower trace gaps
    // out instead of truncating the wider ones. Normalisation and offset are
    // per-trace on that trace's own resampled window — there is no primary
    // special case, so switching the active document cannot change any trace's
    // scaling (WP3 §2).
    const buildView = (lo: number, hi: number): AlignedData => {
      const traces = tracesRef.current;
      const activeId = activeTraceIdRef.current;
      const activeSpec = activeRef.current;
      const ref = differenceWithRef.current;
      const norm = normalizeRef.current;
      const activeOffset = traces.find((t) => t.id === activeId)?.offset ?? 0;
      const effectiveSpectrum = (t: PlotTrace): SpectrumData =>
        t.id === activeId && activeSpec ? activeSpec : t.spectrum;
      const visibleTraces = traces.filter(
        (t) => t.visible !== false && effectiveSpectrum(t).mz.length > 0,
      );

      let activeWindowMax = 0;
      const recordActiveMax = (arr: Float64Array) => {
        if (activeId == null) return;
        for (let i = 0; i < arr.length; i += 1) {
          const v = arr[i];
          if (Number.isFinite(v) && v > activeWindowMax) activeWindowMax = v;
        }
      };

      if (visibleTraces.length === 0) {
        activeTransformRef.current = {
          scale: peakMarkerScale(!!norm, 0),
          offset: activeOffset,
          difference: ref != null,
        };
        const cols: (number[] | Float64Array)[] = [new Float64Array(0)];
        for (let i = 0; i < traces.length; i += 1) cols.push(new Float64Array(0));
        return cols as unknown as AlignedData;
      }

      let grid: Float64Array;
      const cols: (number[] | Float64Array)[] = [];

      if (visibleTraces.length === 1) {
        // --- Single visible trace: today's sliceRange + downsample path -----
        const t = visibleTraces[0];
        const spectrum = effectiveSpectrum(t);
        const n = spectrum.mz.length;
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
        grid = view.mz as Float64Array;
        cols.push(grid as unknown as number[]);
        for (const t0 of traces) {
          if (t0.id !== t.id) {
            cols.push(new Float64Array(grid.length).fill(NaN));
            continue;
          }
          let y: number[] | Float64Array = view.intensity as unknown as number[];
          if (t0.id === activeId && ref && ref.mz.length > 0) {
            const activeY = norm ? normalizeTrace(view.intensity) : (view.intensity as Float64Array);
            recordActiveMax(activeY);
            const refSampled = resampleOntoGappy(view.mz, ref);
            const refY = norm ? normalizeTrace(refSampled) : refSampled;
            const diff = new Float64Array(view.mz.length);
            for (let i = 0; i < diff.length; i += 1) {
              const a = activeY[i];
              const r = refY[i];
              diff[i] = Number.isFinite(a) && Number.isFinite(r) ? a - r : NaN;
            }
            y = applyOffset(diff, t0.offset ?? 0);
          } else {
            recordActiveMax(view.intensity as Float64Array);
            y = norm ? normalizeTrace(view.intensity) : (view.intensity as Float64Array);
            y = applyOffset(y, t0.offset ?? 0);
          }
          cols.push(y);
        }
      } else {
        // --- Two or more visible: union-range uniform grid ------------------
        const visSpecs = visibleTraces.map(effectiveSpectrum);
        grid = unionGrid(visSpecs, lo, hi, MAX_RENDER_POINTS);
        if (grid.length < 2) {
          // Degenerate union (e.g. every visible trace is a single sample) —
          // fall back to the first visible trace's own range so uPlot still
          // gets a usable axis.
          const first = visSpecs[0];
          grid = Float64Array.from([first.mz[0], first.mz[first.mz.length - 1]]);
        }
        cols.push(grid as unknown as number[]);
        for (const t0 of traces) {
          const spec = effectiveSpectrum(t0);
          const isVisible = t0.visible !== false && spec.mz.length > 0;
          if (!isVisible) {
            cols.push(new Float64Array(grid.length).fill(NaN));
            continue;
          }
          const sampled = resampleOntoGappy(grid, spec);
          if (t0.id === activeId && ref && ref.mz.length > 0) {
            const activeY = norm ? normalizeTrace(sampled) : sampled;
            recordActiveMax(activeY);
            const refSampled = resampleOntoGappy(grid, ref);
            const refY = norm ? normalizeTrace(refSampled) : refSampled;
            const diff = new Float64Array(grid.length);
            for (let i = 0; i < diff.length; i += 1) {
              const a = activeY[i];
              const r = refY[i];
              diff[i] = Number.isFinite(a) && Number.isFinite(r) ? a - r : NaN;
            }
            cols.push(applyOffset(diff, t0.offset ?? 0));
          } else {
            if (t0.id === activeId) recordActiveMax(sampled);
            const normed = norm ? normalizeTrace(sampled) : sampled;
            cols.push(applyOffset(normed, t0.offset ?? 0));
          }
        }
      }

      // If the active trace was hidden (so its max was never recorded), still
      // compute its window max by resampling onto the grid so the peak-marker
      // transform is correct.
      if (activeId != null && activeSpec && activeWindowMax === 0 && grid.length > 0) {
        const sampled = resampleOntoGappy(grid, activeSpec);
        recordActiveMax(sampled);
      }

      activeTransformRef.current = {
        scale: peakMarkerScale(!!norm, activeWindowMax),
        offset: activeOffset,
        difference: ref != null,
      };
      return cols as unknown as AlignedData;
    };

    const windowMax = (data: AlignedData): number => {
      let m = 0;
      // Scan every visible y-series. A taller trace would otherwise be clipped
      // by the y-autoscale (WP3 §4). NaN (out-of-range gaps) and negatives (a
      // signed difference trace) are skipped — `m` is the positive max used to
      // pin the y-axis top.
      for (let s = 1; s < data.length; s += 1) {
        const ys = data[s] as number[] | Float64Array;
        // Skip hidden trace series entirely — a hidden taller trace must not
        // push the y-scale up and shrink the visible traces.
        const tr = tracesRef.current[s - 1];
        if (tr && tr.visible === false) continue;
        for (let i = 0; i < ys.length; i += 1) {
          const v = ys[i];
          if (Number.isFinite(v) && v > m) m = v;
        }
      }
      return m;
    };

    const windowMin = (data: AlignedData): number => {
      let m = 0;
      for (let s = 1; s < data.length; s += 1) {
        const ys = data[s] as number[] | Float64Array;
        const tr = tracesRef.current[s - 1];
        if (tr && tr.visible === false) continue;
        for (let i = 0; i < ys.length; i += 1) {
          const v = ys[i];
          if (Number.isFinite(v) && v < m) m = v;
        }
      }
      return m;
    };

    // Create / recreate the plot when the trace set, scale type, normalize, or
    // difference toggle changes. `activeTraceId` is DELIBERATELY NOT in the dep
    // list — switching the active document must never destroy and recreate the
    // uPlot instance (the in-place styling effect patches width/alpha/colour
    // and calls `redraw()` instead). The zoom-preservation path relies on a
    // domain key derived from the UNION m/z range across all traces, so a
    // document switch cannot change the domain and reset the view.
    useEffect(() => {
      if (!containerRef.current) return;
      const container = containerRef.current;
      // Union m/z range across every trace — the domain the plot renders, used
      // for the keepZoom check so a selection change (same traces, different
      // active) preserves the zoom. The active document is itself one of the
      // traces in `tracesRef.current`, so seeding from it is redundant — fold
      // over every trace and bail out if none has any data.
      let unionMin = Infinity;
      let unionMax = -Infinity;
      for (const t of tracesRef.current) {
        if (t.spectrum.mz.length === 0) continue;
        if (t.spectrum.mz[0] < unionMin) unionMin = t.spectrum.mz[0];
        if (t.spectrum.mz[t.spectrum.mz.length - 1] > unionMax) unionMax = t.spectrum.mz[t.spectrum.mz.length - 1];
      }
      if (!Number.isFinite(unionMin) || !Number.isFinite(unionMax)) return;
      const fullRange = () => ({ min: unionMin, max: unionMax });

      // Reprocessing (baseline/smooth/normalize, or a log-y toggle) keeps the m/z
      // domain identical; only a new import / crop / calibrate changes it. Preserve
      // the current zoom across the former so tweaking a setting doesn't snap the
      // view back to full — the behaviour the user found maddening. The domain key
      // is the UNION range across all traces, so switching the active document
      // (which does not change the trace set) cannot change the domain.
      const domainKey = `${unionMin}|${unionMax}|${tracesRef.current.map((t) => t.id).join("|")}`;
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

      const drawPeaks = (u: uPlot) => {
        const ctx = u.ctx;
        const list = peaksRef.current;
        const highlights = highlightRef.current;
        const groupColors = groupColorsRef.current;
        const hasHighlight = (highlights?.size ?? 0) > 0 || groupColors.size > 0;
        const isolating = isolateRef.current && hasHighlight;
        const { left, top, width, height } = u.bbox;
        const baseline = top + height;
        const activeAi = tracesRef.current.findIndex((t) => t.id === activeTraceIdRef.current);
        const activeIdx = activeAi >= 0 ? activeAi + 1 : 1;
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
          // Peak markers must be drawn in the plot's y-space (FP3). The active
          // trace's column is 0-100 whenever Normalize is on, but `peak.intensity`
          // is RAW counts; without the transform the marker lands orders of
          // magnitude above the canvas and the clip rect discards it. Apply the
          // recorded scale + offset so sticks, arrowheads and m/z labels all
          // move together. In difference mode the active column is
          // `active − reference` (no scalar transform is correct) — look the
          // height up from the rendered array at the peak's nearest x index and
          // skip the marker when that sample is NaN.
          const tr = activeTransformRef.current;
          let yVal: number;
          if (tr.difference) {
            const idx = u.valToIdx(mz);
            const xs = u.data[0] as ArrayLike<number>;
            const ys = u.data[activeIdx] as ArrayLike<number>;
            const sampleMz = xs[idx];
            const sampleVal = ys[idx] as number;
            if (
              sampleMz == null ||
              !Number.isFinite(sampleMz) ||
              sampleVal == null ||
              !Number.isFinite(sampleVal)
            ) {
              continue;
            }
            yVal = Math.max(sampleVal, u.scales.y.min ?? 0);
          } else {
            const plotted = peak.intensity * tr.scale + tr.offset;
            yVal = Math.max(plotted, u.scales.y.min ?? 0);
          }
          const y = u.valToPos(yVal, "y", true);

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
      //
      // In difference mode (`differenceWith` set) the primary column carries the
      // signed `active − reference` trace, so y is centred on 0 and spans both
      // signs — never pinned at the bottom (WP3 §8).
      const applyView = (u: uPlot, lo: number, hi: number, pushHistory: boolean) => {
        if (!(hi > lo)) return;
        if (pushHistory) historyRef.current.push({ ...viewRangeRef.current });
        viewRangeRef.current = { min: lo, max: hi };
        const view = buildView(lo, hi);
        u.setData(view, false);
        xRangeRef.current = [lo, hi];
        u.setScale("x", { min: lo, max: hi });
        if (!logY) {
          if (differenceWithRef.current) {
            // Signed delta: centre on 0, span both excursions.
            const ymax = windowMax(view);
            const ymin = windowMin(view);
            const span = Math.max(ymax, -ymin, 1);
            yRangeRef.current = [-span * 1.05, span * 1.05];
            u.setScale("y", { min: -span * 1.05, max: span * 1.05 });
          } else {
            const ymax = windowMax(view);
            yRangeRef.current = [0, ymax > 0 ? ymax * 1.05 : 1];
            u.setScale("y", { min: 0, max: ymax > 0 ? ymax * 1.05 : 1 });
          }
        }
      };

      const opts: Options = {
        width: container.clientWidth,
        height: container.clientHeight,
        // time:false → x axis is numeric m/z, not a date/time axis. uPlot's
        // autoscale machinery is left fully enabled: disabling `auto` would also
        // stop uPlot computing the per-series visible index range it needs to
        // BUILD the series paths (s._paths would never be generated and nothing
        // would be drawn). Control of the x range comes from `applyView` pinning
        // it via `setScale("x", …)`, not from disabling autoscale.
        //
        // Linear y uses a `range` callback backed by `yRangeRef` so a scale
        // commit (a zoom, an x pin, a resize, a redraw) can NEVER fall back to
        // the [0,1] default. uPlot consults the callback on EVERY commit and we
        // keep the ref in sync with the same pair passed to `setScale("y", …)`,
        // so the y range is immune to uPlot's unpopulated per-series min/max
        // caches (never filled because this component always calls
        // `setData(view, false)` to preserve zoom). Log y keeps `distr: 3`
        // exactly as before — log mode has no range callback.
        scales: {
          x: { time: false, range: () => xRangeRef.current ?? [0, 1] },
          y: logY ? { distr: 3 } : { range: () => yRangeRef.current ?? [0, 1] },
        },
        // setScale:false → uPlot draws the drag rectangle but leaves the zoom to
        // our setSelect hook, which swaps in the full-res slice atomically.
        cursor: { drag: { x: true, y: false, setScale: false }, bind: { dblclick: () => null } },
        // Legend: when more than one trace is present, turn the uPlot legend on
        // so the plot itself names every visible trace (a backup for the
        // Documents panel which is the canonical legend). One or the other — the
        // panel is primary, but `legend.show:false` would name nothing if the
        // user collapses the panel (WP3 §6).
        legend: { show: tracesRef.current.length > 1, live: false },
        axes: [
          { label: "m/z", labelGap: 8, grid: { stroke: "#e2e8f0", width: 1 } },
          {
            label: normalizeRef.current ? "rel. intensity (%)" : "Intensity",
            // Reserve a wide gutter and abbreviate tick values so the numbers never
            // overlap the rotated axis label.
            size: 64,
            labelGap: 8,
            labelSize: 14,
            values: (_u, splits) => splits.map((s) => compactNumber(s as number)),
            grid: { stroke: "#e2e8f0", width: 1 },
          },
        ],
        // One series per trace, in document order. Every trace draws in its own
        // document colour (never black); the active trace is emphasised
        // (thicker + full opacity), the rest are ~60% opacity + thinner. Draw
        // order is document order, never selection order.
        series: [
          {},
          ...tracesRef.current.map((t) => ({
            label: t.name,
            stroke: t.color,
            width: t.id === activeTraceIdRef.current ? 1.6 : 0.8,
            alpha: t.id === activeTraceIdRef.current ? 1 : 0.6,
            points: { show: false },
            show: t.visible !== false,
          })),
        ],
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
              const ai = tracesRef.current.findIndex((t) => t.id === activeTraceIdRef.current);
              const ys = u.data[ai >= 0 ? ai + 1 : 1];
              const mz = xs[idx] as number | undefined;
              // After a zoom the data array is swapped; a stale cursor idx can
              // point past the shorter array, leaving mz undefined.
              if (mz == null || !Number.isFinite(mz)) {
                el.textContent = " ";
                return;
              }
              const v = ys[idx] as number;
              if (v == null || !Number.isFinite(v)) {
                el.textContent = `m/z ${mz.toFixed(3)}`;
                return;
              }
              el.textContent = `m/z ${mz.toFixed(3)} · ${v.toFixed(0)}`;
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

      const plot = new uPlot(opts, buildView(initLo, initHi), container);
      plotRef.current = plot;
      applyViewRef.current = (lo, hi, push) => applyView(plot, lo, hi, push);
      // ALWAYS pin the x/y scales to the chosen window after construction. The
      // constructor's own autoscale does not leave a usable range here (x ends
      // up {min:null,max:null} and y falls back to {min:0,max:1}), which is the
      // blank-plot-on-first-load bug. When `keepZoom` is true `initLo/initHi`
      // are the preserved zoom window; when it is false they are the full union
      // range — either way the scales must end up explicitly set.
      applyView(plot, initLo, initHi, false);

      // Double-click → step back out one zoom level (or all the way to full).
      const onDblClick = () => {
        const prev = historyRef.current.pop();
        const target = prev ?? fullRange();
        applyView(plot, target.min, target.max, false);
      };

      // Scroll wheel → scale the y-axis (reveal small peaks without zooming x).
      // For ordinary spectra the min stays pinned at the baseline (0) so peaks
      // grow upward rather than the whole trace sliding up the view.
      //
      // In difference mode (`differenceWith` set) the trace is a SIGNED delta
      // with negative excursions, so pinning y-min at 0 would clip them and the
      // wheel would zoom only the positive half. Instead the wheel zooms the
      // y-axis around the cursor — both bounds move — mirroring `CompareView`'s
      // `:141-157` difference-mode behaviour (WP3 §8).
      const onWheel = (event: WheelEvent) => {
        if (logY) return;
        event.preventDefault();
        const y = plot.scales.y;
        if (differenceWithRef.current) {
          if (!y || y.min == null || y.max == null) return;
          const rect = plot.over.getBoundingClientRect();
          const focus = plot.posToVal(event.clientY - rect.top, "y");
          const lo = y.min;
          const hi = y.max;
          const factor = event.deltaY < 0 ? 0.8 : 1.25;
          const span = hi - lo || Math.abs(hi) || 1;
          let newLo = focus - (focus - lo) * factor;
          let newHi = focus + (hi - focus) * factor;
          if (newHi - newLo < span * 0.02) {
            newLo = focus - span * 0.01;
            newHi = focus + span * 0.01;
          }
          yRangeRef.current = [newLo, newHi];
          plot.setScale("y", { min: newLo, max: newHi });
          return;
        }
        const curMax = y.max ?? windowMax(plot.data);
        const curMin = y.min ?? 0;
        const factor = event.deltaY < 0 ? 0.8 : 1.25; // scroll up → smaller max → taller peaks
        const newMax = Math.max(curMin + 1e-9, curMax * factor);
        yRangeRef.current = [curMin, newMax];
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
       
    }, [traceIdsKey, logY, normalize, differenceOn]);

    // Apply trace styling changes IN PLACE (no uPlot rebuild) so zoom is
    // preserved when the user toggles a trace's colour / visibility / offset in
    // the Documents panel, AND when the active document changes. Only
    // visibility and colour are uPlot series properties; offset/normalize/
    // difference change the DATA, so when they change we rebuild the data
    // array (cheap — `setData` keeps the existing instance and its zoom). The
    // legend follows the series `label`, so a rename updates the legend through
    // `setSeries` too. Switching the active document only patches width/alpha
    // (and possibly colour, when the active document is recoloured) and calls
    // `redraw()` — the uPlot instance is never destroyed. (WP3 §5.)
    useEffect(() => {
      const plot = plotRef.current;
      if (!plot) return;
      // The plot's series list length is fixed at build time (1 x + N traces).
      // If the trace set changed length the plot was rebuilt by the effect
      // above — bail here so this effect doesn't race a fresh instance.
      if (plot.series.length !== 1 + tracesRef.current.length) return;
      const activeId = activeTraceId;
      let needsData = false;
      let needsRedraw = false;
      tracesRef.current.forEach((t, i) => {
        const seriesIdx = i + 1;
        const s = plot.series[seriesIdx];
        if (!s) return;
        const show = t.visible !== false;
        if (s.show !== show) {
          plot.setSeries(seriesIdx, { show });
          needsRedraw = true;
        }
        const isActive = t.id === activeId;
        const stroke = t.color;
        // uPlot's `setSeries` only accepts `show`/`focus`; stroke + label are
        // mutated in place and then `redraw()` repaints. `series._stroke` is
        // uPlot's cached resolved stroke (the canvas style actually used on
        // draw); `stroke` is the source (a string or function). Updating both
        // keeps the cache in sync so the next paint picks up the new colour.
        //
        // CRITICAL: uPlot wraps `stroke` in a function via `fnOrSelf` during
        // `initSeries`, then calls `s.stroke(self, si)` in `cacheStrokeFill` on
        // every draw. Storing a raw string here breaks that call ("s.stroke is
        // not a function") and the plot renders blank — the original overlay
        // bug. Wrap the colour in a closure (matching uPlot's own `fnOrSelf`)
        // and invalidate `_stroke` so the next paint re-resolves it. This now
        // covers EVERY trace (active included), so recolouring the active
        // document updates its stroke too.
        const curStroke = (s as unknown as { stroke: unknown }).stroke;
        const curIsFn = typeof curStroke === "function";
        const curStrokeResolved = curIsFn ? (curStroke as () => string)() : (curStroke as string);
        if (curStrokeResolved !== stroke || !curIsFn) {
          (s as unknown as { stroke: () => string }).stroke = () => stroke;
          (s as unknown as { _stroke: string })._stroke = stroke;
          needsRedraw = true;
        }
        // Width + alpha follow the active-trace emphasis. Unlike `stroke` and
        // `fill`, uPlot does NOT wrap `width` in `fnOrSelf`: it reads
        // `s.width` as a plain NUMBER in the draw path
        // (`let width = roundDec(s.width * pxRatio, 3)`), and only strokes when
        // `width > 0`. Assigning a function to `width` makes `s.width * pxRatio`
        // evaluate to NaN, the `NaN > 0` draw guard fails, and uPlot SILENTLY
        // skips stroking that series — no error, no warning, the trace simply
        // never draws (the blank-plot bug). So `width` MUST be a number here;
        // only `stroke`/`fill` take the closure form. The guard also treats a
        // currently-function `width` as needing replacement so an instance
        // already in the bad state is repaired on the next pass.
        const width = isActive ? 1.6 : 0.8;
        const curWidth = (s as unknown as { width: unknown }).width;
        const curWidthResolved = typeof curWidth === "function" ? (curWidth as () => number)() : (curWidth as number);
        if (curWidthResolved !== width || typeof curWidth === "function") {
          (s as unknown as { width: number }).width = width;
          (s as unknown as { _width: number })._width = width;
          needsRedraw = true;
        }
        const alpha = isActive ? 1 : 0.6;
        if ((s as unknown as { alpha?: number }).alpha !== alpha) {
          (s as unknown as { alpha: number }).alpha = alpha;
          needsRedraw = true;
        }
        if (s.label !== t.name) {
          (s as unknown as { label: string }).label = t.name;
          needsRedraw = true;
        }
      });
      // Offset / normalize / difference changes are reflected in the DATA; the
      // cleanest way to apply them is to rebuild the data array (keeps the
      // uPlot instance and its zoom). Every trace column moves.
      if (traceDataKeyRef.current !== traceDataKey(tracesRef.current, normalizeRef.current, differenceWithRef.current != null)) {
        traceDataKeyRef.current = traceDataKey(tracesRef.current, normalizeRef.current, differenceWithRef.current != null);
        needsData = true;
      }
      if (needsData) {
        const lo = viewRangeRef.current.min;
        const hi = viewRangeRef.current.max;
        if (hi > lo) {
          // Re-apply the current view instead of a bare `setData(view, false)`:
          // `applyView` swaps in the data AND re-pins the y scale to it (so a
          // document switch that changes the data key doesn't leave y stuck at
          // a stale 0..1 while the new traces span 0..100 and get clipped away).
          // `push=false` neither pushes a zoom-history entry nor resets x —
          // `setScale("x", {min: lo, max: hi})` is called with the CURRENT
          // viewRangeRef values, so the user's x zoom is preserved. The y
          // re-pin honours logY (skipped) and difference mode (symmetric
          // around 0), mirroring the rebuild path.
          const apply = applyViewRef.current;
          if (apply) {
            apply(lo, hi, false);
          } else {
            // `applyViewRef` should be non-null whenever `plotRef` is (it is
            // set right after `new uPlot` and only nulled when the plot is
            // destroyed). If we ever hit this branch, do NOT fall back to a
            // bare `setData(view, false)` — that swaps the data without
            // pinning scales and reproduces the blank-plot bug (uPlot's
            // autoscale never re-runs, leaving x at {min:null,max:null} and y
            // at the {0,1} range fallback). Pin both scales inline instead,
            // mirroring `applyView`'s linear/difference logic (logY is left
            // untouched — uPlot's log scale autoscales itself).
            const view = buildView(lo, hi);
            plot.setData(view, false);
            xRangeRef.current = [lo, hi];
            plot.setScale("x", { min: lo, max: hi });
            if (!logYRef.current) {
              if (differenceWithRef.current) {
                const ymax = windowMax(view);
                const ymin = windowMin(view);
                const span = Math.max(ymax, -ymin, 1);
                yRangeRef.current = [-span * 1.05, span * 1.05];
                plot.setScale("y", { min: -span * 1.05, max: span * 1.05 });
              } else {
                const ymax = windowMax(view);
                yRangeRef.current = [0, ymax > 0 ? ymax * 1.05 : 1];
                plot.setScale("y", { min: 0, max: ymax > 0 ? ymax * 1.05 : 1 });
              }
            }
          }
        }
        needsRedraw = true;
      }
      if (needsRedraw) plot.redraw();
    }, [traces, activeTraceId, normalize, differenceWith]);

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
      // Reset to the UNION m/z range across every trace so all visible spectra
      // come back into view (resetting to the active trace's range alone would
      // clip the wider ones — the bug this refactor fixes).
      let unionMin = active.mz[0];
      let unionMax = active.mz[active.mz.length - 1];
      for (const t of tracesRef.current) {
        if (t.spectrum.mz.length === 0) continue;
        if (t.spectrum.mz[0] < unionMin) unionMin = t.spectrum.mz[0];
        if (t.spectrum.mz[t.spectrum.mz.length - 1] > unionMax) unionMax = t.spectrum.mz[t.spectrum.mz.length - 1];
      }
      historyRef.current = [];
      applyViewRef.current?.(unionMin, unionMax, false);
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
