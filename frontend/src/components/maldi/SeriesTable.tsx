import { Layers, Trash2, Unlink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adductById } from "@/lib/maldi/adducts";
import { seriesDisplayLabel } from "@/lib/maldi/polymers";
import { SERIES_COLORS } from "@/lib/maldi/seriesColor";
import type { Adduct, Series } from "@/lib/maldi/types";

interface SeriesTableProps {
  /** Only confirmed (end-group-assigned) series are shown here. */
  series: Series[];
  adducts: Adduct[];
  selectedSeriesId?: string | null;
  onSelectSeries: (series: Series | null) => void;
  onRenameSeries: (id: string, label: string) => void;
  onSetSeriesDescription: (id: string, description: string) => void;
  onSetSeriesColor: (id: string, color: string) => void;
  onSetSeriesEndGroupLabel: (id: string, label: string) => void;
  onSetSeriesEndGroupMass: (id: string, mass: number) => void;
  onDeleteSeries?: (id: string) => void;
  /** Force the ticked series together into one ladder. */
  onCombineSeries?: (ids: string[]) => void;
  /** Split a previously combined series back into the series it was made from. */
  onSplitSeries?: (id: string) => void;
  /** Chemistry-based colour (manual series colour still wins). */
  colorFor?: (s: Series) => string;
}

/**
 * Reviewable table of confirmed series: name, describe and colour each one after
 * you identify it, set / review its end group, click a row to highlight its
 * ladder, or delete it. Only series with an assigned end group appear here.
 *
 * Two series that are really one polymer — instrument calibration drifted the
 * spacing enough that the automatic assignment split the ladder — can be ticked
 * and forced together; a combined row carries a "merged" badge and a split button
 * that puts the originals back.
 */
export function SeriesTable({
  series,
  adducts,
  selectedSeriesId,
  onSelectSeries,
  onRenameSeries,
  onSetSeriesDescription,
  onSetSeriesColor,
  onSetSeriesEndGroupLabel,
  onSetSeriesEndGroupMass,
  onDeleteSeries,
  onCombineSeries,
  onSplitSeries,
  colorFor,
}: SeriesTableProps) {
  const rows = useMemo(
    () =>
      series.map((s, i) => ({
        series: s,
        color: s.color ?? colorFor?.(s) ?? SERIES_COLORS[i % SERIES_COLORS.length],
        adductLabel: adductById(adducts, s.adductId).label,
      })),
    [series, adducts, colorFor],
  );

  // Ticked rows awaiting a forced combine. Transient UI state, pruned whenever the
  // series list changes so a delete/split can't leave stale ids behind.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const liveIds = useMemo(() => new Set(series.map((s) => s.id)), [series]);
  useEffect(() => {
    setCheckedIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of prev) if (liveIds.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [liveIds]);
  const checked = useMemo(() => [...checkedIds], [checkedIds]);
  const toggleChecked = (id: string) =>
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (series.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No confirmed series yet. In the "Repeat units & series" panel, click "Assign to series" on an adduct card to confirm one here.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {onCombineSeries && (
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            Tick two or more rows to force them into one ladder (use it when calibration drift split
            one polymer in two). A combined row can be split again.
          </span>
          {checked.length > 0 && (
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                disabled={checked.length < 2}
                onClick={() => {
                  onCombineSeries(checked);
                  setCheckedIds(new Set());
                }}
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
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {onCombineSeries && <TableHead className="w-8 text-xs" />}
              <TableHead className="w-8 text-xs">Color</TableHead>
              <TableHead className="text-xs">Label</TableHead>
              <TableHead className="text-xs">Description</TableHead>
              <TableHead className="text-xs">Adduct</TableHead>
              <TableHead className="text-xs">Repeat</TableHead>
              <TableHead className="text-xs">End group (Da)</TableHead>
              <TableHead className="text-xs">End-group name</TableHead>
              <TableHead className="text-xs">Peaks</TableHead>
              <TableHead className="text-xs">err / R2</TableHead>
              {onSplitSeries && <TableHead className="w-10 text-xs">Split</TableHead>}
              {onDeleteSeries && <TableHead className="w-10 text-xs">Del</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ series: s, color, adductLabel }) => {
              const isSelected = s.id === selectedSeriesId;
              const mergedCount = s.mergedFrom?.length ?? 0;
              return (
                <TableRow
                  key={s.id}
                  onClick={() => onSelectSeries(isSelected ? null : s)}
                  className={isSelected ? "bg-primary/5" : "cursor-pointer hover:bg-muted/40"}
                >
                  {onCombineSeries && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checkedIds.has(s.id)}
                        onChange={() => toggleChecked(s.id)}
                        title="Select for a forced combine"
                      />
                    </TableCell>
                  )}
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => onSetSeriesColor(s.id, e.target.value)}
                      title="Series colour"
                      className="h-6 w-7 cursor-pointer rounded border border-border/60 bg-transparent p-0.5"
                    />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1">
                      <Input
                        className="h-7 w-36 text-xs"
                        value={s.label ?? ""}
                        placeholder={seriesDisplayLabel(s, adducts)}
                        title={seriesDisplayLabel(s, adducts)}
                        onChange={(e) => onRenameSeries(s.id, e.target.value)}
                      />
                      {mergedCount > 0 && (
                        <span
                          title={`Forced together from ${mergedCount} series`}
                          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                        >
                          <Layers className="h-2.5 w-2.5" />
                          {mergedCount}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Input
                      className="h-7 w-40 text-xs"
                      value={s.description ?? ""}
                      placeholder="-"
                      onChange={(e) => onSetSeriesDescription(s.id, e.target.value)}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{adductLabel}</TableCell>
                  <TableCell className="font-mono text-xs">{s.repeatMass.toFixed(3)}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Input
                      type="number"
                      step={0.001}
                      className="h-7 w-20 text-xs"
                      value={Number.isFinite(s.endGroupMass) ? s.endGroupMass : 0}
                      onChange={(e) => onSetSeriesEndGroupMass(s.id, Number(e.target.value))}
                    />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Input
                      className="h-7 w-28 text-xs"
                      value={s.endGroupLabel ?? ""}
                      placeholder="-"
                      onChange={(e) => onSetSeriesEndGroupLabel(s.id, e.target.value)}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{s.members.length}</TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {s.meanErrorDa != null ? `${s.meanErrorDa.toFixed(3)} Da` : "-"}
                    {s.r2 != null && <span> · R2 {s.r2.toFixed(4)}</span>}
                  </TableCell>
                  {onSplitSeries && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {mergedCount > 0 ? (
                        <button
                          type="button"
                          title={`Split back into the ${mergedCount} series this was combined from (edits made since the combine are discarded)`}
                          onClick={() => onSplitSeries(s.id)}
                          className="text-muted-foreground hover:text-primary"
                        >
                          <Unlink className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                  {onDeleteSeries && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        title="Delete (returns it and its adduct alternatives to the pending list)"
                        onClick={() => onDeleteSeries(s.id)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
