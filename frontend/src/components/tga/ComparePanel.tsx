// Cross-run / cross-material comparison chart (WP7): mean ± SD of one metric,
// grouped either by material or shown per run.
//
// A presentational recharts view over `lib/tga/compare.ts`'s pure builders —
// colours and strokes are explicit props rather than Tailwind classes so the
// SVG serializes faithfully if it is ever captured for an export, matching the
// convention in `components/tensile/charts.tsx`.

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { TgaBarDatum, TgaMetric, TgaMetricKey } from "@/lib/tga/compare";

const GRID = "#e2e8f0";
const AXIS = "#64748b";
const AXIS_FONT = 11;

export type CompareGrouping = "material" | "run";

export function ComparePanel({
  bars,
  metrics,
  metricKey,
  onMetricChange,
  grouping,
  onGroupingChange,
}: {
  bars: TgaBarDatum[];
  metrics: TgaMetric[];
  metricKey: TgaMetricKey;
  onMetricChange: (k: TgaMetricKey) => void;
  grouping: CompareGrouping;
  onGroupingChange: (g: CompareGrouping) => void;
}) {
  const metric = metrics.find((m) => m.key === metricKey) ?? metrics[0];
  const unit = metric?.unit ?? "";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={metricKey} onValueChange={onMetricChange}>
          <SelectTrigger className="h-8 w-[220px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {metrics.map((m) => (
              <SelectItem key={m.key} value={m.key} className="text-xs">
                {m.label} ({m.unit})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="inline-flex overflow-hidden rounded-md border border-border/60">
          {(["material", "run"] as const).map((g) => (
            <Button
              key={g}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onGroupingChange(g)}
              className={`h-8 rounded-none px-3 text-xs ${
                grouping === g ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground"
              }`}
            >
              {g === "material" ? "By material" : "By run"}
            </Button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {grouping === "material"
            ? "Bars are mean ± SD across each material's runs."
            : "One bar per run — no spread to show."}
        </span>
      </div>

      <div className="h-[340px]">
        {bars.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No {metric?.label ?? "values"} available for the loaded runs.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bars} margin={{ top: 12, right: 20, bottom: 28, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis
                dataKey="name"
                tickLine={false}
                tick={{ fontSize: AXIS_FONT, fill: AXIS }}
                interval={0}
                angle={bars.length > 4 ? -15 : 0}
                textAnchor={bars.length > 4 ? "end" : "middle"}
                height={bars.length > 4 ? 52 : 30}
              />
              <YAxis
                width={60}
                tickLine={false}
                tick={{ fontSize: AXIS_FONT, fill: AXIS }}
                domain={["auto", "auto"]}
                label={{
                  value: `${metric?.label ?? ""} (${unit})`,
                  angle: -90,
                  position: "insideLeft",
                  style: { fontSize: AXIS_FONT, fill: AXIS, textAnchor: "middle" },
                }}
              />
              <Tooltip
                formatter={(value: number, _name, item) => {
                  const d = item?.payload as TgaBarDatum | undefined;
                  const sd = d && d.n > 1 ? ` ± ${d.sd.toFixed(metric?.decimals ?? 1)}` : "";
                  const n = d ? ` (n = ${d.n})` : "";
                  return [
                    `${value.toFixed(metric?.decimals ?? 1)}${sd} ${unit}${n}`,
                    metric?.label ?? "",
                  ];
                }}
                cursor={{ fill: "rgba(148,163,184,0.12)" }}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <Bar dataKey="mean" isAnimationActive={false} radius={[4, 4, 0, 0]} maxBarSize={72}>
                {bars.map((d) => (
                  <Cell key={d.id} fill={d.color} fillOpacity={0.85} />
                ))}
                <ErrorBar dataKey="sd" width={6} strokeWidth={1.5} stroke="#334155" direction="y" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
