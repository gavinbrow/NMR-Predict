import { useMemo } from "react";
import { CartesianGrid, ComposedChart, Line, Scatter, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ORDER_Y_LABELS,
  fromSeconds,
  linearizeSeries,
  type LinearOrder,
  type SeriesPoint,
  type TimeUnit,
  type TrackedPeak,
} from "@/lib/nmr/kinetics";

interface OrderTestChartProps {
  peaks: TrackedPeak[];
  seriesByPeak: Record<string, SeriesPoint[]>;
  order: LinearOrder;
  onOrderChange: (order: LinearOrder) => void;
  displayUnit: TimeUnit;
}

const ORDER_OPTIONS: { value: LinearOrder; label: string }[] = [
  { value: "zero", label: "Zero order — [A] vs t" },
  { value: "first", label: "First order — ln[A] vs t" },
  { value: "second", label: "Second order — 1/[A] vs t" },
];

export function OrderTestChart({
  peaks,
  seriesByPeak,
  order,
  onOrderChange,
  displayUnit,
}: OrderTestChartProps) {
  // Only reactant/product peaks get an order test; the standard just normalizes.
  const activePeaks = useMemo(
    () =>
      peaks.filter(
        (peak) =>
          (peak.role ?? "reactant") !== "standard" &&
          (seriesByPeak[peak.id]?.length ?? 0) >= 2,
      ),
    [peaks, seriesByPeak],
  );

  const linearized = useMemo(
    () =>
      activePeaks.map((peak) => ({
        peak,
        result: linearizeSeries(seriesByPeak[peak.id] ?? [], order),
      })),
    [activePeaks, seriesByPeak, order],
  );

  const timeDomain = useMemo(() => {
    const all = linearized.flatMap((entry) => entry.result.points);
    if (all.length === 0) return null;
    const times = all.map((p) => p.timeSeconds);
    return { min: Math.min(...times), max: Math.max(...times) };
  }, [linearized]);

  const config = useMemo<ChartConfig>(() => {
    const entries: ChartConfig = {};
    for (const { peak } of linearized) {
      entries[peak.id] = { label: peak.label, color: peak.color };
    }
    return entries;
  }, [linearized]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={order} onValueChange={(value) => onOrderChange(value as LinearOrder)}>
          <SelectTrigger className="h-8 w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ORDER_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-2">
          {linearized.map(({ peak, result }) => (
            <span
              key={peak.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[11px]"
            >
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: peak.color }} />
              <span className="font-medium text-foreground">{peak.label}</span>
              <span className="font-mono text-muted-foreground">
                R²&nbsp;{result.line ? result.line.rSquared.toFixed(4) : "—"}
              </span>
            </span>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {activePeaks.length === 0 || !timeDomain ? (
          <div className="flex h-full min-h-[260px] items-center justify-center px-6 text-center text-xs text-muted-foreground">
            Add reactant/product peaks with ≥2 timepoints to test the reaction order. The order whose
            transform is most linear (highest R²) is the apparent order.
          </div>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-full w-full">
            <ComposedChart margin={{ top: 16, right: 24, bottom: 28, left: 12 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="x"
                domain={["dataMin", "dataMax"]}
                tickLine={false}
                axisLine={false}
                allowDuplicatedCategory={false}
                label={{
                  value: `Time (${displayUnit})`,
                  position: "insideBottom",
                  offset: -16,
                }}
              />
              <YAxis
                type="number"
                tickLine={false}
                axisLine={false}
                width={56}
                label={{
                  value: ORDER_Y_LABELS[order],
                  angle: -90,
                  position: "insideLeft",
                  style: { textAnchor: "middle" },
                }}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      const x = payload?.[0]?.payload?.x;
                      return typeof x === "number" ? `${x.toLocaleString()} ${displayUnit}` : "";
                    }}
                  />
                }
              />
              <ChartLegend />

              {linearized.map(({ peak, result }) => {
                const points = result.points.map((p) => ({
                  x: fromSeconds(p.timeSeconds, displayUnit),
                  y: p.y,
                }));
                return (
                  <Scatter
                    key={`pts-${peak.id}`}
                    name={peak.label}
                    data={points}
                    dataKey="y"
                    fill={peak.color}
                    isAnimationActive={false}
                  />
                );
              })}

              {linearized.map(({ peak, result }) => {
                if (!result.line) return null;
                const { slope, intercept } = result.line;
                const lineData = [timeDomain.min, timeDomain.max].map((t) => ({
                  x: fromSeconds(t, displayUnit),
                  y: intercept + slope * t,
                }));
                return (
                  <Line
                    key={`line-${peak.id}`}
                    name={`${peak.label} fit`}
                    data={lineData}
                    dataKey="y"
                    stroke={peak.color}
                    strokeWidth={2}
                    dot={false}
                    activeDot={false}
                    legendType="none"
                    isAnimationActive={false}
                  />
                );
              })}
            </ComposedChart>
          </ChartContainer>
        )}
      </div>
    </div>
  );
}
