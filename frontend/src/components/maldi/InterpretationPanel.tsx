import {
  CheckCircle2,
  FileJson,
  FileSpreadsheet,
  FileText,
  Image,
  Info,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Finding } from "@/lib/maldi/interpret";
import type { ExportRecord } from "@/lib/maldi/types";

export type ExportKind =
  | "png"
  | "project-json"
  | "report-pdf"
  | "report-excel";

interface InterpretationPanelProps {
  findings: Finding[];
  onRefresh: () => void;
  onExport: (kind: ExportKind) => void;
  exportHistory: ExportRecord[];
}

const TONE_ICON = {
  good: <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />,
  warn: <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />,
  info: <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600" />,
} as const;

/**
 * Heuristic interpretation summary plus the export hub. The findings are
 * deterministic rules over the computed values (not an external model); the
 * export buttons produce CSV / JSON / PNG and full PDF/Excel reports.
 */
export function InterpretationPanel({ findings, onRefresh, onExport, exportHistory }: InterpretationPanelProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-foreground">Interpretation</h3>
          <Button size="sm" variant="ghost" className="h-7" onClick={onRefresh}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
        {findings.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 p-4 text-center text-[11px] text-muted-foreground">
            Pick peaks and run repeat / series detection, then refresh for a summary.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {findings.map((f, i) => (
              <li key={i} className="flex items-start gap-2 rounded-lg border border-border/60 bg-background/60 p-2 text-[11px] leading-snug text-foreground">
                {TONE_ICON[f.tone]}
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold text-foreground">Export</h3>
        <div className="grid gap-2">
          <Button size="sm" className="h-9 justify-start" onClick={() => onExport("report-excel")}>
            <FileSpreadsheet className="mr-1.5 h-4 w-4" /> Excel report
          </Button>
          <div className="grid grid-cols-3 gap-2">
            <Button size="sm" variant="outline" className="h-8 justify-start" onClick={() => onExport("report-pdf")}>
              <FileText className="mr-1.5 h-3.5 w-3.5" /> PDF
            </Button>
            <Button size="sm" variant="outline" className="h-8 justify-start" onClick={() => onExport("png")}>
              <Image className="mr-1.5 h-3.5 w-3.5" /> PNG
            </Button>
            <Button size="sm" variant="outline" className="h-8 justify-start" onClick={() => onExport("project-json")}>
              <FileJson className="mr-1.5 h-3.5 w-3.5" /> JSON
            </Button>
          </div>
        </div>

        {exportHistory.length > 0 && (
          <div className="flex flex-col gap-1">
            <h4 className="text-[11px] font-medium text-muted-foreground">Export history</h4>
            <ul className="max-h-32 overflow-y-auto rounded-lg border border-border/60 bg-background/60 p-1.5 text-[10px] text-muted-foreground">
              {[...exportHistory].reverse().map((e, i) => (
                <li key={i} className="flex justify-between gap-2 py-0.5">
                  <span>{e.label}</span>
                  <span>{new Date(e.at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
