import { Trash2 } from "lucide-react";
import { useMemo } from "react";
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
import { seriesAdductLabel } from "@/lib/maldi/polymers";
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
  /** Chemistry-based colour (manual series colour still wins). */
  colorFor?: (s: Series) => string;
}

/**
 * Reviewable table of confirmed series: name, describe and colour each one after
 * you identify it, set / review its end group, click a row to highlight its
 * ladder, or delete it. Only series with an assigned end group appear here.
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

  if (series.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No confirmed series yet. In the "Repeat units & series" panel, click "Assign to series" on an adduct card to confirm one here.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8 text-xs">Color</TableHead>
            <TableHead className="text-xs">Label</TableHead>
            <TableHead className="text-xs">Description</TableHead>
            <TableHead className="text-xs">Adduct</TableHead>
            <TableHead className="text-xs">Repeat</TableHead>
            <TableHead className="text-xs">End group (Da)</TableHead>
            <TableHead className="text-xs">End-group name</TableHead>
            <TableHead className="text-xs">Peaks</TableHead>
            <TableHead className="text-xs">err / R2</TableHead>
            {onDeleteSeries && <TableHead className="w-10 text-xs">Del</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ series: s, color, adductLabel }) => {
            const isSelected = s.id === selectedSeriesId;
            return (
              <TableRow
                key={s.id}
                onClick={() => onSelectSeries(isSelected ? null : s)}
                className={isSelected ? "bg-primary/5" : "cursor-pointer hover:bg-muted/40"}
              >
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
                  <Input
                    className="h-7 w-28 text-xs"
                    value={s.label ?? ""}
                    placeholder={seriesAdductLabel(s, adducts)}
                    onChange={(e) => onRenameSeries(s.id, e.target.value)}
                  />
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
                  {s.r2 != null && <span> � R2 {s.r2.toFixed(4)}</span>}
                </TableCell>
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
  );
}
