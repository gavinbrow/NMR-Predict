import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Combine,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Plus,
  Trash2,
  X,
} from "lucide-react";
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
import { manualPeak } from "@/lib/maldi/peaks";
import type { Peak } from "@/lib/maldi/types";
import type { PeakOwner } from "@/pages/Maldi";

/** One series a peak can be dropped into from the table's Series column. */
export interface AssignableSeries {
  id: string;
  label: string;
  color: string;
  /** True once the series has been confirmed into the Series table. */
  confirmed: boolean;
}

interface PeakTableProps {
  peaks: Peak[];
  onChange: (peaks: Peak[]) => void;
  highlightedPeakIds?: Set<string>;
  onSelectPeak?: (id: string) => void;
  /** Peak ids explained by an assigned series (used by the "unexplained only" filter). */
  explainedPeakIds?: Set<string>;
  /** When provided (Combine documents mode), a Source column shows the owning
   *  document's name preceded by a colour dot. Absent = single-document mode. */
  peakOwner?: Map<string, PeakOwner>;
  /** Series a peak can be hand-assigned to. Omitted (Combine documents mode) hides
   *  the Series column — membership is a per-document edit. */
  assignableSeries?: AssignableSeries[];
  /** Which series currently owns each peak, keyed by peak id. */
  seriesByPeakId?: Map<string, AssignableSeries>;
  /** Add peaks to a series' ladder (the ladder is re-fit around them). */
  onAddPeaksToSeries?: (seriesId: string, peakIds: string[]) => void;
  /** Drop peaks from whichever series currently owns them. */
  onRemovePeaksFromSeries?: (peakIds: string[]) => void;
}

type SortKey = "mz" | "intensity" | "snr" | "width";

/** Numeric value a peak sorts by for a given column (undefined sinks to end). */
function sortValue(peak: Peak, key: SortKey): number | undefined {
  switch (key) {
    case "mz":
      return peak.centroid ?? peak.mz;
    case "intensity":
      return peak.intensity;
    case "snr":
      return peak.snr;
    case "width":
      return peak.width;
  }
}

const FLAG_STYLES: Record<string, string> = {
  isotope: "bg-slate-200 text-slate-700",
  shoulder: "bg-amber-100 text-amber-700",
  matrix: "bg-red-100 text-red-700",
  matrixCluster: "bg-red-100 text-red-700",
  salt: "bg-red-100 text-red-700",
  contaminant: "bg-red-100 text-red-700",
  plasticizer: "bg-red-100 text-red-700",
  solvent: "bg-red-100 text-red-700",
};

