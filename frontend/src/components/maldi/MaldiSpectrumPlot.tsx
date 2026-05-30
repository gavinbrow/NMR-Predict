import { Download, Eye, Ruler, RotateCcw, Tag } from "lucide-react";
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
}

/** Above this many points we render a min/max-bucketed view and re-slice on zoom. */
const MAX_RENDER_POINTS = 12000;
/** Bright colour used for highlighted (selected-series) peaks. */
const HIGHLIGHT = "#d946ef";

/** Color for a non-highlighted peak marker by its flag/state. */
function peakColor(peak: Peak): string {
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
    { raw, processed, peaks, highlightedPeakIds, highlightGroups, overlaySticks }: MaldiSpectrumPlotProps,
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const plotRef = useRef<uPlot | null>(null);
    const [showProcessed, setShowProcessed] = useState(true);
    const [showLabels, setShowLabels] = useState(true);
    const [logY, setLogY] = useState(false);
    const [isolate, setIsolate] = useState(false);
    const [measureMode, setMeasureMode] = useState(false);
    const [readout, setReadout] = useState<{ mz: number; intensity: number } | null>(null);
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
    peaksRef.current = peaks;
    showLabelsRef.current = showLabels;
    highlightRef.current = highlightedPeakIds;
    groupColorsRef.current = groupColors;
    measureRef.current = measure;
    overlayRef.current = overlaySticks;
    isolateRef.current = isolate;

    // Zoom-history machinery (persists across redraws; reset on a new spectrum).
    const historyRef = useRef<{ min: number; max: number }[]>([]);
    const viewRangeRef = useRef<{ min: number; max: number }>({ min: 0, max: 1 });
    // Set inside the plot effect so the toolbar's Reset button can re-apply a view.
    const applyViewRef = useRef<((lo: number, hi: number, pushHistory: boolean) => void) | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        getPng: () => (plotRef.current ? plotRef.current.ctx.canvas.toDataURL("image/png") : null),
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
      const fullRange = () => ({ min: active.mz[0], max: active.mz[active.mz.length - 1] });
      historyRef.current = [];
      viewRangeRef.current = fullRange();

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
          { label: "Intensity", grid: { stroke: "#e2e8f0", width: 1 } },
        ],
        series: [{}, { stroke: "#1e293b", width: 1, points: { show: false } }],
        hooks: {
          draw: [drawPeaks],
          setCursor: [
            (u) => {
              const idx = u.cursor.idx;
              if (idx == null) {
                setReadout(null);
                return;
              }
              const xs = u.data[0];
              const ys = u.data[1];
              const mz = xs[idx] as number | undefined;
              // After a zoom the data array is swapped; a stale cursor idx can
              // point past the shorter array, leaving mz undefined.
              if (mz == null || !Number.isFinite(mz)) {
                setReadout(null);
                return;
              }
              setReadout({ mz, intensity: (ys[idx] as number) ?? 0 });
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

      const plot = new uPlot(opts, buildView(active, active.mz[0], active.mz[active.mz.length - 1]), container);
      plotRef.current = plot;
      applyViewRef.current = (lo, hi, push) => applyView(plot, lo, hi, push);

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

      const ro = new ResizeObserver(() => {
        plot.setSize({ width: container.clientWidth, height: container.clientHeight });
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

    const resetZoom = () => {
      if (!active) return;
      historyRef.current = [];
      applyViewRef.current?.(active.mz[0], active.mz[active.mz.length - 1], false);
    };

    const exportPng = () => {
      const plot = plotRef.current;
      if (!plot) return;
      plot.ctx.canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "maldi-spectrum.png";
        link.click();
        URL.revokeObjectURL(url);
      });
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
            }}
          >
            <Ruler className="mr-1 h-3.5 w-3.5" />
            Measure Δm
          </Button>
          <Button size="sm" variant="outline" className="h-7" onClick={resetZoom}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            Reset zoom
          </Button>
          <Button size="sm" variant="outline" className="h-7" onClick={exportPng}>
            <Download className="mr-1 h-3.5 w-3.5" />
            PNG
          </Button>

          <div className="ml-auto flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
            {readout && (
              <span>
                m/z {readout.mz.toFixed(3)} · {readout.intensity.toFixed(0)}
              </span>
            )}
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
            : "Drag to zoom · double-click to zoom out · scroll to scale the y-axis."}
        </p>
      </div>
    );
  },
);
