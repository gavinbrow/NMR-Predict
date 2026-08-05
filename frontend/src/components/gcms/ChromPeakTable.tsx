import { ChevronDown, ChevronUp, ChevronsUpDown, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ChromPeak } from "@/lib/gcms/types";

/**
 * The chromatographic peak table. Columns: apex RT, editable Start/End RT,
 * Width (rtEnd - rtStart), Height, Area, Area %, Base m/z, and Name. Every
 * header is sortable (click to toggle asc/desc, chevron on the active column).
 * Clicking a row calls `onRowClick(peak)` so the page can move the RT cursor;
 * the selected row is highlighted with `bg-muted`. The range cells commit on
 * blur/Enter through `onRangeChange`, while the `Name` cell calls
 * `onRename(id, name)`.
 *
 * The table renders ALL rows (the true total count is shown in the header) but
 * WINDOWS them: a fixed-height scroll container measures `scrollTop` and
 * renders only the visible slice plus ~10 rows of overscan, with top/bottom
 * spacer rows of the appropriate height. A fixed row height (`h-8` = 32 px)
 * keeps the math simple. Unlike the old GPC `PeakTable`, nothing is silently
 * capped at 500 rows.
 *
 * A trailing delete-× column (Phase 5 task B) calls `onDelete(id)`; it works
 * on both detected and hand-added peaks — the page decides how to reconcile
 * that against its derived peak list, this table just reports the click.
 */
interface ChromPeakTableProps {
  peaks: ChromPeak[];
  selectedPeakId?: string | null;
  onRowClick(peak: ChromPeak): void;
  /** Return an error message to reject the edit, or null when accepted. */
  onRangeChange(id: string, start: number, end: number): string | null;
  onRename(id: string, name: string): void;
  onDelete(id: string): void;
}

type SortKey =
  | "rtApex"
  | "rtStart"
  | "rtEnd"
  | "height"
  | "area"
  | "areaPct"
  | "width"
  | "basePeakMz"
  | "name";

const ROW_H = 32;
const OVERSCAN = 10;

