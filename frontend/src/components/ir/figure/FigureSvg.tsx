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

/** Scroll-up / scroll-down y-axis scale factors (smaller max → taller peaks),
 *  matching the live MALDI viewer's wheel behaviour. */
const Y_SCALE_IN = 0.8;
const Y_SCALE_OUT = 1.25;

/** A drag in progress on the interactive preview. Coordinates are viewBox px. */
type Drag =
  | { kind: "zoom"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "legend"; lx: number; ly: number; offX: number; offY: number };

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
  onZoom?: (next: { x?: { min: number; max: number }; y?: { min: number; max: number } }) => void;
  /** Scrolling fully back out asks the host to clear manual bounds (auto fit). */
  onResetZoom?: () => void;
  /** The legend was dropped; position is the box top-left as plot-area fractions. */
  onLegendMove?: (custom: { x: number; y: number }) => void;
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

    // Series may carry their own x (mass-spectra overlays / stick series); the
    // x-axis spans the union, falling back to the shared grid when none do.
    const anyOwnX = visible.some((v) => v.sd.x);
    const xValues = anyOwnX ? visible.flatMap((v) => v.sd.x ?? data.x) : data.x;
    const yValues = visible.flatMap((v) => v.sd.y);
    const xAxis = resolveAxis(options.x, xValues);
    const yAxis = resolveAxis(options.y, yValues);

    // Margins sized from the fonts and what's shown on each side.
    const titleH = options.title ? options.titleFontSize * 1.6 : 0;
    const marginTop = 14 + titleH;
    const marginRight = 16;
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
    // Stems grow from the zero line when it is in view, else from the axis floor.
    const stickBaseY = sy(yAxis.lo <= 0 && yAxis.hi >= 0 ? 0 : yAxis.lo);

    const paths = visible.map(({ st, sd }) => {
      const ownX = sd.x ?? data.x;
      if (st.kind === "sticks") {
        // Stems are the sparse peak set already — never decimated.
        const d = sticksPathD(ownX, sd.y, sx, sy, stickBaseY);
        const markers =
          st.markers && sd.y.length <= MARKER_LIMIT
            ? ownX
                .map((xv, i) => ({ cx: sx(xv), cy: sy(sd.y[i]), ok: Number.isFinite(xv) && Number.isFinite(sd.y[i]) }))
                .filter((p) => p.ok)
            : [];
        return { st, d, markers };
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
      const d = st.lineStyle !== "none" ? seriesPathD(xs, ys, sx, sy) : "";
      const markers =
        st.markers && ys.length <= MARKER_LIMIT
          ? xs
              .map((xv, i) => ({ cx: sx(xv), cy: sy(ys[i]), ok: Number.isFinite(xv) && Number.isFinite(ys[i]) }))
              .filter((p) => p.ok)
          : [];
      return { st, d, markers };
    });

    return { visible, xAxis, yAxis, marginTop, marginLeft, plotW, plotH, paths, sx, sy };
  }, [data, options, decimate]);

  const { visible, xAxis, yAxis, marginTop, marginLeft, plotW, plotH, paths } = fig;
  const { width, height } = options;
  const axisWeight = options.axisBold ? 700 : 400;

  // Legend box geometry (corner-anchored or custom-placed inside the plot area).
  const legend = options.legend;
  const legendEntries = legend.show ? visible.map(({ st }) => st) : [];
  const lf = legend.fontSize;
  const rowH = lf * 1.5;
  const sampleW = 22;
  const legendW =
    16 + sampleW + 6 + Math.max(1, ...legendEntries.map((e) => e.label.length)) * lf * 0.6;
  const legendH = 12 + rowH * legendEntries.length;
  const inset = 10;

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

  // Data-anchored peak labels (m/z values etc.): project to pixels, drop those
  // scrolled out of the x-range, then thin to the most intense non-overlapping
  // few so a dense spectrum stays legible.
  const peakLabelEls = useMemo(() => {
    const pl = options.peakLabels;
    const labels = data.peakLabels;
    if (!pl.show || !labels || labels.length === 0) return [];
    const eps = 0.5;
    const projected = labels
      .map((p) => ({
        id: p.id,
        px: fig.sx(p.x),
        py: fig.sy(p.y),
        weight: Number.isFinite(p.y) ? p.y : -Infinity,
        text: pl.decimals >= 0 && Number.isFinite(p.x) ? p.x.toFixed(pl.decimals) : p.text,
      }))
      .filter(
        (p) =>
          Number.isFinite(p.px) &&
          Number.isFinite(p.weight) &&
          p.px >= marginLeft - eps &&
          p.px <= marginLeft + plotW + eps,
      );
    return pickVisibleLabels(projected, pl.maxLabels, pl.minGap);
  }, [data.peakLabels, options.peakLabels, fig, marginLeft, plotW]);

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

  // Scroll = scale the intensity (y) axis with its floor pinned, so peaks grow
  // and shrink from the baseline — the same gesture as the live MALDI viewer
  // (scroll up → smaller max → taller peaks, revealing small ones; down →
  // shorter). The x-axis is left to drag-to-zoom. Kept in a ref + native
  // non-passive listener so we can preventDefault the page scroll over the plot.
  wheelRef.current = (e: WheelEvent) => {
    if (!interactive || !onZoom || e.deltaY === 0) return;
    const { vx, vy } = clientToVb(e.clientX, e.clientY);
    const inPlot =
      vx >= marginLeft && vx <= marginLeft + plotW && vy >= marginTop && vy <= marginTop + plotH;
    if (!inPlot) return;
    e.preventDefault();
    const floor = yAxis.lo;
    const max = floor + (yAxis.hi - floor) * (e.deltaY < 0 ? Y_SCALE_IN : Y_SCALE_OUT);
    if (max > floor) onZoom({ y: { min: floor, max } });
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
    } else {
      setDrag({
        ...drag,
        lx: clamp(vx - drag.offX, marginLeft, marginLeft + plotW - legendW),
        ly: clamp(vy - drag.offY, marginTop, marginTop + plotH - legendH),
      });
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
        const next: { x?: { min: number; max: number }; y?: { min: number; max: number } } = {};
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
      }
    } else {
      onLegendMove?.({ x: (drag.lx - marginLeft) / plotW, y: (drag.ly - marginTop) / plotH });
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

        {/* Series (clipped to the plot area) */}
        <defs>
          <clipPath id={clipId}>
            <rect x={marginLeft} y={marginTop} width={plotW} height={plotH} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          {paths.map(({ st, d }) =>
            d ? (
              <path
                key={`p${st.id}`}
                d={d}
                fill="none"
                stroke={st.color}
                strokeWidth={st.lineWidth}
                strokeDasharray={dashArray(st.lineStyle, st.lineWidth)}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null,
          )}
          {paths.map(({ st, markers }) =>
            markers.map((m, i) => (
              <circle key={`m${st.id}-${i}`} cx={m.cx} cy={m.cy} r={st.markerSize} fill={st.color} />
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
            {legendEntries.map((e, i) => {
              const cy = ly + 6 + rowH * i + rowH / 2;
              return (
                <g key={`l${e.id}`}>
                  {e.lineStyle !== "none" && (
                    <line
                      x1={lx + 8}
                      x2={lx + 8 + sampleW}
                      y1={cy}
                      y2={cy}
                      stroke={e.color}
                      strokeWidth={e.lineWidth}
                      strokeDasharray={dashArray(e.lineStyle, e.lineWidth)}
                    />
                  )}
                  {e.markers && (
                    <circle cx={lx + 8 + sampleW / 2} cy={cy} r={e.markerSize} fill={e.color} />
                  )}
                  <text
                    x={lx + 8 + sampleW + 6}
                    y={cy + lf * 0.35}
                    fontSize={lf}
                    fill={TEXT_COLOR}
                  >
                    {e.label}
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

        {/* Data-anchored peak labels (m/z values over mass-spectrum peaks) */}
        {peakLabelEls.map((p) => {
          const labelY = Math.max(marginTop + options.peakLabels.fontSize, p.py - options.peakLabels.offset);
          return (
            <text
              key={`pl-${p.id}`}
              x={p.px}
              y={labelY}
              textAnchor={options.peakLabels.rotation === 0 ? "middle" : "start"}
              fontSize={options.peakLabels.fontSize}
              fontWeight={options.peakLabels.bold ? 700 : 400}
              fill={options.peakLabels.color}
              transform={
                options.peakLabels.rotation
                  ? `rotate(${options.peakLabels.rotation} ${p.px} ${labelY})`
                  : undefined
              }
            >
              {p.text}
            </text>
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
