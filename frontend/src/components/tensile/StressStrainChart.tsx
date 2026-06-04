import { LineChart as LineChartIcon, RotateCcw, ZoomIn } from "lucide-react";
import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { cleanCurve } from "@/lib/tensile/compute";
import { useTensileStore } from "@/lib/tensile/store";
import { type ChartPoint, useChartZoom } from "@/lib/tensile/useChartZoom";
import { useHoverLabel } from "@/lib/tensile/useHoverLabel";
import type { AnalysisParams, Specimen } from "@/lib/tensile/types";

/**
 * Per-curve point budget for display. With many specimens overlaid, fewer points
 * per curve keeps the SVG light and the interaction smooth; with only a handful
 * we keep full fidelity.
 */
function pointBudget(curveCount: number): number {
  if (curveCount > 24) return 120;
  if (curveCount > 12) return 200;
  return 400;
}

/** Evenly decimate a curve for display, keeping the first/last point. */
function decimate(s: number[], st: number[], cap: number): { x: number; y: number }[] {
  const n = s.length;
  if (n <= cap) return s.map((x, i) => ({ x, y: st[i] }));
  const step = (n - 1) / (cap - 1);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < cap; i += 1) {
    const idx = Math.round(i * step);
    out.push({ x: s[idx], y: st[idx] });
  }
  return out;
}

function effectivePercent(s: Specimen, params: AnalysisParams): boolean {
  if (params.strainUnitOverride === "%") return true;
  if (params.strainUnitOverride === "mm/mm") return false;
  return s.raw.strainIsPercent;
}

/**
 * The live stress–strain chart. Overlays the selected specimens (colored by
 * material; excluded ones greyed) and shades the modulus window. The UTS of the
 * focused specimen is marked in red.
 *
 * Zooming is interactive: drag across the plot to zoom into an X window (the Y
 * axis auto-fits to the data inside it), double-click or "Reset" to zoom back
 * out, and "Elastic zoom" jumps straight to the small-strain region around the
 * modulus window. Instead of a legend that grows to cover the plot, hovering a
 * curve shows its name in a small chip that fades after a moment.
 */
