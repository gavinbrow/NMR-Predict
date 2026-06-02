import { LineChart as LineChartIcon, ZoomIn } from "lucide-react";
import { useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceDot,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { cleanCurve, offsetYield, youngsModulus } from "@/lib/tensile/compute";
import { useTensileStore } from "@/lib/tensile/store";
import type { AnalysisParams, Specimen } from "@/lib/tensile/types";

const MAX_PLOT_POINTS = 400;

/** Evenly decimate a curve for display, keeping the first/last point. */
function decimate(s: number[], st: number[]): { x: number; y: number }[] {
  const n = s.length;
  if (n <= MAX_PLOT_POINTS) return s.map((x, i) => ({ x, y: st[i] }));
  const step = (n - 1) / (MAX_PLOT_POINTS - 1);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < MAX_PLOT_POINTS; i += 1) {
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
 * The live stress–strain chart (Phase 6 visual feedback). Overlays the selected
 * specimens (colored by material; excluded ones greyed), shades the modulus
 * window, and — for one focused specimen — draws the fitted modulus line, the
 * 0.2% offset line, and markers at the offset-yield crossing and the UTS.
 * Everything is driven by the store params, so dragging a slider redraws it live.
 * "Elastic zoom" rescales the x-axis to the small-strain region so the modulus
 * window and fit lines are legible.
 */
export function StressStrainChart() {
  const { specimens, materialViews, selection, params } = useTensileStore();
  const [zoom, setZoom] = useState(false);

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

  const curves = useMemo(
    () =>
      shown.map((s) => {
        const { s: x, st: y } = cleanCurve(s.raw.strain, s.raw.stress, effectivePercent(s, params));
        return { specimen: s, data: decimate(x, y), color: colorOf.get(s.id) ?? "#64748b" };
      }),
    [shown, params, colorOf],
  );

  // Focused specimen for the fit overlays: first selected, else first included.
  const focus = useMemo(() => {
    const pick =
      shown.find((s) => selection.specimenIds.includes(s.id)) ??
      shown.find((s) => !s.excluded) ??
      shown[0];
    if (!pick) return null;
    const { s, st } = cleanCurve(pick.raw.strain, pick.raw.stress, effectivePercent(pick, params));
    if (s.length < 2) return null;
    const fit = youngsModulus(s, st, params);
    const off = offsetYield(s, st, fit.slopePct, fit.intercept, params);
    const maxX = s[s.length - 1];
    const lineEnd = zoom ? Math.min(maxX, params.eHi * 8 + params.offsetPct) : maxX;
    const elastic = [
      { x: 0, y: fit.intercept },
      { x: lineEnd, y: fit.slopePct * lineEnd + fit.intercept },
    ];
    const offset = [
      { x: params.offsetPct, y: fit.intercept },
      { x: lineEnd, y: fit.slopePct * (lineEnd - params.offsetPct) + fit.intercept },
    ];
    return {
      specimen: pick,
      elastic,
      offset,
      offsetCross: Number.isFinite(off.sig) ? { x: off.eps, y: off.sig } : null,
      uts: { x: pick.props.strain_at_uts, y: pick.props.uts_MPa },
    };
  }, [shown, selection.specimenIds, params, zoom]);

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

  const xMax = zoom ? Math.max(params.eHi * 8 + params.offsetPct, params.offsetPct * 2) : undefined;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {curves.length} curve{curves.length === 1 ? "" : "s"}
          {focus && <> · fit shown for <span className="font-medium">{focus.specimen.label}</span></>}
        </p>
        <Button
          variant={zoom ? "secondary" : "outline"}
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => setZoom((z) => !z)}
        >
          <ZoomIn className="h-3 w-3" />
          Elastic zoom
        </Button>
      </div>

      <div className="min-h-[340px] flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 12, right: 20, bottom: 28, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
            <XAxis
              type="number"
              dataKey="x"
              domain={[0, xMax ?? "dataMax"]}
              allowDataOverflow={zoom}
              tickLine={false}
              tickFormatter={(v: number) => v.toFixed(zoom ? 2 : 0)}
              label={{ value: "Strain (%)", position: "insideBottom", offset: -16 }}
              fontSize={11}
            />
            <YAxis
              type="number"
              tickLine={false}
              width={48}
              label={{
                value: "Stress (MPa)",
                angle: -90,
                position: "insideLeft",
                style: { textAnchor: "middle" },
              }}
              fontSize={11}
            />
            <Tooltip
              formatter={(value: number, name: string) => [`${value.toFixed(2)}`, name]}
              labelFormatter={(x: number) => `${x.toFixed(2)} %`}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />

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
                type="monotone"
                data={data}
                dataKey="y"
                stroke={color}
                strokeWidth={specimen.excluded ? 1 : 1.8}
                strokeOpacity={specimen.excluded ? 0.35 : 0.9}
                strokeDasharray={specimen.excluded ? "4 3" : undefined}
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={false}
                legendType={curves.length > 8 ? "none" : "line"}
              />
            ))}

            {/* Modulus + offset fit lines for the focused specimen. */}
            {focus && (
              <>
                <Line
                  name="Modulus fit"
                  type="linear"
                  data={focus.elastic}
                  dataKey="y"
                  stroke="#111827"
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                  legendType="none"
                />
                <Line
                  name="0.2% offset"
                  type="linear"
                  data={focus.offset}
                  dataKey="y"
                  stroke="#111827"
                  strokeWidth={1.2}
                  strokeDasharray="5 4"
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                  legendType="none"
                />
                {focus.offsetCross && (
                  <ReferenceDot
                    x={focus.offsetCross.x}
                    y={focus.offsetCross.y}
                    r={4}
                    fill="#111827"
                    stroke="#fff"
                    ifOverflow="extendDomain"
                  />
                )}
                {!zoom && Number.isFinite(focus.uts.y) && (
                  <Scatter
                    name="UTS"
                    data={[focus.uts]}
                    dataKey="y"
                    fill="#dc2626"
                    isAnimationActive={false}
                  />
                )}
              </>
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
