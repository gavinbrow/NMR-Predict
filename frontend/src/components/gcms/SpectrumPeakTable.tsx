import { ChevronDown, ChevronUp, ChevronsUpDown, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SpectrumPeakRow } from "@/lib/gcms/types";

/**
 * The spectrum peak table. Columns: a select checkbox, m/z (3 dp — the
 * instrument's grid is 0.05 Da so 3 dp is exact), Intensity, Rel %. Every
 * header is sortable (click to toggle asc/desc, chevron on the active column).
 *
 * MULTI-SELECT: per-row checkboxes plus a header select-all. A toolbar above
 * the table can either sum the selected ions into one combined XIC or create
 * one separate XIC per selected m/z. Row click reuses that SAME selection state: it
 * toggles the row's checkbox, highlighting it (`bg-muted`) and folding it
 * into the next XIC build, rather than inventing a separate single-row
 * highlight.
 *
 * The table renders ALL rows (the true total is shown in the header) but
 * WINDOWS them: a fixed-height scroll container measures `scrollTop` and
 * renders only the visible slice plus ~10 rows of overscan, with top/bottom
 * spacer rows of the appropriate height. A fixed row height (`h-8` = 32 px)
 * keeps the math simple. Nothing is silently capped.
 *
 * ADD / REMOVE (Phase 5 task C): an `m/z` input + `Add` button sits beside
 * the XIC actions. `onAddPeak(mz)` does the snap-to-nearest-stick and relPct
 * math against the live spectrum (this table has no spectrum of its own to
 * search) and returns an error string to show inline — same
 * `text-xs text-destructive` convention the Traces panel's XIC builder uses —
 * or `null` on success. A trailing delete-× column calls `onDeletePeak(id)`.
 */
interface SpectrumPeakTableProps {
  peaks: SpectrumPeakRow[];
  sources: { id: string; label: string }[];
  sourceId: string;
  onSourceChange(id: string): void;
  onXicSelected(mzList: number[], layout: "combined" | "separate"): void;
  /** Returns an error message to display inline, or null on success. */
  onAddPeak?: (mz: number) => string | null;
  onDeletePeak?: (id: string) => void;
}

type SortKey = "sourceLabel" | "mz" | "intensity" | "relPct";

const ROW_H = 32;
const OVERSCAN = 10;

