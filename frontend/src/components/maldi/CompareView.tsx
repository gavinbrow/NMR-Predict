import { FileUp, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import { Button } from "@/components/ui/button";
import { resampleOnto } from "@/lib/maldi/view";
import type { SpectrumData } from "@/lib/maldi/types";

export interface ComparisonSpectrum {
  id: string;
  name: string;
  spectrum: SpectrumData;
}

interface CompareViewProps {
  current: SpectrumData | null;
  currentName: string;
  comparisons: ComparisonSpectrum[];
  onAddFiles: (files: FileList) => void;
  onRemove: (id: string) => void;
  busy?: boolean;
}

const COLORS = ["#1e293b", "#0ea5e9", "#a855f7", "#f59e0b", "#ef4444", "#10b981"];
const GRID_POINTS = 3000;

/**
 * Multi-spectrum comparison: overlays the current spectrum with one or more
 * loaded reference spectra on a shared, resampled m/z axis, with a difference
 * mode (current − first reference) for before/after-reaction work.
 */
export function CompareView({ current, currentName, comparisons, onAddFiles, onRemove, busy }: CompareViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [mode, setMode] = useState<"overlay" | "difference">("overlay");
  const [normalize, setNormalize] = useState(true);

  useEffect(() => {
    if (!containerRef.current || !current || current.mz.length === 0) return;
    const container = containerRef.current;

    // Common uniform grid spanning the current spectrum.
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

    const curY = norm(resampleOnto(grid, current));
    const series: { label: string; stroke: string }[] = [{ label: currentName || "current", stroke: COLORS[0] }];
    const data: (number[] | Float64Array)[] = [grid, curY];

    if (mode === "difference" && comparisons[0]) {
      const ref = norm(resampleOnto(grid, comparisons[0].spectrum));
      const diff = new Float64Array(grid.length);
      for (let i = 0; i < grid.length; i += 1) diff[i] = curY[i] - ref[i];
      data.length = 1;
      data.push(diff);
      series.length = 0;
      series.push({ label: `Δ (${currentName} − ${comparisons[0].name})`, stroke: COLORS[2] });
    } else {
      comparisons.forEach((c, i) => {
        data.push(norm(resampleOnto(grid, c.spectrum)));
        series.push({ label: c.name, stroke: COLORS[(i + 1) % COLORS.length] });
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
    const ro = new ResizeObserver(() => plot.setSize({ width: container.clientWidth, height: container.clientHeight }));
    ro.observe(container);
    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [current, currentName, comparisons, mode, normalize]);

  return (
    <div className="flex h-full flex-col gap-2">
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
              disabled={m === "difference" && comparisons.length === 0}
              className={[
                "px-2.5 py-1 text-[11px] capitalize transition-smooth disabled:opacity-40",
                mode === m ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted",
              ].join(" ")}
            >
              {m}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
          Normalize
        </label>

        <div className="ml-auto flex flex-wrap gap-1">
          {comparisons.map((c, i) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]"
              style={{ borderColor: COLORS[(i + 1) % COLORS.length], color: COLORS[(i + 1) % COLORS.length] }}
            >
              {c.name}
              <button type="button" onClick={() => onRemove(c.id)}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      </div>

      {!current ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Import a spectrum first, then add others to compare.
        </div>
      ) : (
        <div ref={containerRef} className="min-h-0 flex-1" />
      )}
    </div>
  );
}
