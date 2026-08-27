// Import dropzone for the TGA workspace. Wraps react-dropzone, accepting the
// supported TGA file extensions. Multi-file. Calls back with the dropped files
// so the host can dispatch `parseTgaFiles` and feed the results into the store.

import { useDropzone } from "react-dropzone";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";

const ACCEPT = {
  "text/plain": [".txt", ".csv", ".tsv"],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/octet-stream": [".001", ".002", ".003", ".tri"],
  "application/json": [".tgaproj"],
  "application/pdf": [".pdf"],
};

export function FileDropzone({
  onFiles,
  compact = false,
  className,
}: {
  onFiles: (files: File[]) => void;
  compact?: boolean;
  className?: string;
}) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: ACCEPT,
    onDrop: (accepted) => {
      if (accepted.length > 0) onFiles(accepted);
    },
    noClick: false,
  });
  return (
    <div
      {...getRootProps()}
      className={cn(
        "cursor-pointer rounded-xl border-2 border-dashed border-border/70 bg-muted/30 transition-smooth hover:border-primary/50 hover:bg-muted/50",
        isDragActive && "border-primary bg-primary/5",
        compact ? "px-3 py-4" : "px-6 py-10",
        className,
      )}
    >
      <input {...getInputProps()} />
      <div className="flex flex-col items-center gap-2 text-center">
        <Upload className={compact ? "h-5 w-5 text-muted-foreground" : "h-8 w-8 text-muted-foreground"} />
        <p className={compact ? "text-xs text-muted-foreground" : "text-sm text-muted-foreground"}>
          {isDragActive ? "Drop TGA files here" : "Drop TGA files or click to browse"}
        </p>
        {!compact && (
          <p className="text-[11px] text-muted-foreground/70">
            .txt .csv .tsv .001 .tri .xls .xlsx — a file can yield several runs.
          Drop a .tgaproj to reopen a saved workspace.
          </p>
        )}
      </div>
    </div>
  );
}