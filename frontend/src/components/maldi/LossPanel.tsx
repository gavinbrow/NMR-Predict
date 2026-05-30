import { Loader2, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LossEvent } from "@/lib/maldi/losses";

interface LossPanelProps {
  events: LossEvent[];
  onDetect: () => void;
  busy?: boolean;
  peakCount: number;
  /** Highlight the parent + fragment peaks of a clicked loss event. */
  onSelect: (parentPeakId: string, fragmentPeakId: string) => void;
}

/**
 * Neutral-loss / fragment detector: scans peak pairs for characteristic small
 * losses (H2O, CO, CO2, CH2, adduct swaps, …). Flags relationships, never edits.
 */
export function LossPanel({ events, onDetect, busy, peakCount, onSelect }: LossPanelProps) {
  // Group by loss label for a compact summary.
  const summary = new Map<string, number>();
  for (const e of events) summary.set(e.lossLabel, (summary.get(e.lossLabel) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        Find peaks separated by a characteristic neutral loss (water, CO₂, CH₂, adduct swaps…). Helps
        explain satellite peaks and confirm assignments.
      </p>
      <Button size="sm" variant="outline" onClick={onDetect} disabled={busy || peakCount < 2}>
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Scissors className="mr-1.5 h-4 w-4" />}
        Detect neutral losses
      </Button>

      {summary.size > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {[...summary.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([label, n]) => (
              <span key={label} className="rounded-full border border-border/70 bg-background/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                {label} ×{n}
              </span>
            ))}
        </div>
      )}

      {events.length > 0 && (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border/60">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Loss</th>
                <th className="px-2 py-1 text-right font-medium">parent</th>
                <th className="px-2 py-1 text-right font-medium">→ fragment</th>
                <th className="px-2 py-1 text-right font-medium">Δerr</th>
              </tr>
            </thead>
            <tbody>
              {events.slice(0, 200).map((e) => (
                <tr
                  key={e.id}
                  className="cursor-pointer border-t border-border/40 hover:bg-primary/5"
                  onClick={() => onSelect(e.parentPeakId, e.fragmentPeakId)}
                >
                  <td className="px-2 py-1 font-medium text-foreground">{e.lossLabel}</td>
                  <td className="px-2 py-1 text-right font-mono text-muted-foreground">{e.parentMz.toFixed(3)}</td>
                  <td className="px-2 py-1 text-right font-mono text-muted-foreground">{e.fragmentMz.toFixed(3)}</td>
                  <td className="px-2 py-1 text-right font-mono text-muted-foreground">{e.errorDa.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
