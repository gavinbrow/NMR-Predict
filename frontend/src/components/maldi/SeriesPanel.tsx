import { AlertTriangle, Atom, Layers, Loader2, Plus, Search, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { seriesAdductLabel, type RepeatCandidate } from "@/lib/maldi/polymers";
import { unexplainedPeaks } from "@/lib/maldi/seriesMatch";
import { SERIES_COLORS } from "@/lib/maldi/seriesColor";
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
  isotopeAware: boolean;
  onToggleIsotopeAware: (on: boolean) => void;
  repeatMass: number;
  onRepeatMassChange: (value: number) => void;
  onSelectRepeatCandidate?: (value: number) => void;
  /** Every repeat unit kept for this spectrum (one per polymer in the sample). */
  repeatMasses: number[];
  /** Keep the current repeat unit in the list without assigning it. */
  onAddRepeatMass: (value: number) => void;
  /** Drop a repeat unit from the list (its assigned series are left alone). */
  onRemoveRepeatMass: (value: number) => void;
  /** Assign every repeat unit in the list in one pass. */
  onAssignAllRepeats: () => void;
  repeatGroups: RepeatGroupItem[];
  selectedGroupKey: string | null;
  onSelectGroup: (key: string) => void;
  /** Detected-but-unconfirmed series (no end group assigned yet). */
  series: Series[];
  onAssignSeries: () => void;
  adducts: Adduct[];
  peaks: Peak[];
  detectingRepeats?: boolean;
  assigning?: boolean;
  selectedSeriesId?: string | null;
  onSelectSeries: (series: Series | null) => void;
  onHighlightAll: (all: boolean) => void;
  /** Resolve a series' display colour (chemistry-based; manual colour wins). */
  colorForSeries?: (s: Series) => string;
  /** Count of unexplained peaks over ALL series (sidebar only sees pending ones). */
  unexplainedCount?: number;
  /** Confirm a pending series into the Series table (hides its same-peak adduct
   *  alternatives). */
  onAssignSeriesToTable: (id: string) => void;
  /** Force the ticked pending series together into one ladder. */
  onCombineSeries: (ids: string[]) => void;
}

/** Two repeat units are "the same entry" when they agree to 4 dp (the precision
 *  the detector and the input both round to). */
function sameRepeat(a: number, b: number): boolean {
  return Math.abs(a - b) < 5e-5;
}

