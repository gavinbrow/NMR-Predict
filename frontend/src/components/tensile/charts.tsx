// Pure, presentational recharts views for the Phase 7 compare panel. Each takes
// plain data (built by `lib/tensile/compare.ts`) and no store access, so the same
// component renders both in the live tab and in the offscreen mount used to
// rasterize figures for the PDF/PNG export (Phase 9).
//
// Styling note: colors/strokes are set as explicit props (not Tailwind classes)
// so the SVG serializes faithfully when captured to PNG — class-based CSS would
// be lost in the detached clone.

import { RotateCcw } from "lucide-react";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type {
  BarDatum,
  CurveSeries,
  DistDatum,
  ScatterPoint,
} from "@/lib/tensile/compare";
import { type ChartPoint, useChartZoom } from "@/lib/tensile/useChartZoom";
import { useHoverLabel } from "@/lib/tensile/useHoverLabel";

const GRID = "#e2e8f0";
const AXIS = "#64748b";
const AXIS_FONT = 11;

/** Common axis-label styling. */
const labelStyle = { fontSize: 11, fill: AXIS } as const;

/** A small floating "reset zoom" button overlaid on a zoomed live chart. */
function ResetZoomButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/90 px-2 py-1 text-xs font-medium text-foreground shadow-sm hover:bg-muted"
    >
      <RotateCcw className="h-3 w-3" />
      Reset zoom
    </button>
  );
}

/** Render a recharts chart at a fixed size (export) or filling its parent (live). */
function frame(
  width: number | undefined,
  height: number | undefined,
  build: (sizeProps: { width?: number; height?: number }) => React.ReactElement,
): React.ReactElement {
  if (width && height) return build({ width, height });
  return (
    <ResponsiveContainer width="100%" height="100%">
      {build({})}
    </ResponsiveContainer>
  );
}

export interface ChartSizeProps {
  /** Fixed pixel width/height (used for export); omit to fill the parent. */
  width?: number;
  height?: number;
}

// --------------------------------------------------------------------------- //
// View 1 — Overlaid stress–strain curves                                      //
// --------------------------------------------------------------------------- //