export function StressStrainChart() {
  const { specimens, materialViews, selection, params } = useTensileStore();
  const hover = useHoverLabel();

  // Which specimens to show: explicit specimen selection wins, else selected
  // materials, else everything.
  const shown = useMemo<Specimen[]>(() => {
    if (selection.specimenIds.length > 0) {
      const set = new Set(selection.specimenIds);
      return specimens.filter((s) => set.has(s.id));
    }
    if (selection.materialIds.length > 0) {
      const matSet = new Set(selection.materialIds);
      const idSet = new Set(
        materialViews.filter((m) => matSet.has(m.id)).flatMap((m) => m.specimenIds),
      );
      return specimens.filter((s) => idSet.has(s.id));
    }
    return specimens;
  }, [specimens, materialViews, selection]);

  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const mv of materialViews) for (const id of mv.specimenIds) map.set(id, mv.color);
    return map;
  }, [materialViews]);

  const curves = useMemo(() => {
    const cap = pointBudget(shown.length);
    return shown.map((s) => {
      const { s: x, st: y } = cleanCurve(s.raw.strain, s.raw.stress, effectivePercent(s, params));
      return { specimen: s, data: decimate(x, y, cap), color: colorOf.get(s.id) ?? "#64748b" };
    });
  }, [shown, params, colorOf]);

  // Every plotted point, so the zoom hook can auto-fit the Y axis to an X window.
  const allPoints = useMemo<ChartPoint[]>(
    () => curves.flatMap((c) => c.data),
    [curves],
  );
  const zoom = useChartZoom(allPoints);

  // Focused specimen for the UTS marker: first selected, else first included.
  const utsMarker = useMemo(() => {
    const pick =
      shown.find((s) => selection.specimenIds.includes(s.id)) ??
      shown.find((s) => !s.excluded) ??
      shown[0];
    if (!pick || !Number.isFinite(pick.props.uts_MPa)) return null;
    return { specimen: pick, x: pick.props.strain_at_uts, y: pick.props.uts_MPa };
  }, [shown, selection.specimenIds]);

  if (curves.length === 0) {
    return (
      <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
          <LineChartIcon className="h-5 w-5 text-primary" />
        </div>
        <p className="text-sm font-semibold text-foreground">No curves to plot</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Load a file, or adjust the selection, to see stress–strain curves here.
        </p>
      </div>
    );
  }

  const xDomain: [number, number | string] = zoom.domain ? zoom.domain.x : [0, "dataMax"];
  const yDomain: [number, number | string] = zoom.domain ? zoom.domain.y : [0, "auto"];

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {curves.length} curve{curves.length === 1 ? "" : "s"}
          {!zoom.isZoomed && <> · drag across the plot to zoom · hover a curve for its name</>}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => zoom.zoomToX(0, params.eHi * 8 + params.offsetPct)}
          >
            <ZoomIn className="h-3 w-3" />
            Elastic zoom
          </Button>
          {zoom.isZoomed && (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={zoom.reset}
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          )}
        </div>
      </div>

      <div className="relative min-h-[340px] flex-1">
        {hover.label && (
          <div className="pointer-events-none absolute left-3 top-2 z-10 max-w-[70%] truncate rounded-md border border-border/70 bg-background/90 px-2 py-1 text-xs font-medium text-foreground shadow-sm">
            {hover.label}
          </div>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            margin={{ top: 12, right: 20, bottom: 28, left: 8 }}
            onMouseDown={zoom.onMouseDown}
            onMouseMove={zoom.onMouseMove}
            onMouseUp={zoom.onMouseUp}
            onMouseLeave={zoom.onMouseLeave}
            onDoubleClick={zoom.reset}
            style={{ cursor: "crosshair", userSelect: "none" }}
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
            <XAxis
              type="number"
              dataKey="x"
              domain={xDomain}
              allowDataOverflow={zoom.isZoomed}
              tickLine={false}
              tickFormatter={(v: number) => v.toFixed(zoom.isZoomed ? 2 : 0)}
              label={{ value: "Strain (%)", position: "insideBottom", offset: -16 }}
              fontSize={11}
            />
            <YAxis
              type="number"
              domain={yDomain}
              allowDataOverflow={zoom.isZoomed}
              tickLine={false}
              tickFormatter={(v: number) => v.toFixed(0)}
              width={48}
              label={{
                value: "Stress (MPa)",
                angle: -90,
                position: "insideLeft",
                style: { textAnchor: "middle" },
              }}
              fontSize={11}
            />
            {/* No popup box (it grows huge with many curves) — just a thin
                cursor line. Hovering a curve shows its name in the chip above.
                The Tooltip element is kept so recharts still reports the active
                x to the drag-zoom handlers. */}
            <Tooltip
              content={() => null}
              cursor={{ stroke: "#94a3b8", strokeWidth: 1, strokeDasharray: "3 3" }}
            />

            {/* Shaded modulus window. */}
            <ReferenceArea
              x1={params.eLo}
              x2={params.eHi}
              fill="#2563eb"
              fillOpacity={0.08}
              ifOverflow="extendDomain"
            />

            {curves.map(({ specimen, data, color }) => (
              <Line
                key={specimen.id}
                name={specimen.label}
                type="linear"
                data={data}
                dataKey="y"
                stroke={color}
                strokeWidth={specimen.excluded ? 1 : 1.8}
                strokeOpacity={specimen.excluded ? 0.35 : 0.9}
                strokeDasharray={specimen.excluded ? "4 3" : undefined}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                onMouseEnter={() => hover.show(specimen.label)}
                onMouseMove={() => hover.show(specimen.label)}
              />
            ))}

            {/* UTS marker for the focused specimen. */}
            {utsMarker && (
              <Scatter
                name="UTS"
                data={[{ x: utsMarker.x, y: utsMarker.y }]}
                dataKey="y"
                fill="#dc2626"
                isAnimationActive={false}
              />
            )}

            {/* The in-progress drag-zoom rectangle. */}
            {zoom.refArea && (
              <ReferenceArea
                x1={zoom.refArea.x1}
                x2={zoom.refArea.x2}
                fill="#2563eb"
                fillOpacity={0.15}
                ifOverflow="extendDomain"
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
