import { Eye, EyeOff, FileUp, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resampleOnto } from "@/lib/maldi/view";
import type { SpectrumData } from "@/lib/maldi/types";

export interface ComparisonSpectrum {
  id: string;
  name: string;
  spectrum: SpectrumData;
  /** Per-trace stroke colour. */
  color?: string;
  /** Vertical offset (stacked-style) applied to the resampled trace. */
  offset?: number;
  /** When false, the trace is hidden from the plot. */
  visible?: boolean;
  /** Source document id when this comparison came from an already-open spectrum
   *  (used to keep the "Add open spectrum" list free of duplicates). */
  sourceDocId?: string;
}

interface CompareViewProps {
  current: SpectrumData | null;
  currentName: string;
  comparisons: ComparisonSpectrum[];
  onAddFiles: (files: FileList) => void;
  onRemove: (id: string) => void;
  busy?: boolean;
  /** Other currently-open spectra, offered as one-click comparison additions. */
  openDocuments?: { id: string; name: string }[];
  /** Add an open spectrum to the comparison list. */
  onAddFromOpen?: (docId: string) => void;
  /** Patch a comparison (colour / offset / visibility). */
  onUpdate?: (id: string, patch: Partial<ComparisonSpectrum>) => void;
}

const COLORS = ["#1e293b", "#0ea5e9", "#a855f7", "#f59e0b", "#ef4444", "#10b981", "#6366f1", "#ec4899"];
const GRID_POINTS = 3000;

/**
 * Multi-spectrum comparison: overlays the current spectrum with one or more
 * loaded (or already-open) reference spectra on a shared, resampled m/z axis,
 * with per-item colour / visibility / vertical offset, drag-and-drop file
 * import, scroll-to-zoom the intensity axis, and a difference mode
 * (current - first visible reference) for before/after-reaction work.
 */