export function ChromPeakTable({
  peaks,
  selectedPeakId,
  onRowClick,
  onRangeChange,
  onRename,
  onDelete,
}: ChromPeakTableProps) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

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

  // Measure the viewport height on mount and when the ref arrives, so the
  // windowing slice is correct before the first scroll.
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
      setSortDir(key === "name" ? "asc" : "asc");
    }
  };

  const commitName = (id: string) => {
    onRename(id, draftName);
    setEditingId(null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
        <span>Chromatographic peaks</span>
        <span>{total} peak{total === 1 ? "" : "s"}</span>
      </div>
      {total === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">No peaks detected.</p>
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
                <SortHead label="RT" sortKey="rtApex" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="Start" sortKey="rtStart" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="End" sortKey="rtEnd" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="Width" sortKey="width" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="Height" sortKey="height" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="Area" sortKey="area" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="Area %" sortKey="areaPct" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="Base m/z" sortKey="basePeakMz" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortHead label="Name" sortKey="name" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <TableHead className="w-7 h-8 px-1" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {topSpacer > 0 && (
                <tr aria-hidden style={{ height: topSpacer }}>
                  <td colSpan={10} />
                </tr>
              )}
              {visible.map((peak) => {
                const selected = peak.id === selectedPeakId;
                const width = peak.rtEnd - peak.rtStart;
                return (
                  <TableRow
                    key={peak.id}
                    className={[
                      "h-8 cursor-pointer",
                      selected ? "bg-muted" : "",
                    ].join(" ")}
                    onClick={() => onRowClick(peak)}
                  >
                    <TableCell className="h-8 py-0 px-2 font-mono text-xs">
                      {peak.rtApex.toFixed(3)}
                    </TableCell>
                    <PeakRangeCells peak={peak} onRangeChange={onRangeChange} />
                    <TableCell className="h-8 py-0 px-2 font-mono text-xs">
                      {width.toFixed(3)}
                    </TableCell>
                    <TableCell className="h-8 py-0 px-2 font-mono text-xs">
                      {fmtNum(peak.height)}
                    </TableCell>
                    <TableCell className="h-8 py-0 px-2 font-mono text-xs">
                      {fmtNum(peak.area)}
                    </TableCell>
                    <TableCell className="h-8 py-0 px-2 font-mono text-xs">
                      {peak.areaPct.toFixed(2)}
                    </TableCell>
                    <TableCell className="h-8 py-0 px-2 font-mono text-xs">
                      {peak.basePeakMz != null ? peak.basePeakMz.toFixed(3) : "—"}
                    </TableCell>
                    <TableCell className="h-8 py-0 px-2" onClick={(e) => e.stopPropagation()}>
                      {editingId === peak.id ? (
                        <Input
                          autoFocus
                          className="h-6 w-full px-1 text-xs"
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          onBlur={() => commitName(peak.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitName(peak.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                        />
                      ) : (
                        <input
                          type="text"
                          className="h-6 w-full cursor-text rounded border border-transparent bg-transparent px-1 text-xs hover:border-border/60 focus:border-border focus:bg-background"
                          value={peak.name ?? ""}
                          placeholder="—"
                          onChange={(e) => onRename(peak.id, e.target.value)}
                          onFocus={() => {
                            setEditingId(peak.id);
                            setDraftName(peak.name ?? "");
                          }}
                        />
                      )}
                    </TableCell>
                    <TableCell className="h-8 py-0 px-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => onDelete(peak.id)}
                        className="text-muted-foreground/60 hover:text-destructive"
                        title="Remove this peak"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {bottomSpacer > 0 && (
                <tr aria-hidden style={{ height: bottomSpacer }}>
                  <td colSpan={10} />
                </tr>
              )}
            </TableBody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Numeric (or string) value a peak sorts by for a given column. */
function sortValue(peak: ChromPeak, key: SortKey): number | string | undefined {
  switch (key) {
    case "rtApex":
      return peak.rtApex;
    case "rtStart":
      return peak.rtStart;
    case "rtEnd":
      return peak.rtEnd;
    case "height":
      return peak.height;
    case "area":
      return peak.area;
    case "areaPct":
      return peak.areaPct;
    case "width":
      return peak.rtEnd - peak.rtStart;
    case "basePeakMz":
      return peak.basePeakMz ?? undefined;
    case "name":
      return peak.name ?? "";
  }
}

/**
 * Paired range inputs for one peak row. Draft strings deliberately live here
 * so users can temporarily type an empty or partial number. The host validates
 * the complete pair on blur/Enter and can return a domain-specific error.
 */
function PeakRangeCells({
  peak,
  onRangeChange,
}: {
  peak: ChromPeak;
  onRangeChange(id: string, start: number, end: number): string | null;
}) {
  const [startDraft, setStartDraft] = useState(formatRtDraft(peak.rtStart));
  const [endDraft, setEndDraft] = useState(formatRtDraft(peak.rtEnd));
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const lastAcceptedDraftRef = useRef<string | null>(null);

  useEffect(() => {
    setStartDraft(formatRtDraft(peak.rtStart));
    setEndDraft(formatRtDraft(peak.rtEnd));
    setError(null);
    lastAcceptedDraftRef.current = null;
  }, [peak.id, peak.rtStart, peak.rtEnd]);

  const reset = () => {
    setStartDraft(formatRtDraft(peak.rtStart));
    setEndDraft(formatRtDraft(peak.rtEnd));
    setError(null);
    lastAcceptedDraftRef.current = null;
  };

  const commit = () => {
    if (startDraft.trim() === "" || endDraft.trim() === "") {
      setError("Start and end retention times are required.");
      return;
    }
    const start = Number(startDraft);
    const end = Number(endDraft);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      setError("Start and end retention times must be finite numbers.");
      return;
    }
    if (start === peak.rtStart && end === peak.rtEnd) {
      setError(null);
      return;
    }
    const draftKey = `${startDraft}\u0000${endDraft}`;
    if (lastAcceptedDraftRef.current === draftKey) return;
    const nextError = onRangeChange(peak.id, start, end);
    setError(nextError);
    if (!nextError) lastAcceptedDraftRef.current = draftKey;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      reset();
    }
  };

  const sharedProps = {
    type: "number" as const,
    step: "any",
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": error ? errorId : undefined,
    title: error ?? undefined,
    className: [
      "h-6 w-20 rounded border bg-background px-1 font-mono text-xs",
      error ? "border-destructive text-destructive" : "border-border/60",
    ].join(" "),
    onBlur: commit,
    onKeyDown: handleKeyDown,
  };

  return (
    <>
      <TableCell className="h-8 py-0 px-1" onClick={(event) => event.stopPropagation()}>
        <input
          {...sharedProps}
          aria-label={`Peak ${peak.rtApex.toFixed(3)} start retention time (min)`}
          value={startDraft}
          onChange={(event) => {
            setStartDraft(event.target.value);
            setError(null);
            lastAcceptedDraftRef.current = null;
          }}
        />
        {error && (
          <span id={errorId} role="alert" className="sr-only">
            {error}
          </span>
        )}
      </TableCell>
      <TableCell className="h-8 py-0 px-1" onClick={(event) => event.stopPropagation()}>
        <input
          {...sharedProps}
          aria-label={`Peak ${peak.rtApex.toFixed(3)} end retention time (min)`}
          value={endDraft}
          onChange={(event) => {
            setEndDraft(event.target.value);
            setError(null);
            lastAcceptedDraftRef.current = null;
          }}
        />
      </TableCell>
    </>
  );
}

function formatRtDraft(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "";
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