export function SpectrumPeakTable({
  peaks,
  sources,
  sourceId,
  onSourceChange,
  onXicSelected,
  onAddPeak,
  onDeletePeak,
}: SpectrumPeakTableProps) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mzText, setMzText] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  // Drop stale selections whenever the peak set changes: each re-pick assigns
  // new peak ids (crypto.randomUUID in peaks.ts), so IDs from a prior spectrum
  // would otherwise linger and "XIC selected" would emit the wrong m/z values.
  useEffect(() => {
    setSelected(new Set());
  }, [peaks]);

  const sorted = useMemo(() => {
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
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * dir;
      }
      return (av - bv) * dir;
    });
  }, [peaks, sortKey, sortDir]);

  const total = sorted.length;

  const measure = () => {
    const el = scrollRef.current;
    if (el) setViewportH(el.clientHeight);
  };

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const endIdx = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const visible = sorted.slice(startIdx, endIdx);
  const topSpacer = startIdx * ROW_H;
  const bottomSpacer = (total - endIdx) * ROW_H;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "mz" ? "asc" : "desc");
    }
  };

  const allSelected = total > 0 && sorted.every((p) => selected.has(p.id));
  const toggleSelectAll = () =>
    setSelected(allSelected ? new Set() : new Set(sorted.map((p) => p.id)));

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleXicSelected = (layout: "combined" | "separate") => {
    const mzList = sorted.filter((p) => selected.has(p.id)).map((p) => p.mz);
    if (mzList.length) onXicSelected(mzList, layout);
  };

  // Parse-then-validate, mirroring the Traces panel's XIC builder: typing
  // never blocks, only "Add" (or blur) reports a problem inline.
  const mzNum = Number(mzText);
  const mzParses = mzText.trim() !== "" && Number.isFinite(mzNum) && mzNum > 0;
  const handleAdd = () => {
    if (mzText.trim() === "") return;
    if (!mzParses) {
      setAddError("Enter a single m/z value, e.g. 162.3");
      return;
    }
    const err = onAddPeak?.(mzNum) ?? "Peak editing is available in Live view.";
    if (err) {
      setAddError(err);
    } else {
      setAddError(null);
      setMzText("");
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar: selected count, add-by-m/z, and combined/separate XIC actions. */}
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1">
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>Spectrum source</span>
          <select
            aria-label="Spectrum peak source"
            className="h-7 max-w-72 rounded-md border border-input bg-background px-2 text-xs text-foreground"
            value={sourceId}
            onChange={(event) => onSourceChange(event.target.value)}
          >
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-[11px] text-muted-foreground">
          {total} peak{total === 1 ? "" : "s"}
          {selected.size > 0 && (
            <span className="ml-1 text-foreground">· {selected.size} selected</span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <Input
            className="h-7 w-24 px-1.5 text-xs"
            placeholder="m/z"
            disabled={!onAddPeak}
            inputMode="decimal"
            value={mzText}
            onChange={(e) => {
              setMzText(e.target.value);
              setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            title="Add a peak at this m/z (snaps to the nearest stick)"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={handleAdd}
            disabled={!onAddPeak || mzText.trim() === ""}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => handleXicSelected("combined")}
            disabled={selected.size === 0}
            title="Sum all selected ions into one extracted-ion chromatogram"
          >
            Combined XIC
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => handleXicSelected("separate")}
            disabled={selected.size === 0}
            title="Create one chromatogram trace per selected m/z"
          >
            Separate XICs
          </Button>
        </div>
      </div>
      {addError && <p className="mb-1 px-1 text-xs text-destructive">{addError}</p>}
      {total === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">No spectrum peaks.</p>
      ) : (
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60"
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          onLoad={measure}
        >
          <table className="w-full caption-bottom text-sm">
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="w-8 h-8 px-2">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all peaks"
                  />
                </TableHead>
                <SortHead label="Chromatogram peak" sortKey="sourceLabel" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="m/z" sortKey="mz" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="Intensity" sortKey="intensity" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="Rel %" sortKey="relPct" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <TableHead className="w-7 h-8 px-1" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {topSpacer > 0 && (
                <tr aria-hidden style={{ height: topSpacer }}>
                  <td colSpan={6} />
                </tr>
              )}
              {visible.map((peak) => {
                const isSel = selected.has(peak.id);
                return (
                  <TableRow
                    key={peak.id}
                    className={[
                      "h-8 cursor-pointer",
                      isSel ? "bg-muted" : "",
                    ].join(" ")}
                    onClick={() => toggleSelect(peak.id)}
                  >
                    <TableCell className="h-8 py-0 px-2" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSel}
                        onCheckedChange={() => toggleSelect(peak.id)}
                        aria-label="Select peak"
                      />
                    </TableCell>
                    <TableCell
                      className="h-8 max-w-56 truncate py-0 px-2 text-xs"
                      title={peak.sourceLabel}
                    >
                      {peak.sourceLabel}
                    </TableCell>
                    <TableCell className="h-8 py-0 px-2 font-mono text-xs">
                      {peak.mz.toFixed(3)}
                    </TableCell>
                    <TableCell className="h-8 py-0 px-2 font-mono text-xs">
                      {fmtNum(peak.intensity)}
                    </TableCell>
                    <TableCell className="h-8 py-0 px-2 font-mono text-xs">
                      {peak.relPct.toFixed(2)}
                    </TableCell>
                    <TableCell className="h-8 py-0 px-1" onClick={(e) => e.stopPropagation()}>
                      {onDeletePeak && (
                        <button
                          type="button"
                          onClick={() => onDeletePeak(peak.id)}
                          className="text-muted-foreground/60 hover:text-destructive"
                          title="Remove this peak"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {bottomSpacer > 0 && (
                <tr aria-hidden style={{ height: bottomSpacer }}>
                  <td colSpan={6} />
                </tr>
              )}
            </TableBody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Numeric value a peak sorts by for a given column. */
function sortValue(peak: SpectrumPeakRow, key: SortKey): number | string | undefined {
  switch (key) {
    case "sourceLabel":
      return peak.sourceLabel;
    case "mz":
      return peak.mz;
    case "intensity":
      return peak.intensity;
    case "relPct":
      return peak.relPct;
  }
}

/** Compact numeric formatting for the table cells. */
function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
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
    <TableHead className="h-8 px-2 text-xs">
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
