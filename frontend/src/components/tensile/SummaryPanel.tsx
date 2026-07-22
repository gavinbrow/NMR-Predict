import { BarChart3, ScatterChart as ScatterIcon, Sigma } from "lucide-react";
import { useMemo, useState } from "react";
import { BarErrorChart, DistributionChart } from "@/components/tensile/charts";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { buildBars, buildDistribution } from "@/lib/tensile/compare";
import { PROPERTY_META } from "@/lib/tensile/compute";
import { formatValue, propertyUnit } from "@/lib/tensile/format";
import { useTensileStore } from "@/lib/tensile/store";
import type { PropertyKey } from "@/lib/tensile/types";
import { cn } from "@/lib/utils";

type ChartView = "bar" | "dist";

/**
 * Live cross-material summary for one focused property (Phase 6): mean ± SD,
 * CV%, and n per material, over each material's *included* specimens. Recomputes
 * instantly as parameters change or specimens are excluded. The property
 * selector also drives the materials panel's mean ± SD readout.
 *
 * The same selected property is also charted right below the table — a per-
 * material mean ± SD bar, or a per-specimen distribution — so the numbers and a
 * picture of them stay in one place.
 */
export function SummaryPanel() {
  const { materialViews, selection, setProperty } = useTensileStore();
  const property = selection.property;
  const unit = propertyUnit(property);
  const [chartView, setChartView] = useState<ChartView>("bar");

  const bars = useMemo(() => buildBars(materialViews, property), [materialViews, property]);
  const dist = useMemo(
    () => buildDistribution(materialViews, property),
    [materialViews, property],
  );

  const propertySelect = (
    <Select value={property} onValueChange={(v) => setProperty(v as PropertyKey)}>
      <SelectTrigger className="h-8 w-[230px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PROPERTY_META.map((m) => (
          <SelectItem key={m.key} value={m.key} className="text-xs">
            {m.label} ({m.unit})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <CollapsibleSection title="Summary" icon={Sigma} headerRight={propertySelect}>
      {materialViews.length === 0 ? (
        <p className="text-xs text-muted-foreground">No materials yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-xl border border-border/60">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Material</th>
                  <th className="px-3 py-2 text-right font-medium">Mean ({unit})</th>
                  <th className="px-3 py-2 text-right font-medium">SD</th>
                  <th className="px-3 py-2 text-right font-medium">CV %</th>
                  <th className="px-3 py-2 text-right font-medium">n</th>
                </tr>
              </thead>
              <tbody>
                {materialViews.map((mv) => {
                  const st = mv.stats[property];
                  return (
                    <tr key={mv.id} className="border-t border-border/50">
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: mv.color }}
                          />
                          <span className="truncate">{mv.name}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {st ? formatValue(property, st.mean) : "N/A"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {st ? formatValue(property, st.sd) : "N/A"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {st && Number.isFinite(st.cv) ? st.cv.toFixed(1) : "N/A"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{st?.n ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Chart of the selected summary property. */}
          <div className="flex flex-col gap-2 rounded-xl border border-border/60 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">
                {PROPERTY_META.find((m) => m.key === property)?.label ?? "Property"} by material
              </p>
              <div className="inline-flex overflow-hidden rounded-md border border-border/70">
                <ViewButton
                  active={chartView === "bar"}
                  onClick={() => setChartView("bar")}
                  icon={<BarChart3 className="h-3 w-3" />}
                  label="Mean ± SD"
                />
                <ViewButton
                  active={chartView === "dist"}
                  onClick={() => setChartView("dist")}
                  icon={<ScatterIcon className="h-3 w-3" />}
                  label="Spread"
                />
              </div>
            </div>
            <div className="h-[280px]">
              {chartView === "bar" ? (
                <BarErrorChart data={bars} unit={unit} showPoints />
              ) : (
                <DistributionChart data={dist} unit={unit} />
              )}
            </div>
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}

/** A segmented-control button for the summary chart-type toggle. */
function ViewButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium transition-colors",
        active ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