export function PeakTable({
  peaks,
  onChange,
  highlightedPeakIds,
  onSelectPeak,
  explainedPeakIds,
  peakOwner,
  assignableSeries,
  seriesByPeakId,
  onAddPeaksToSeries,
  onRemovePeaksFromSeries,
}: PeakTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newMz, setNewMz] = useState("");
  const [newIntensity, setNewIntensity] = useState("");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [unexplainedOnly, setUnexplainedOnly] = useState(false);
  const [bulkColor, setBulkColor] = useState("#d946ef");
  const [bulkLabel, setBulkLabel] = useState("");

  // Display-only ordering never mutates the parent peak list (series and edits
  // reference peaks by id, so the on-screen order is free to change).
  const sortedPeaks = useMemo(() => {
    if (!sortKey) return peaks;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...peaks].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      const aMissing = av == null || !Number.isFinite(av);
      const bMissing = bv == null || !Number.isFinite(bv);
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      return (av - bv) * dir;
    });
  }, [peaks, sortKey, sortDir]);

  // "Unexplained only": accepted, not ignored, not flagged, and not explained by
  // any assigned series. Lets the analyst triage leftover peaks (label/colour/delete).
  const visiblePeaks = useMemo(() => {
    if (!unexplainedOnly) return sortedPeaks;
    return sortedPeaks.filter(
      (p) => p.accepted !== false && !p.ignored && !p.flag && !(explainedPeakIds ?? new Set()).has(p.id),
    );
  }, [sortedPeaks, unexplainedOnly, explainedPeakIds]);

  const visibleIds = useMemo(() => new Set(visiblePeaks.map((p) => p.id)), [visiblePeaks]);

  // Keep the selection within the visible set when the filter changes so bulk
  // delete/merge/label act only on what the user can see.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of prev) if (visibleIds.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [visibleIds]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "mz" ? "asc" : "desc");
    }
  };

  const update = (id: string, patch: Partial<Peak>) =>
    onChange(peaks.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allVisibleSelected = visiblePeaks.length > 0 && visiblePeaks.every((p) => selected.has(p.id));
  const toggleSelectAll = () =>
    setSelected(allVisibleSelected ? new Set() : new Set(visiblePeaks.map((p) => p.id)));

  const addPeak = () => {
    const mz = Number(newMz);
    const intensity = Number(newIntensity);
    if (!Number.isFinite(mz)) return;
    onChange([...peaks, manualPeak(mz, Number.isFinite(intensity) ? intensity : 0)].sort((a, b) => a.mz - b.mz));
    setNewMz("");
    setNewIntensity("");
  };

  const deleteSelected = () => {
    onChange(peaks.filter((p) => !selected.has(p.id)));
    setSelected(new Set());
  };

  // Merge selected peaks into a single intensity-weighted centroid peak.
  const mergeSelected = () => {
    const members = peaks.filter((p) => selected.has(p.id));
    if (members.length < 2) return;
    const totalIntensity = members.reduce((s, p) => s + p.intensity, 0) || 1;
    const mz = members.reduce((s, p) => s + (p.centroid ?? p.mz) * p.intensity, 0) / totalIntensity;
    const merged = manualPeak(mz, Math.max(...members.map((p) => p.intensity)));
    merged.label = members.find((p) => p.label)?.label;
    merged.color = members.find((p) => p.color)?.color;
    const rest = peaks.filter((p) => !selected.has(p.id));
    onChange([...rest, merged].sort((a, b) => a.mz - b.mz));
    setSelected(new Set());
  };

  // Apply a colour and/or label to every selected peak (1..N at once).
  const applyBulk = () => {
    if (selected.size === 0) return;
    onChange(
      peaks.map((p) =>
        selected.has(p.id)
          ? {
              ...p,
              color: bulkColor || p.color,
              label: bulkLabel ? bulkLabel : p.label,
            }
          : p,
      ),
    );
    setBulkLabel("");
  };

  const unexplainedCount = useMemo(
    () =>
      peaks.filter(
        (p) => p.accepted !== false && !p.ignored && !p.flag && !(explainedPeakIds ?? new Set()).has(p.id),
      ).length,
    [peaks, explainedPeakIds],
  );

  // Hand-assignment of peaks to a ladder. The automatic assignment drops peaks the
  // spacing scan can't reach — most often a lone high-m/z oligomer with no
  // neighbour a repeat away — so the leftover peaks the "unexplained only" filter
  // surfaces can be dropped into whichever series the analyst says they belong to.
  // Hidden until at least one series exists — an empty picker is pure noise.
  const canAssignSeries = (assignableSeries?.length ?? 0) > 0 && onAddPeaksToSeries != null;
  const assignPeaksTo = (seriesId: string, peakIds: string[]) => {
    if (peakIds.length === 0) return;
    if (seriesId) onAddPeaksToSeries?.(seriesId, peakIds);
    else onRemovePeaksFromSeries?.(peakIds);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar: manual add + bulk actions */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Input
          className="h-7 w-24 text-xs"
          placeholder="m/z"
          inputMode="decimal"
          value={newMz}
          onChange={(e) => setNewMz(e.target.value)}
        />
        <Input
          className="h-7 w-24 text-xs"
          placeholder="intensity"
          inputMode="decimal"
          value={newIntensity}
          onChange={(e) => setNewIntensity(e.target.value)}
        />
        <Button size="sm" variant="outline" className="h-7" onClick={addPeak} disabled={!newMz}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add
        </Button>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title="Show only peaks not explained by any assigned series">
          <input type="checkbox" checked={unexplainedOnly} onChange={(e) => setUnexplainedOnly(e.target.checked)} />
          Unexplained only{unexplainedCount > 0 && ` (${unexplainedCount})`}
        </label>
        {canAssignSeries && (
          <select
            className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-[11px]"
            value=""
            disabled={selected.size === 0}
            title="Add the selected peaks to a series (the ladder is re-fit around them)"
            onChange={(e) => {
              assignPeaksTo(e.target.value === "__none__" ? "" : e.target.value, [...selected]);
              e.currentTarget.value = "";
            }}
          >
            <option value="" disabled>
              {selected.size > 0 ? `Add ${selected.size} to series…` : "Add to series…"}
            </option>
            {assignableSeries!.map((s) => (
              <option key={s.id} value={s.id}>
                {s.confirmed ? "" : "· "}
                {s.label}
              </option>
            ))}
            <option value="__none__">Remove from series</option>
          </select>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            type="color"
            value={bulkColor}
            onChange={(e) => setBulkColor(e.target.value)}
            title="Colour for selected peaks"
            className="h-7 w-7 cursor-pointer rounded border border-border/60 bg-transparent p-0.5"
          />
          <Input
            className="h-7 w-24 text-xs"
            placeholder="label"
            value={bulkLabel}
            onChange={(e) => setBulkLabel(e.target.value)}
          />
          <Button size="sm" variant="outline" className="h-7" onClick={applyBulk} disabled={selected.size === 0}>
            Apply
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={mergeSelected}
            disabled={selected.size < 2}
          >
            <Combine className="mr-1 h-3.5 w-3.5" />
            Merge
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={deleteSelected}
            disabled={selected.size === 0}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Delete
          </Button>
        </div>
      </div>

      {peaks.length === 0 ? (
        <p className="text-xs text-muted-foreground">No peaks yet. Run peak picking or add one manually.</p>
      ) : visiblePeaks.length === 0 ? (
        <p className="text-xs text-muted-foreground">No unexplained peaks. Every accepted peak belongs to a series or carries a flag.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="w-8">
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} title="Select all visible" />
                </TableHead>
                {peakOwner && <TableHead className="text-xs">Source</TableHead>}
                <SortHead label="m/z" sortKey="mz" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="Intensity" sortKey="intensity" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="S/N" sortKey="snr" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="Width" sortKey="width" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <TableHead className="w-10 text-xs">Color</TableHead>
                {canAssignSeries && <TableHead className="text-xs">Series</TableHead>}
                <TableHead className="text-xs">Flag</TableHead>
                <TableHead className="text-xs">Label</TableHead>
                <TableHead className="text-xs">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visiblePeaks.map((peak) => {
                const rejected = peak.accepted === false || peak.ignored;
                const highlighted = highlightedPeakIds?.has(peak.id);
                return (
                  <TableRow
                    key={peak.id}
                    className={[
                      highlighted ? "bg-primary/10" : "",
                      rejected ? "opacity-50" : "",
                      "cursor-pointer",
                    ].join(" ")}
                    style={peak.color ? { boxShadow: `inset 3px 0 0 ${peak.color}` } : undefined}
                    onClick={() => onSelectPeak?.(peak.id)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(peak.id)}
                        onChange={() => toggleSelect(peak.id)}
                      />
                    </TableCell>
                    {peakOwner && (
                      <TableCell className="text-xs">
                        {(() => {
                          const owner = peakOwner.get(peak.id);
                          if (!owner) return <span className="text-muted-foreground">—</span>;
                          return (
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className="h-2.5 w-2.5 rounded-full"
                                style={{ backgroundColor: owner.color }}
                              />
                              <span className="truncate">{owner.name}</span>
                            </span>
                          );
                        })()}
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-xs">{(peak.centroid ?? peak.mz).toFixed(3)}</TableCell>
                    <TableCell className="font-mono text-xs">{peak.intensity.toFixed(0)}</TableCell>
                    <TableCell className="font-mono text-xs">{peak.snr != null ? peak.snr.toFixed(1) : "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{peak.width != null ? peak.width.toFixed(3) : "—"}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <input
                        type="color"
                        value={peak.color ?? "#0ea5e9"}
                        onChange={(e) => update(peak.id, { color: e.target.value })}
                        title="Peak colour"
                        className="h-6 w-7 cursor-pointer rounded border border-border/60 bg-transparent p-0.5"
                      />
                    </TableCell>
                    {canAssignSeries && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {(() => {
                          const owner = seriesByPeakId?.get(peak.id);
                          return (
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className="h-2.5 w-2.5 shrink-0 rounded-full border border-border/60"
                                style={owner ? { backgroundColor: owner.color } : undefined}
                              />
                              <select
                                className="h-6 max-w-[15rem] rounded border border-border/60 bg-background px-1 text-[11px]"
                                value={owner?.id ?? ""}
                                title={owner ? `Series this peak belongs to: ${owner.label}` : "Series this peak belongs to"}
                                onChange={(e) => assignPeaksTo(e.target.value, [peak.id])}
                              >
                                <option value="">—</option>
                                {assignableSeries!.map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.confirmed ? "" : "· "}
                                    {s.label}
                                  </option>
                                ))}
                              </select>
                            </span>
                          );
                        })()}
                      </TableCell>
                    )}
                    <TableCell>
                      {peak.flag ? (
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${FLAG_STYLES[peak.flag] ?? "bg-muted text-muted-foreground"}`}>
                          {peak.flag}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Input
                        className="h-6 w-24 text-xs"
                        value={peak.label ?? ""}
                        placeholder="—"
                        onChange={(e) => update(peak.id, { label: e.target.value || undefined })}
                      />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <IconBtn
                          title={peak.accepted === false ? "Accept" : "Reject"}
                          active={peak.accepted !== false}
                          onClick={() => update(peak.id, { accepted: peak.accepted === false })}
                        >
                          {peak.accepted === false ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                        </IconBtn>
                        <IconBtn
                          title={peak.ignored ? "Un-ignore" : "Ignore"}
                          active={!peak.ignored}
                          onClick={() => update(peak.id, { ignored: !peak.ignored })}
                        >
                          {peak.ignored ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </IconBtn>
                        <IconBtn
                          title={peak.locked ? "Unlock" : "Lock"}
                          active={!peak.locked}
                          onClick={() => update(peak.id, { locked: !peak.locked })}
                        >
                          {peak.locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
                        </IconBtn>
                        <IconBtn
                          title="Delete"
                          onClick={() => onChange(peaks.filter((p) => p.id !== peak.id))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconBtn>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/** A clickable, sort-aware column header showing the current sort direction. */
function SortHead({
  label,
  sortKey,
  active,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey | null;
  dir: "asc" | "desc";
  onSort: (key: SortKey) => void;
}) {
  const isActive = active === sortKey;
  return (
    <TableHead className="text-xs">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-0.5 hover:text-foreground"
      >
        {label}
        {isActive ? (
          dir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

function IconBtn({
  title,
  active = true,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={active ? "text-muted-foreground hover:text-foreground" : "text-primary"}
    >
      {children}
    </button>
  );
}
