import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import uPlot from "uplot";
import type { AlignedData, Series } from "uplot";
import "uplot/dist/uPlot.min.css";

/** Imperative handle so a page can grab the rendered canvas (e.g. for a PDF). */
export interface IrChartHandle {
  /** PNG data-URL of the current canvas, or null if not mounted. */
  getPng: () => string | null;
  /** The live uPlot instance, or null if not mounted. */
  getPlot: () => uPlot | null;
}

/** A translucent vertical band drawn behind the series (tracked / reference window). */
export interface IrChartBand {
  /** Lower wavenumber edge of the band. */
  lo: number;
  /** Upper wavenumber edge of the band. */
  hi: number;
  /** Fill colour (use an rgba/translucent colour). */
  fill: string;
}

export interface IrChartProps {
  /** uPlot AlignedData: index 0 is the shared x, then one array per series. */
  data: AlignedData;
  /** Series definitions, one per y-array (the x placeholder is added internally). */
  series: Series[];
  xLabel?: string;
  yLabel?: string;
  /** Reverse the x-axis (high cm⁻¹ on the left) — the IR convention. */
  reversedX?: boolean;
  /** Show uPlot's built-in legend below the plot. */
  legend?: boolean;
  /** Draw axis gridlines (default true). Off gives a clean look for stacked plots. */
  grid?: boolean;
  /** Translucent windows drawn behind the data (redraw-only; no recreate). */
  bands?: IrChartBand[];
  /**
   * Drag behaviour:
   *  - "zoom"   → drag-select zooms the x-axis (double-click resets).
   *  - "select" → drag reports the x-window via `onSelectWindow` without zooming.
   */
  dragMode?: "zoom" | "select";
  /** Called with the dragged x-window [lo, hi] (ascending) in "select" mode. */
  onSelectWindow?: (lo: number, hi: number) => void;
  /** Plot height in px (the wrapper fills its parent's width). */
  height?: number;
  className?: string;
}

const AXIS_GRID = { stroke: "#e2e8f0", width: 1 };

/**
 * Thin, reusable uPlot wrapper for every IR chart. Owns sizing (ResizeObserver),
 * reversed-x, a window-shading plugin, the drag-zoom / drag-select toggle, and a
 * canvas PNG getter — so the View & Export overlay and the Kinetics charts share
 * one consistent chart implementation.
 *
 * The plot is recreated only when its *structure* changes (series shape, axis
 * labels, reversed-x, drag mode); plain data updates go through `setData`, and
 * band changes go through a redraw — both cheap and zoom-preserving.
 */
export const IrChart = forwardRef<IrChartHandle, IrChartProps>(function IrChart(
  {
    data,
    series,
    xLabel = "Wavenumber (cm⁻¹)",
    yLabel,
    reversedX = false,
    legend = false,
    grid = true,
    bands,
    dragMode = "zoom",
    onSelectWindow,
    height = 560,
    className,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  // Mutable refs the uPlot hooks read, so band/callback changes never force a
  // plot recreation (which would drop the user's current zoom).
  const bandsRef = useRef(bands);
  const onSelectRef = useRef(onSelectWindow);
  bandsRef.current = bands;
  onSelectRef.current = onSelectWindow;

  useImperativeHandle(
    ref,
    () => ({
      getPng: () => (plotRef.current ? plotRef.current.ctx.canvas.toDataURL("image/png") : null),
      getPlot: () => plotRef.current,
    }),
    [],
  );

  // A "structure key": when any of these change the plot must be rebuilt. Plain
  // data/band updates are excluded so they take the cheap update paths below.
  const structureKey = JSON.stringify({
    labels: series.map((s) => s.label ?? ""),
    strokes: series.map((s) => (typeof s.stroke === "string" ? s.stroke : "")),
    xLabel,
    yLabel,
    reversedX,
    legend,
    grid,
    dragMode,
    height,
  });

  // Create / recreate the plot when its structure changes.
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    // Behind-the-series translucent windows (tracked / reference).
    const drawBands = (u: uPlot) => {
      const list = bandsRef.current;
      if (!list || list.length === 0) return;
      const ctx = u.ctx;
      const { top, height: h } = u.bbox;
      ctx.save();
      for (const band of list) {
        const x1 = u.valToPos(band.lo, "x", true);
        const x2 = u.valToPos(band.hi, "x", true);
        const left = Math.min(x1, x2);
        const width = Math.abs(x2 - x1);
        ctx.fillStyle = band.fill;
        ctx.fillRect(left, top, width, h);
      }
      ctx.restore();
    };

    const opts: uPlot.Options = {
      width: container.clientWidth || 600,
      height,
      legend: { show: legend },
      scales: {
        x: { time: false, dir: reversedX ? -1 : 1 },
        y: {},
      },
      // In "zoom" mode uPlot handles the zoom itself; in "select" we draw the
      // drag rectangle but leave the scale alone and report the window instead.
      cursor: { drag: { x: true, y: false, setScale: dragMode === "zoom" } },
      axes: [
        { label: xLabel, labelGap: 8, grid: grid ? AXIS_GRID : { show: false } },
        { label: yLabel, grid: grid ? AXIS_GRID : { show: false } },
      ],
      series: [{}, ...series],
      hooks: {
        // drawClear fires after the canvas is cleared but before the series are
        // drawn, so the bands sit behind the spectra.
        drawClear: [drawBands],
        setSelect: [
          (u) => {
            if (dragMode !== "select") return;
            const { left, width } = u.select;
            if (width <= 0) return;
            const a = u.posToVal(left, "x");
            const b = u.posToVal(left + width, "x");
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            // Clear the rectangle without re-firing this hook.
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            onSelectRef.current?.(lo, hi);
          },
        ],
      },
    };

    const plot = new uPlot(opts, data, container);
    plotRef.current = plot;

    const fit = () => plot.setSize({ width: container.clientWidth || 600, height });

    // uPlot autoranges during construction, but here that happens before the flex
    // container is laid out, so the x-scale lands un-ranged (min/max null) and the
    // chart paints blank until the user double-clicks. Once the browser has laid
    // the container out (next frame), re-fit the size and re-set the data to force
    // a clean autorange. `plot.data` is whatever the data effect has set by then.
    const raf = requestAnimationFrame(() => {
      fit();
      plot.setData(plot.data, true);
    });

    const ro = new ResizeObserver(fit);
    ro.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // Recreate only on structural changes; data/bands handled separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  // Cheap data update — keeps the current zoom/selection.
  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  // Redraw when only the bands change.
  useEffect(() => {
    plotRef.current?.redraw();
  }, [bands]);

  return <div ref={containerRef} className={className} style={{ width: "100%", height }} />;
});