export function SeriesPanel({
  repeatCandidates,
  onDetectRepeats,
  isotopeAware,
  onToggleIsotopeAware,
  repeatMass,
  onRepeatMassChange,
  onSelectRepeatCandidate,
  repeatMasses,
  onAddRepeatMass,
  onRemoveRepeatMass,
  onAssignAllRepeats,
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
  colorForSeries,
  unexplainedCount,
  onAssignSeriesToTable,
  onCombineSeries,
}: SeriesPanelProps) {
  const assignablePeakCount = peaks.filter((p) => p.accepted !== false && !p.ignored).length;
  const unexplained = unexplainedCount ?? unexplainedPeaks(peaks, series).length;
  const swatch = (s: Series) =>
    s.color ?? colorForSeries?.(s) ?? SERIES_COLORS[series.indexOf(s) % SERIES_COLORS.length];

  // Ticked pending series awaiting a forced combine. Held locally (it is transient
  // UI, not analysis state) and intersected with the live list on every render so
  // a re-assign can't leave the button acting on ids that no longer exist.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const checked = useMemo(
    () => series.filter((s) => checkedIds.has(s.id)).map((s) => s.id),
    [series, checkedIds],
  );
  const toggleChecked = (id: string) =>
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const repeatInList = repeatMasses.some((m) => sameRepeat(m, repeatMass));

  return (
    <div className="flex flex-col gap-3">
      <Button size="sm" variant="outline" onClick={onDetectRepeats} disabled={detectingRepeats || assignablePeakCount < 3}>
        {detectingRepeats ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Search className="mr-1.5 h-4 w-4" />}
        Detect repeat units
      </Button>

      <label className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5">
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Atom className="h-3.5 w-3.5" />
          Merge isotope-shifted repeats
        </span>
        <Switch checked={isotopeAware} onCheckedChange={onToggleIsotopeAware} />
      </label>

      {repeatCandidates.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-[11px] text-muted-foreground">
            Candidate repeats (click to split into series)
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {repeatCandidates.map((c) => (
              <button
                key={c.repeatMass.toFixed(4)}
                type="button"
                onClick={() => (onSelectRepeatCandidate ?? onRepeatMassChange)(Number(c.repeatMass.toFixed(4)))}
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

      <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
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
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2"
          title="Keep this repeat unit (a sample with two polymers has one entry per polymer)"
          onClick={() => onAddRepeatMass(repeatMass)}
          disabled={!(repeatMass > 0) || repeatInList}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Button size="sm" className="h-8" onClick={onAssignSeries} disabled={assigning || !(repeatMass > 0) || adducts.length === 0}>
          {assigning ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
          Assign
        </Button>
      </div>

      {repeatMasses.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-[11px] text-muted-foreground">
            Repeat units in this sample ({repeatMasses.length})
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {repeatMasses.map((m) => {
              const isActive = sameRepeat(m, repeatMass);
              return (
                <span
                  key={m.toFixed(5)}
                  className={[
                    "inline-flex items-center gap-1 rounded-full border py-1 pl-2 pr-1 text-[11px] transition-smooth",
                    isActive
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/70 bg-background/60 text-muted-foreground",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    className="font-mono font-semibold"
                    title="Make active and preview its ladders"
                    onClick={() => onRepeatMassChange(m)}
                  >
                    {m.toFixed(3)}
                  </button>
                  <button
                    type="button"
                    title="Remove from the list (already-assigned series are kept)"
                    className="rounded-full p-0.5 hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => onRemoveRepeatMass(m)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
          {repeatMasses.length > 1 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={onAssignAllRepeats}
              disabled={assigning || adducts.length === 0}
            >
              {assigning ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
              Assign all {repeatMasses.length} repeat units
            </Button>
          )}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Type a known repeat unit to highlight its ladder, then Assign to build its adduct series.
        Assigning keeps the series already built for the other repeat units, so a sample with two
        polymers can carry both.
      </p>
      {adducts.length === 0 && (
        <p className="text-[11px] text-amber-600">Select at least one adduct first.</p>
      )}

      {repeatGroups.length > 0 && (
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
                    <span className="font-mono">{g.startMz.toFixed(1)}-{g.endMz.toFixed(1)}</span>
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
            <span>{series.length} unconfirmed series</span>
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
          <p className="text-[10px] leading-snug text-muted-foreground">
            Click a series to inspect it, then "Assign to series" to confirm it. It moves to the Series tab; the other adduct readings of the same peaks are tucked away and return if you delete it.
          </p>
          <p className="text-[10px] leading-snug text-muted-foreground">
            Tick two or more to force them together when calibration drift split one ladder in two — the
            Series table can split the merge back apart.
          </p>
          {checked.length > 0 && (
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 flex-1 text-[11px]"
                onClick={() => {
                  onCombineSeries(checked);
                  setCheckedIds(new Set());
                }}
                disabled={checked.length < 2}
              >
                <Layers className="mr-1.5 h-3.5 w-3.5" />
                Combine {checked.length} selected
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[11px]"
                onClick={() => setCheckedIds(new Set())}
              >
                Clear
              </Button>
            </div>
          )}
          <ul className="flex flex-col gap-1.5">
            {series.map((s) => {
              const isSelected = s.id === selectedSeriesId;
              const isChecked = checkedIds.has(s.id);
              const lowConfidence = s.score < 0.4;
              const shortRun = s.members.length < 4;
              return (
                <li key={s.id} className="flex flex-col gap-1">
                  <div
                    className={[
                      "flex w-full items-start gap-2 rounded-lg border p-2 transition-smooth",
                      isSelected ? "border-primary bg-primary/5" : "border-border/60 bg-background/60 hover:border-primary/40",
                    ].join(" ")}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleChecked(s.id)}
                      title="Select for a forced combine"
                      className="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
                    />
                    <button
                      type="button"
                      onClick={() => onSelectSeries(isSelected ? null : s)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: swatch(s) }} />
                          {s.label || seriesAdductLabel(s, adducts)}
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
                        <span>err {s.meanErrorDa != null ? `${s.meanErrorDa.toFixed(3)} Da` : "-"}</span>
                        {s.r2 != null && <span>R2 {s.r2.toFixed(4)}</span>}
                      </div>
                      {(lowConfidence || shortRun || s.mergedFrom?.length) && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {s.mergedFrom?.length ? <MergeChip>merged ×{s.mergedFrom.length}</MergeChip> : null}
                          {lowConfidence && <WarnChip>low confidence</WarnChip>}
                          {shortRun && <WarnChip>few consecutive peaks</WarnChip>}
                        </div>
                      )}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => onAssignSeriesToTable(s.id)}
                    className="w-full rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary hover:bg-primary/15"
                  >
                    Assign to series
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

function MergeChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
      <Layers className="h-2.5 w-2.5" />
      {children}
    </span>
  );
}
