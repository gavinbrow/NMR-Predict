import { AlertTriangle, FileSpreadsheet, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTensileStore } from "@/lib/tensile/store";
import type { LoadedFile } from "@/lib/tensile/types";

const DETECTION_LABEL: Record<LoadedFile["detection"], string> = {
  header: "labelled header",
  numeric: "legacy column-pairs",
  none: "no runs detected",
};

/** A card summarizing one loaded workbook (Phase 4): specimen count, strain unit,
 *  skipped sheets, detection path, and a remove (×) button. */
export function FileCard({ file }: { file: LoadedFile }) {
  const { removeFile } = useTensileStore();
  const empty = file.specimenCount === 0;

  return (
    <div className="relative flex flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4 shadow-card">
      <button
        type="button"
        onClick={() => removeFile(file.id)}
        aria-label={`Remove ${file.fileName}`}
        className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex items-start gap-3 pr-8">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <FileSpreadsheet className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground" title={file.fileName}>
            {file.fileName}
          </p>
          <p className="text-xs text-muted-foreground">{DETECTION_LABEL[file.detection]}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {empty ? (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="h-3 w-3" />
            No specimens
          </Badge>
        ) : (
          <Badge variant="secondary">
            {file.specimenCount} {file.specimenCount === 1 ? "specimen" : "specimens"}
          </Badge>
        )}
        {file.strainUnit !== "n/a" && (
          <Badge variant="outline">strain {file.strainUnit}</Badge>
        )}
      </div>

      {file.skippedSheets.length > 0 && (
        <p className="text-[11px] leading-4 text-muted-foreground">
          Skipped: {file.skippedSheets.join(", ")}
        </p>
      )}
    </div>
  );
}
