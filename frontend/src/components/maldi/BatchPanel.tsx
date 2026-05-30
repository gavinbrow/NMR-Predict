import { FileUp, Loader2, Layers3 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { matchRepeatUnit } from "@/lib/maldi/repeatLibrary";
import {
  detectRepeatUnits,
  parse,
  parseMs,
  pickPeaks,
  process,
} from "@/lib/maldi/workerClient";
import type { PeakPickParams } from "@/lib/maldi/peaks";
import type { ProcessingStep, SpectrumData } from "@/lib/maldi/types";

interface BatchRow {
  name: string;
  points: number;
  peaks: number;
  topRepeat: number | null;
  repeatLabel: string | null;
  error?: string;
}

interface BatchPanelProps {
  steps: ProcessingStep[];
  pickParams: PeakPickParams;
}

const MS_EXTENSIONS = /\.(mzml|mzxml|mgf)$/i;

/**
 * Batch processing: runs the current processing pipeline + peak picking +
 * repeat-unit detection across many files and tabulates the result. Each file is
 * processed through the same worker, so the UI stays responsive.
 */
export function BatchPanel({ steps, pickParams }: BatchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  const readSpectrum = async (file: File): Promise<SpectrumData> => {
    if (MS_EXTENSIONS.test(file.name)) {
      const buffer = await file.arrayBuffer();
      const result = await parseMs(buffer, file.name);
      return result.spectrum;
    }
    const text = await file.text();
    const result = await parse(text);
    return result.spectrum;
  };

  const runBatch = async (files: FileList) => {
    setRunning(true);
    setRows([]);
    setProgress(0);
    const out: BatchRow[] = [];
    const list = Array.from(files);
    for (let i = 0; i < list.length; i += 1) {
      const file = list[i];
      try {
        const raw = await readSpectrum(file);
        const { processed } = await process(raw, steps);
        const { peaks } = await pickPeaks(processed, pickParams);
        const { candidates } = await detectRepeatUnits(peaks);
        const top = candidates[0]?.repeatMass ?? null;
        const match = top != null ? matchRepeatUnit(top) : null;
        out.push({
          name: file.name,
          points: raw.mz.length,
          peaks: peaks.length,
          topRepeat: top,
          repeatLabel: match?.abbr ?? match?.name ?? null,
        });
      } catch (e) {
        out.push({ name: file.name, points: 0, peaks: 0, topRepeat: null, repeatLabel: null, error: e instanceof Error ? e.message : "failed" });
      }
      setProgress((i + 1) / list.length);
      setRows([...out]);
    }
    setRunning(false);
    toast.success(`Processed ${list.length} file${list.length === 1 ? "" : "s"}`);
  };

  const exportCsv = () => {
    const header = "file,points,peaks,topRepeat,repeatMatch,error";
    const body = rows
      .map((r) => [r.name, r.points, r.peaks, r.topRepeat?.toFixed(4) ?? "", r.repeatLabel ?? "", r.error ?? ""].join(","))
      .join("\n");
    const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "maldi-batch-summary.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        Apply the current processing + peak-picking settings to many files at once and detect the repeat
        unit in each. Useful for screening a series of samples.
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".csv,.txt,.tsv,.asc,.dat,.mzml,.mzxml,.mgf,text/plain"
        className="hidden"
        onChange={(e) => e.target.files && runBatch(e.target.files)}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="h-8" onClick={() => inputRef.current?.click()} disabled={running}>
          {running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FileUp className="mr-1.5 h-4 w-4" />}
          Select files
        </Button>
        {rows.length > 0 && !running && (
          <Button size="sm" variant="ghost" className="h-8" onClick={exportCsv}>
            <Layers3 className="mr-1.5 h-4 w-4" /> Export summary CSV
          </Button>
        )}
      </div>

      {running && (
        <div className="h-1.5 w-full overflow-hidden rounded bg-border">
          <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}

      {rows.length > 0 && (
        <div className="max-h-72 overflow-y-auto rounded-lg border border-border/60">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left font-medium">File</th>
                <th className="px-2 py-1 text-right font-medium">Points</th>
                <th className="px-2 py-1 text-right font-medium">Peaks</th>
                <th className="px-2 py-1 text-right font-medium">Repeat</th>
                <th className="px-2 py-1 text-left font-medium">Match</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-t border-border/40">
                  <td className="max-w-[160px] truncate px-2 py-1 text-foreground" title={r.name}>{r.name}</td>
                  <td className="px-2 py-1 text-right font-mono text-muted-foreground">{r.error ? "—" : r.points.toLocaleString()}</td>
                  <td className="px-2 py-1 text-right font-mono text-muted-foreground">{r.error ? "—" : r.peaks}</td>
                  <td className="px-2 py-1 text-right font-mono text-muted-foreground">{r.topRepeat != null ? r.topRepeat.toFixed(3) : "—"}</td>
                  <td className="px-2 py-1 text-muted-foreground">{r.error ? <span className="text-destructive">{r.error}</span> : r.repeatLabel ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