export function CompareView({
  current,
  currentName,
  comparisons,
  onAddFiles,
  onRemove,
  busy,
  openDocuments,
  onAddFromOpen,
  onUpdate,
}: CompareViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [mode, setMode] = useState<"overlay" | "difference">("overlay");
  const [normalize, setNormalize] = useState(true);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (!containerRef.current || !current || current.mz.length === 0) return;
    const container = containerRef.current;

    const lo = current.mz[0];
    const hi = current.mz[current.mz.length - 1];
    const grid = new Float64Array(GRID_POINTS);
    for (let i = 0; i < GRID_POINTS; i += 1) grid[i] = lo + ((hi - lo) * i) / (GRID_POINTS - 1);

    const norm = (arr: Float64Array): Float64Array => {
      if (!normalize) return arr;
      let max = 0;
      for (const v of arr) if (v > max) max = v;
      if (max <= 0) return arr;
      const out = new Float64Array(arr.length);
      for (let i = 0; i < arr.length; i += 1) out[i] = (arr[i] / max) * 100;
      return out;
    };

    const applyOffset = (arr: Float64Array, offset: number): Float64Array => {
      if (!offset) return arr;
      const out = new Float64Array(arr.length);
      for (let i = 0; i < arr.length; i += 1) out[i] = arr[i] + offset;
      return out;
    };

    const visible = comparisons.filter((c) => c.visible !== false);
    const curY = norm(resampleOnto(grid, current));
    const series: { label: string; stroke: string }[] = [{ label: currentName || "current", stroke: COLORS[0] }];
    const data: (number[] | Float64Array)[] = [grid, curY];

    if (mode === "difference" && visible[0]) {
      const ref = norm(resampleOnto(grid, visible[0].spectrum));
      const diff = new Float64Array(grid.length);
      for (let i = 0; i < grid.length; i += 1) diff[i] = curY[i] - ref[i];
      data.length = 1;
      data.push(diff);
      series.length = 0;
      series.push({ label: `delta (${currentName} - ${visible[0].name})`, stroke: COLORS[2] });
    } else {
      visible.forEach((c, i) => {
        const stroke = c.color ?? COLORS[(i + 1) % COLORS.length];
        data.push(applyOffset(norm(resampleOnto(grid, c.spectrum)), c.offset ?? 0));
        series.push({ label: c.name, stroke });
      });
    }

    const opts: Options = {
      width: container.clientWidth,
      height: container.clientHeight,
      legend: { show: true },
      cursor: { drag: { x: true, y: false } },
      scales: { x: { time: false }, y: {} },
      axes: [
        { label: "m/z", grid: { stroke: "#e2e8f0", width: 1 } },
        { label: normalize ? "rel. intensity (%)" : "intensity", grid: { stroke: "#e2e8f0", width: 1 } },
      ],
      series: [{}, ...series.map((s) => ({ label: s.label, stroke: s.stroke, width: 1, points: { show: false } }))],
    };

    const plot = new uPlot(opts, data as AlignedData, container);
    plotRef.current = plot;

    // Scroll-to-zoom the intensity (y) axis around the cursor, so small peaks
    // can be revealed without touching the x range.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const scaleY = plot.scales.y;
      if (!scaleY || scaleY.min == null || scaleY.max == null) return;
      const rect = plot.over.getBoundingClientRect();
      const yPx = event.clientY - rect.top;
      const focus = plot.posToVal(yPx, "y");
      const lo = scaleY.min;
      const hi = scaleY.max;
      const factor = event.deltaY < 0 ? 0.8 : 1.25; // zoom in / out
      const span = (hi - lo) || Math.abs(hi) || 1;
      let newLo = focus - (focus - lo) * factor;
      let newHi = focus + (hi - focus) * factor;
      if (newHi - newLo < span * 0.02) { newLo = focus - span * 0.01; newHi = focus + span * 0.01; }
      plot.setScale("y", { min: newLo, max: newHi });
    };
    plot.over.addEventListener("wheel", onWheel, { passive: false });

    const ro = new ResizeObserver(() => plot.setSize({ width: container.clientWidth, height: container.clientHeight }));
    ro.observe(container);
    return () => {
      plot.over.removeEventListener("wheel", onWheel);
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [current, currentName, comparisons, mode, normalize]);

  // Drop files anywhere on the compare panel to add them.
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files?.length) onAddFiles(event.dataTransfer.files);
  };

  const selectableOpen = (openDocuments ?? []).filter(
    (d) => !comparisons.some((c) => c.sourceDocId === d.id),
  );

  return (
    <div
      className="flex h-full flex-col gap-2"
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,.txt,.tsv,.asc,.dat,.mzml,.mzxml,.mgf,text/plain"
          className="hidden"
          onChange={(e) => e.target.files && onAddFiles(e.target.files)}
        />
        <Button size="sm" variant="outline" className="h-7" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FileUp className="mr-1 h-3.5 w-3.5" />}
          Add spectra
        </Button>
        <div className="flex overflow-hidden rounded-md border border-border/70">
          {(["overlay", "difference"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              disabled={m === "difference" && comparisons.filter((c) => c.visible !== false).length === 0}
              className={[
                "px-2.5 py-1 text-[11px] capitalize transition-smooth disabled:opacity-40",
                mode === m ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted",
              ].join(" ")}
            >
              {m}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title="Scroll the plot to zoom the intensity axis">
          <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
          Normalize
        </label>
      </div>

      {/* Already-open spectra: one-click add as clickable chips (plus a dropdown for long lists). */}
      {onAddFromOpen && selectableOpen.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">In this session:</span>
          {selectableOpen.slice(0, 8).map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => onAddFromOpen(d.id)}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-[11px] hover:border-primary/40"
              title={`Add ${d.name} to the comparison`}
            >
              <FileUp className="h-3 w-3" />
              {d.name}
            </button>
          ))}
          {selectableOpen.length > 8 && (
            <Select value="" onValueChange={(v) => v && onAddFromOpen(v)}>
              <SelectTrigger className="h-6 w-40 text-[11px]">
                <SelectValue placeholder={`${selectableOpen.length - 8} more`} />
              </SelectTrigger>
              <SelectContent>
                {selectableOpen.slice(8).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-2">
        {comparisons.length > 0 && (
          <div className="flex w-56 shrink-0 flex-col gap-1.5 overflow-y-auto rounded-lg border border-border/60 p-1.5">
            {comparisons.map((c, i) => {
              const visible = c.visible !== false;
              const color = c.color ?? COLORS[(i + 1) % COLORS.length];
              return (
                <div key={c.id} className="flex items-center gap-1.5 rounded-md border border-border/50 bg-background/60 px-1.5 py-1">
                  <button
                    type="button"
                    title={visible ? "Hide" : "Show"}
                    onClick={() => onUpdate?.(c.id, { visible: !visible })}
                    className={visible ? "text-muted-foreground hover:text-foreground" : "text-muted-foreground/40"}
                  >
                    {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  </button>
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => onUpdate?.(c.id, { color: e.target.value })}
                    title="Trace colour"
                    className="h-5 w-5 shrink-0 cursor-pointer rounded border border-border/60 bg-transparent p-0.5"
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px]" title={c.name}>
                    {c.name}
                  </span>
                  <Input
                    type="number"
                    className="h-6 w-12 px-1 text-[11px]"
                    value={c.offset ?? 0}
                    onChange={(e) => onUpdate?.(c.id, { offset: Number(e.target.value) || 0 })}
                    title="Vertical offset"
                  />
                  <button type="button" onClick={() => onRemove(c.id)} className="text-muted-foreground hover:text-destructive">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {!current ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Import a spectrum first, then add others to compare.
          </div>
        ) : (
          <div
            ref={containerRef}
            className={
              "relative min-h-0 flex-1 rounded-lg " +
              (dragOver ? "ring-2 ring-primary/60 ring-offset-2" : "")
            }
          >
            {dragOver && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-primary/5 text-xs font-medium text-primary">
                Drop spectrum files to compare
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
