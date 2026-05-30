import { AlertTriangle, Layers, Loader2, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { seriesAdductLabel, type RepeatCandidate } from "@/lib/maldi/polymers";
import type { Adduct, Peak, Series } from "@/lib/maldi/types";

/** One distinct ladder of a repeat unit, decorated with a display colour. */
export interface RepeatGroupItem {
  key: string;
  color: string;
  count: number;
  startMz: number;
  endMz: number;
}

interface SeriesPanelProps {
  repeatCandidates: RepeatCandidate[];
  onDetectRepeats: () => void;
  repeatMass: number;
  onRepeatMassChange: (value: number) => void;
  /** Click a candidate chip: select the repeat AND highlight its peaks (falls
   *  back to {@link onRepeatMassChange} when not provided). */
  onSelectRepeatCandidate?: (value: number) => void;
  /** When on, picking a repeat unit splits it into its distinct ladders and
   *  colours each one separately instead of one lumped highlight. */
  splitSeries: boolean;
  onToggleSplitSeries: (on: boolean) => void;
  /** The distinct ladders for the current repeat (only while splitSeries is on). */
  repeatGroups: RepeatGroupItem[];
  /** The isolated ladder (null = show all ladders together). */
  selectedGroupKey: string | null;
  onSelectGroup: (key: string) => void;
  series: Series[];
  onAssignSeries: () => void;
  adducts: Adduct[];
  peaks: Peak[];
  detectingRepeats?: boolean;
  assigning?: boolean;
  selectedSeriesId?: string | null;
  onSelectSeries: (series: Series | null) => void;
  /** Highlight every assigned series' peaks at once (null clears). */
  onHighlightAll: (all: boolean) => void;
}

export function SeriesPanel({
  repeatCandidates,
  onDetectRepeats,
  repeatMass,
  onRepeatMassChange,
  onSelectRepeatCandidate,
  splitSeries,
  onToggleSplitSeries,
  repeatGroups,
  selectedGroupKey,
  onSelectGroup,
  series,
  onAssignSeries,
  adducts,
  peaks,
  detectingRepeats,
  assigning,
  selectedSeriesId,
  onSelectSeries,
  onHighlightAll,
}: SeriesPanelProps) {
  const assignablePeakCount = peaks.filter((p) => p.accepted !== false && !p.ignored).length;
  const explainedPeakIds = new Set<string>();
  for (const s of series) for (const m of s.members) explainedPeakIds.add(m.peakId);
  const unexplained = peaks.filter(
    (p) => p.accepted !== false && !p.ignored && !p.flag && !explainedPeakIds.has(p.id),
  ).length;

  return (
    <div className="flex flex-col gap-3">
      <Button size="sm" variant="outline" onClick={onDetectRepeats} disabled={detectingRepeats || assignablePeakCount < 3}>
        {detectingRepeats ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Search className="mr-1.5 h-4 w-4" />}
        Detect repeat units
      </Button>

      <label className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5">
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          Split repeat into distinct series
        </span>
        <Switch checked={splitSeries} onCheckedChange={onToggleSplitSeries} />
      </label>

      {repeatCandidates.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-[11px] text-muted-foreground">
            {splitSeries ? "Candidate repeats (click to split into series)" : "Candidate repeats (click to highlight peaks)"}
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {repeatCandidates.map((c) => (
              <button
                key={c.repeatMass.toFixed(4)}
                type="button"
                onClick={() =>
                  (onSelectRepeatCandidate ?? onRepeatMassChange)(Number(c.repeatMass.toFixed(4)))
                }
                className={[
                  "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-smooth",
                  Math.abs(c.repeatMass - repeatMass) < 0.01
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border/70 bg-background/60 text-muted-foreground hover:border-primary/40",
                ].join(" ")}
                title={`${c.count} spacings`}
              >
                <span className="font-mono font-semibold">{c.repeatMass.toFixed(3)}</span>
                <span className="h-1 w-6 overflow-hidden rounded bg-border">
                  <span className="block h-full bg-primary" style={{ width: `${Math.round(c.score * 100)}%` }} />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Repeat unit (Da)</Label>
          <Input
            type="number"
            step={0.001}
            className="h-8"
            value={repeatMass || ""}
            onChange={(e) => onRepeatMassChange(Number(e.target.value))}
          />
        </div>
        <Button size="sm" onClick={onAssignSeries} disabled={assigning || !(repeatMass > 0) || adducts.length === 0}>
          {assigning ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
          Assign
        </Button>
      </div>
      {adducts.length === 0 && (
        <p className="text-[11px] text-amber-600">Select at least one adduct first.</p>
      )}

      {splitSeries && repeatGroups.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-[11px] text-muted-foreground">
            {repeatGroups.length} series at {repeatMass.toFixed(2)} Da (click to isolate)
          </Label>
          <ul className="flex flex-col gap-1">
            {repeatGroups.map((g) => {
              const isSelected = g.key === selectedGroupKey;
              return (
                <li key={g.key}>
                  <button
                    type="button"
                    onClick={() => onSelectGroup(g.key)}
                    className={[
                      "flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-[11px] transition-smooth",
                      isSelected ? "border-primary bg-primary/5" : "border-border/60 bg-background/60 hover:border-primary/40",
                      selectedGroupKey && !isSelected ? "opacity-50" : "",
                    ].join(" ")}
                  >
                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: g.color }} />
                    <span className="font-mono">{g.startMz.toFixed(1)}–{g.endMz.toFixed(1)}</span>
                    <span className="ml-auto text-muted-foreground">{g.count} peaks</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selectedGroupKey && (
            <button
              type="button"
              className="self-start text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => onSelectGroup(selectedGroupKey)}
            >
              Show all series
            </button>
          )}
        </div>
      )}

      {series.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{series.length} series</span>
            {unexplained > 0 && <span>{unexplained} unexplained peaks</span>}
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" className="h-7 flex-1 text-[11px]" onClick={() => onHighlightAll(true)}>
              Highlight all series
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => onHighlightAll(false)}>
              Clear
            </Button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {series.map((s) => {
              const isSelected = s.id === selectedSeriesId;
              const lowConfidence = s.score < 0.4;
              const shortRun = s.members.length < 4;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onSelectSeries(isSelected ? null : s)}
                    className={[
                      "w-full rounded-lg border p-2 text-left transition-smooth",
                      isSelected ? "border-primary bg-primary/5" : "border-border/60 bg-background/60 hover:border-primary/40",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground">
                        {seriesAdductLabel(s, adducts)}
                      </span>
                      <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                        score
                        <span className="h-1.5 w-10 overflow-hidden rounded bg-border">
                          <span className="block h-full bg-primary" style={{ width: `${Math.round(s.score * 100)}%` }} />
                        </span>
                      </span>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                      <span>repeat {s.repeatMass.toFixed(3)}</span>
                      <span>end-group {s.endGroupMass.toFixed(3)}</span>
                      <span>{s.members.length} oligomers</span>
                      <span>err {s.meanErrorDa != null ? `${s.meanErrorDa.toFixed(3)} Da` : "—"}</span>
                    </div>
                    {(lowConfidence || shortRun) && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {lowConfidence && <WarnChip>low confidence</WarnChip>}
                        {shortRun && <WarnChip>few consecutive peaks</WarnChip>}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function WarnChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
      <AlertTriangle className="h-2.5 w-2.5" />
      {children}
    </span>
  );
}
