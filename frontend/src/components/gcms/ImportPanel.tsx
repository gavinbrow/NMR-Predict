import { FileUp, FolderOpen, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { collectDroppedFiles } from "@/lib/gcms/load";
import { cn } from "@/lib/utils";

interface ImportPanelProps {
  /** Receives the whole batch of dropped/picked files. The host dispatches them. */
  onFiles(files: File[]): void;
  /** Disable inputs and show the spinner while a batch is loading. */
  busy?: boolean;
  /** Live progress from the loader (`{ msg, frac }`), or null when idle. */
  progress?: { msg: string; frac: number } | null;
  /** Per-file errors as `"<filename>: <message>"` strings. */
  errors?: string[];
}

const ACCEPT = ".ms,.d,.ch,.uv,.mzml,.mzxml,.mgf,.cdf,.nc,.csv,.tsv,.txt,.jdx,.dx";

export function ImportPanel({ onFiles, busy, progress, errors }: ImportPanelProps) {
  const folderRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const dispatch = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  };

  // Drop handler: traverse dropped folders via the File System Entries API so a
  // dropped `.D` directory is enumerated, not silently ignored. Calls
  // preventDefault (NOT stopPropagation) so the page-level window drop listener
  // still fires and clears the full-window drag overlay; the window handler
  // bails on `e.defaultPrevented` so the file isn't imported twice.
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = await collectDroppedFiles(e.dataTransfer);
    if (files.length > 0) onFiles(files);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          className="w-full justify-start"
          disabled={busy}
          onClick={() => folderRef.current?.click()}
        >
          <FolderOpen className="h-4 w-4" />
          Load .D folder
        </Button>
        <input
          ref={folderRef}
          type="file"
          // @ts-expect-error webkitdirectory is not in the React TS DOM types
          webkitdirectory=""
          directory=""
          multiple
          className="hidden"
          onChange={(e) => {
            dispatch(e.target.files);
            e.target.value = "";
          }}
        />

        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            if (!dragging) setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={handleDrop}
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-5 text-center transition-smooth",
            dragging
              ? "border-primary bg-primary/5"
              : "border-border/70 bg-background/40 hover:border-primary/40",
          )}
        >
          {busy ? (
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10">
              <FileUp className="h-5 w-5 text-primary" />
            </div>
          )}
          <div>
            <p className="text-sm font-semibold text-foreground">Add files</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              .ms, .ch, .mzml, .mzxml, .mgf, .cdf, .csv — drag &amp; drop or click.
            </p>
          </div>
        </button>
        <Input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            dispatch(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {progress && (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
          <p className="truncate font-medium text-foreground" title={progress.msg}>
            {progress.msg}
          </p>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-border/60">
            <div
              className="h-full bg-primary transition-smooth"
              style={{ width: `${Math.round((progress.frac ?? 0) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {errors && errors.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {errors.map((e, i) => (
            <p key={i} className="text-xs text-destructive">
              {e}
            </p>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Files are read locally in your browser — never uploaded, never modified.
      </p>
    </div>
  );
}