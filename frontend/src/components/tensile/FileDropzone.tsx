import { Loader2, Upload } from "lucide-react";
import { useCallback, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { toast } from "sonner";
import { parseWorkbook } from "@/lib/tensile/parse";
import { useTensileStore } from "@/lib/tensile/store";
import { cn } from "@/lib/utils";

/**
 * Multi-file `.xlsx` dropzone (Phase 4). Drag-and-drop or click to browse; each
 * accepted workbook is read locally, parsed (Phase 1) — which immediately makes
 * the store recompute its properties (Phases 2–3) — and added without disturbing
 * any file already loaded. Non-`.xlsx` files are rejected with a clear message.
 *
 * `compact` renders the smaller "Add more files" affordance used once data is
 * already loaded; the default is the large empty-state target.
 */
export function FileDropzone({ compact = false }: { compact?: boolean }) {
  const { addParsedWorkbooks } = useTensileStore();
  const [busy, setBusy] = useState(false);

  const onDrop = useCallback(
    async (accepted: File[], rejections: FileRejection[]) => {
      if (rejections.length > 0) {
        const names = rejections.map((r) => r.file.name).join(", ");
        toast.error("Only .xlsx files are supported", { description: names });
      }
      if (accepted.length === 0) return;

      setBusy(true);
      const parsed = [];
      const failed: string[] = [];
      for (const file of accepted) {
        try {
          const buf = await file.arrayBuffer();
          const wb = parseWorkbook(buf, file.name);
          parsed.push(wb);
        } catch (err) {
          failed.push(`${file.name}: ${err instanceof Error ? err.message : "unreadable"}`);
        }
      }
      setBusy(false);

      if (parsed.length > 0) {
        addParsedWorkbooks(parsed);
        const noRuns = parsed.filter((p) => p.runs.length === 0).map((p) => p.fileName);
        if (noRuns.length > 0) {
          toast.warning("No specimens detected", {
            description: `${noRuns.join(", ")} — check it has [strain, stress] columns.`,
          });
        }
      }
      if (failed.length > 0) {
        toast.error(`${failed.length} file(s) could not be read`, {
          description: failed.join("\n"),
        });
      }
    },
    [addParsedWorkbooks],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/vnd.ms-excel": [".xls"],
    },
    multiple: true,
    disabled: busy,
  });

  return (
    <div
      {...getRootProps()}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed text-center transition-smooth",
        compact ? "px-4 py-5" : "px-6 py-12",
        isDragActive
          ? "border-primary bg-primary/5"
          : "border-border/70 bg-background/40 hover:border-primary/40",
      )}
    >
      <input {...getInputProps()} />
      <div
        className={cn(
          "flex items-center justify-center rounded-2xl",
          compact ? "h-10 w-10" : "h-14 w-14",
          busy ? "bg-transparent" : "bg-gradient-primary shadow-elegant",
        )}
      >
        {busy ? (
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        ) : (
          <Upload className={cn("text-primary-foreground", compact ? "h-5 w-5" : "h-6 w-6")} />
        )}
      </div>
      <div>
        <p className={cn("font-semibold text-foreground", compact ? "text-sm" : "text-base")}>
          {busy
            ? "Reading workbooks…"
            : isDragActive
              ? "Drop the .xlsx files here"
              : compact
                ? "Add more files"
                : "Drop tensile .xlsx files here"}
        </p>
        {!compact && (
          <p className="mt-1 text-sm text-muted-foreground">
            zwickRoell / Instron exports — drag &amp; drop several at once, or click to browse.
            Nothing is uploaded.
          </p>
        )}
      </div>
    </div>
  );
}
