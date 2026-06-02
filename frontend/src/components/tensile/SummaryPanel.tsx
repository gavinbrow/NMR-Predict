import { Sigma } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROPERTY_META } from "@/lib/tensile/compute";
import { formatValue, propertyUnit } from "@/lib/tensile/format";
import { useTensileStore } from "@/lib/tensile/store";
import type { PropertyKey } from "@/lib/tensile/types";

/**
 * Live cross-material summary for one focused property (Phase 6): mean ± SD,
 * CV%, and n per material, over each material's *included* specimens. Recomputes
 * instantly as parameters change or specimens are excluded. The property
 * selector also drives the materials panel's mean ± SD readout.
 */
export function SummaryPanel() {
  const { materialViews, selection, setProperty } = useTensileStore();
  const property = selection.property;
  const unit = propertyUnit(property);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Sigma className="h-4 w-4 text-primary" />
          Summary
        </h3>
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
      </div>

      {materialViews.length === 0 ? (
        <p className="text-xs text-muted-foreground">No materials yet.</p>
      ) : (
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
      )}
    </div>
  );
}
