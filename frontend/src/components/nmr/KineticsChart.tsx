import { useMemo } from "react";
import { CartesianGrid, ComposedChart, Line, Scatter, XAxis, YAxis } from "recharts";
import { LineChart as LineChartIcon } from "lucide-react";
import {
  ChartContainer,
  ChartLegend,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  fromSeconds,
  predictFromFit,
  type FitResult,
  type SeriesPoint,
  type TimeUnit,
  type TrackedPeak,
} from "@/lib/nmr/kinetics";

interface KineticsChartProps {
  peaks: TrackedPeak[];
  seriesByPeak: Record<string, SeriesPoint[]>;
  fitByPeak: Record<string, FitResult | null>;
  displayUnit: TimeUnit;
  normalized: boolean;
  showConnectingLine: boolean;
  showFitLine: boolean;
}

const FIT_SAMPLES = 80;

function sampleFit(
  fit: FitResult,
  minSeconds: number,
  maxSeconds: number,
  displayUnit: TimeUnit,
): Array<{ x: number; y: number }> {
  if (maxSeconds <= minSeconds) return [];
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= FIT_SAMPLES; i += 1) {
    const t = minSeconds + ((maxSeconds - minSeconds) * i) / FIT_SAMPLES;
    const y = predictFromFit(fit, t);
    if (y == null || !Number.isFinite(y)) continue;
    points.push({ x: fromSeconds(t, displayUnit), y });
  }
  return points;
}

export function KineticsChart({
  peaks,
  seriesByPeak,
  fitByPeak,
  displayUnit,
  normalized,
  showConnectingLine,
  showFitLine,
}: KineticsChartProps) {
  // Standard peaks normalize the others; they are never plotted here.
  const activePeaks = useMemo(
    () =>
      peaks.filter(
        (peak) =>
          (peak.role ?? "reactant") !== "standard" &&
          (seriesByPeak[peak.id]?.length ?? 0) > 0,
      ),
    [peaks, seriesByPeak],
  );

  const config = useMemo<ChartConfig>(() => {
    const entries: ChartConfig = {};
    for (const peak of activePeaks) {
      entries[peak.id] = { label: peak.label, color: peak.color };
    }
    return entries;
  }, [activePeaks]);

  const timeDomain = useMemo(() => {
    const all = activePeaks.flatMap((peak) => seriesByPeak[peak.id] ?? []);
    if (all.length === 0) return null;
    const times = all.map((p) => p.timeSeconds);
    return { min: Math.min(...times), max: Math.max(...times) };
  }, [activePeaks, seriesByPeak]);

  if (activePeaks.length === 0 || !timeDomain) {
    return (
      <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
          <LineChartIcon className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">No kinetic data yet.</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            Load spectra, integrate peaks in NMRium, assign times, and add reactant/product peaks
            to see growth/decay curves here.
          </p>
        </div>
      </div>
    );
  }

  const unitLabel = displayUnit;

  return (
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
          label={{ value: `Time (${unitLabel})`, position: "insideBottom", offset: -16 }}
        />
        <YAxis
          type="number"
          tickLine={false}
          axisLine={false}
          width={56}
          label={{
            value: normalized ? "Normalized integral" : "Integral (a.u.)",
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
                return typeof x === "number" ? `${x.toLocaleString()} ${unitLabel}` : "";
              }}
            />
          }
        />
        <ChartLegend />

        {activePeaks.map((peak) => {
          const raw = (seriesByPeak[peak.id] ?? []).map((p) => ({
            x: fromSeconds(p.timeSeconds, displayUnit),
            y: p.value,
          }));

          return (
            <Scatter
              key={`raw-${peak.id}`}
              name={peak.label}
              data={raw}
              dataKey="y"
              fill={peak.color}
              line={showConnectingLine ? { stroke: peak.color, strokeWidth: 1.5 } : false}
              isAnimationActive={false}
            />
          );
        })}

        {showFitLine &&
          activePeaks.map((peak) => {
            const fit = fitByPeak[peak.id];
            if (!fit || !Number.isFinite(fit.k)) return null;
            const fitData = sampleFit(fit, timeDomain.min, timeDomain.max, displayUnit);
            if (fitData.length === 0) return null;
            return (
              <Line
                key={`fit-${peak.id}`}
                name={`${peak.label} fit`}
                type="monotone"
                data={fitData}
                dataKey="y"
                stroke={peak.color}
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                activeDot={false}
                legendType="none"
                isAnimationActive={false}
              />
            );
          })}
      </ComposedChart>
    </ChartContainer>
  );
}