export function OverlaidCurvesChart({
  series,
  width,
  height,
}: { series: CurveSeries[] } & ChartSizeProps) {
  const points = useMemo<ChartPoint[]>(() => series.flatMap((s) => s.data), [series]);
  const zoom = useChartZoom(points);
  const hover = useHoverLabel();
  const live = !(width && height);
  // Live view leans on the hover chip; the exported (fixed-size) figure is static
  // so it keeps a legend, but only while it stays small enough to not cover much.
  const showLegend = !live && series.length <= 12;

  const xDomain: [number, number | string] = zoom.domain ? zoom.domain.x : [0, "dataMax"];
  const yDomain: [number, number | string] = zoom.domain ? zoom.domain.y : [0, "auto"];

  const chart = (size: { width?: number; height?: number }) => (
    <LineChart
      {...size}
      margin={{ top: 12, right: 20, bottom: 28, left: 8 }}
      onMouseDown={live ? zoom.onMouseDown : undefined}
      onMouseMove={live ? zoom.onMouseMove : undefined}
      onMouseUp={live ? zoom.onMouseUp : undefined}
      onMouseLeave={live ? zoom.onMouseLeave : undefined}
      onDoubleClick={live ? zoom.reset : undefined}
      style={live ? { cursor: "crosshair", userSelect: "none" } : undefined}
    >
      <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
      <XAxis
        type="number"
        dataKey="x"
        domain={xDomain}
        allowDataOverflow={zoom.isZoomed}
        tickLine={false}
        tick={{ fontSize: AXIS_FONT, fill: AXIS }}
        tickFormatter={(v: number) => v.toFixed(zoom.isZoomed ? 2 : 0)}
        label={{ value: "Strain (%)", position: "insideBottom", offset: -16, style: labelStyle }}
      />
      <YAxis
        type="number"
        domain={yDomain}
        allowDataOverflow={zoom.isZoomed}
        width={48}
        tickLine={false}
        tick={{ fontSize: AXIS_FONT, fill: AXIS }}
        tickFormatter={(v: number) => v.toFixed(0)}
        label={{
          value: "Stress (MPa)",
          angle: -90,
          position: "insideLeft",
          style: { ...labelStyle, textAnchor: "middle" },
        }}
      />
      {/* Live: a thin cursor line only, with the hovered curve named in the chip.
          The Tooltip element stays mounted so recharts reports the active x to
          the drag-zoom handlers. */}
      <Tooltip
        content={() => null}
        cursor={{ stroke: "#94a3b8", strokeWidth: 1, strokeDasharray: "3 3" }}
      />
      {showLegend && <Legend wrapperStyle={{ fontSize: 11 }} />}
      {series.map((s) => (
        <Line
          key={s.id}
          name={`${s.label} · ${s.materialName}`}
          type="linear"
          data={s.data}
          dataKey="y"
          stroke={s.color}
          strokeWidth={s.excluded ? 1 : 1.8}
          strokeOpacity={s.excluded ? 0.35 : 0.9}
          strokeDasharray={s.excluded ? "4 3" : undefined}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
          legendType={showLegend ? "line" : "none"}
          onMouseEnter={live ? () => hover.show(`${s.label} · ${s.materialName}`) : undefined}
          onMouseMove={live ? () => hover.show(`${s.label} · ${s.materialName}`) : undefined}
        />
      ))}
      {zoom.refArea && (
        <ReferenceArea
          x1={zoom.refArea.x1}
          x2={zoom.refArea.x2}
          fill="#2563eb"
          fillOpacity={0.15}
          ifOverflow="extendDomain"
        />
      )}
    </LineChart>
  );

  if (!live) return chart({ width, height });
  return (
    <div className="relative h-full w-full">
      {hover.label && (
        <div className="pointer-events-none absolute left-3 top-2 z-10 max-w-[70%] truncate rounded-md border border-border/70 bg-background/90 px-2 py-1 text-xs font-medium text-foreground shadow-sm">
          {hover.label}
        </div>
      )}
      <ResponsiveContainer width="100%" height="100%">
        {chart({})}
      </ResponsiveContainer>
      {zoom.isZoomed && <ResetZoomButton onClick={zoom.reset} />}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// View 2 — Bar + error bars (mean ± SD per material)                          //
// --------------------------------------------------------------------------- //

export function BarErrorChart({
  data,
  unit,
  showPoints,
  width,
  height,
}: { data: BarDatum[]; unit: string; showPoints?: boolean } & ChartSizeProps) {
  // Flatten individual points onto the bar's category for the optional dots.
  const dotData = showPoints
    ? data.flatMap((d) => d.points.map((p) => ({ name: d.name, value: p.value, color: d.color })))
    : [];
  return frame(width, height, (size) => (
    <BarChart {...size} data={data} margin={{ top: 12, right: 20, bottom: 28, left: 8 }}>
      <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
      <XAxis
        dataKey="name"
        tickLine={false}
        tick={{ fontSize: AXIS_FONT, fill: AXIS }}
        interval={0}
        angle={data.length > 4 ? -15 : 0}
        textAnchor={data.length > 4 ? "end" : "middle"}
        height={data.length > 4 ? 48 : 30}
      />
      <YAxis
        width={56}
        tickLine={false}
        tick={{ fontSize: AXIS_FONT, fill: AXIS }}
        label={{
          value: unit,
          angle: -90,
          position: "insideLeft",
          style: { ...labelStyle, textAnchor: "middle" },
        }}
      />
      <Tooltip
        formatter={(value: number) => [value.toFixed(2), `Mean (${unit})`]}
        cursor={{ fill: "rgba(148,163,184,0.12)" }}
        contentStyle={{ fontSize: 12, borderRadius: 8 }}
      />
      <Bar dataKey="mean" isAnimationActive={false} radius={[4, 4, 0, 0]} maxBarSize={72}>
        {data.map((d) => (
          <Cell key={d.id} fill={d.color} fillOpacity={0.85} />
        ))}
        <ErrorBar dataKey="sd" width={6} strokeWidth={1.5} stroke="#334155" direction="y" />
      </Bar>
      {showPoints && (
        <Scatter data={dotData} dataKey="value" isAnimationActive={false}>
          {dotData.map((p, i) => (
            <Cell key={i} fill="#0f172a" fillOpacity={0.55} />
          ))}
        </Scatter>
      )}
    </BarChart>
  ));
}

// --------------------------------------------------------------------------- //
// View 3 — Property-vs-property scatter                                       //
// --------------------------------------------------------------------------- //

export function ScatterCompareChart({
  points,
  xLabel,
  yLabel,
  width,
  height,
}: { points: ScatterPoint[]; xLabel: string; yLabel: string } & ChartSizeProps) {
  // Group by material so each gets a colored, legend-labelled series.
  const groups = new Map<string, { name: string; color: string; pts: ScatterPoint[] }>();
  for (const p of points) {
    const g = groups.get(p.materialId) ?? { name: p.materialName, color: p.color, pts: [] };
    g.pts.push(p);
    groups.set(p.materialId, g);
  }
  return frame(width, height, (size) => (
    <ScatterChart {...size} margin={{ top: 12, right: 24, bottom: 32, left: 8 }}>
      <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
      <XAxis
        type="number"
        dataKey="x"
        name={xLabel}
        tickLine={false}
        tick={{ fontSize: AXIS_FONT, fill: AXIS }}
        domain={["auto", "auto"]}
        label={{ value: xLabel, position: "insideBottom", offset: -18, style: labelStyle }}
      />
      <YAxis
        type="number"
        dataKey="y"
        name={yLabel}
        width={56}
        tickLine={false}
        tick={{ fontSize: AXIS_FONT, fill: AXIS }}
        domain={["auto", "auto"]}
        label={{
          value: yLabel,
          angle: -90,
          position: "insideLeft",
          style: { ...labelStyle, textAnchor: "middle" },
        }}
      />
      <ZAxis range={[60, 60]} />
      <Tooltip
        cursor={{ strokeDasharray: "3 3" }}
        formatter={(value: number) => value.toFixed(2)}
        contentStyle={{ fontSize: 12, borderRadius: 8 }}
      />
      <Legend wrapperStyle={{ fontSize: 11 }} />
      {[...groups.values()].map((g) => (
        <Scatter key={g.name} name={g.name} data={g.pts} fill={g.color} isAnimationActive={false} />
      ))}
    </ScatterChart>
  ));
}

// --------------------------------------------------------------------------- //
// View 4 — Distribution / dot plot per material                               //
// --------------------------------------------------------------------------- //

export function DistributionChart({
  data,
  unit,
  width,
  height,
}: { data: DistDatum[]; unit: string } & ChartSizeProps) {
  // Each material is a category on the x-axis; its specimen values are dots, and
  // a mean marker carries a ± SD error bar.
  const means = data.map((d) => ({ name: d.name, mean: d.mean, sd: d.sd, color: d.color }));
  return frame(width, height, (size) => (
    <ScatterChart {...size} margin={{ top: 12, right: 24, bottom: 36, left: 8 }}>
      <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
      <XAxis
        type="category"
        dataKey="name"
        allowDuplicatedCategory={false}
        tickLine={false}
        interval={0}
        tick={{ fontSize: AXIS_FONT, fill: AXIS }}
        angle={data.length > 4 ? -15 : 0}
        textAnchor={data.length > 4 ? "end" : "middle"}
        height={data.length > 4 ? 52 : 34}
      />
      <YAxis
        type="number"
        width={56}
        tickLine={false}
        tick={{ fontSize: AXIS_FONT, fill: AXIS }}
        label={{
          value: unit,
          angle: -90,
          position: "insideLeft",
          style: { ...labelStyle, textAnchor: "middle" },
        }}
      />
      <ZAxis range={[50, 50]} />
      <Tooltip
        cursor={{ strokeDasharray: "3 3" }}
        formatter={(value: number) => value.toFixed(2)}
        contentStyle={{ fontSize: 12, borderRadius: 8 }}
      />
      {/* Mean ± SD markers (one diamond per material with an error bar). */}
      <Scatter
        name="Mean ± SD"
        data={means.map((m) => ({ name: m.name, y: m.mean, sd: m.sd }))}
        dataKey="y"
        fill="#0f172a"
        shape="diamond"
        isAnimationActive={false}
      >
        <ErrorBar dataKey="sd" width={6} strokeWidth={1.5} stroke="#334155" direction="y" />
      </Scatter>
      {/* Individual specimen values, colored by material. */}
      {data.map((d) => (
        <Scatter
          key={d.id}
          name={d.name}
          data={d.values.map((v) => ({ name: d.name, y: v.value }))}
          dataKey="y"
          fill={d.color}
          fillOpacity={0.6}
          isAnimationActive={false}
          legendType="none"
        />
      ))}
    </ScatterChart>
  ));
}
