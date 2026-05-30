import { FileUp, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Delimiter, ParseMeta, ParseOptions } from "@/lib/maldi/parse";

interface ImportPanelProps {
  onFile: (text: string, fileName: string, options: ParseOptions) => void;
  /** Handle binary mass-spec formats (mzML / mzXML / MGF) via the worker. */
  onMsFile?: (buffer: ArrayBuffer, fileName: string) => void;
  busy?: boolean;
  meta?: ParseMeta | null;
  sourceName?: string;
  /** Compact mode for the sidebar once a spectrum is already loaded. */
  compact?: boolean;
}

type DelimiterChoice = Delimiter | "auto";
type HeaderChoice = "auto" | "yes" | "no";

const MS_EXTENSIONS = /\.(mzml|mzxml|mgf)$/i;

export function ImportPanel({ onFile, onMsFile, busy, meta, sourceName, compact }: ImportPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [delimiter, setDelimiter] = useState<DelimiterChoice>("auto");
  const [header, setHeader] = useState<HeaderChoice>("auto");

  const buildOptions = (): ParseOptions => ({
    delimiter,
    hasHeader: header === "auto" ? "auto" : header === "yes",
  });

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const reader = new FileReader();
    if (onMsFile && MS_EXTENSIONS.test(file.name)) {
      reader.onload = () => onMsFile(reader.result as ArrayBuffer, file.name);
      reader.readAsArrayBuffer(file);
      return;
    }
    reader.onload = () => onFile(String(reader.result ?? ""), file.name, buildOptions());
    reader.readAsText(file);
  };

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={[
          "flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-6 text-center transition-smooth",
          dragging ? "border-primary bg-primary/5" : "border-border/70 bg-background/40 hover:border-primary/40",
          compact ? "py-4" : "py-8",
        ].join(" ")}
      >
        {busy ? (
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10">
            <FileUp className="h-5 w-5 text-primary" />
          </div>
        )}
        <div>
          <p className="text-sm font-semibold text-foreground">
            {sourceName ? "Replace spectrum" : "Drop a CSV/TXT spectrum"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            CSV/TXT (m/z, intensity){onMsFile ? ", or mzML / mzXML / MGF" : ""}. Click to browse.
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={onMsFile ? ".csv,.txt,.tsv,.asc,.dat,.mzml,.mzxml,.mgf,text/plain" : ".csv,.txt,.tsv,.asc,.dat,text/plain"}
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </button>

      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1.5">
          <Label className="text-[11px] text-muted-foreground">Delimiter</Label>
          <Select value={delimiter} onValueChange={(v) => setDelimiter(v as DelimiterChoice)}>
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto-detect</SelectItem>
              <SelectItem value="comma">Comma</SelectItem>
              <SelectItem value="tab">Tab</SelectItem>
              <SelectItem value="semicolon">Semicolon</SelectItem>
              <SelectItem value="space">Whitespace</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-[11px] text-muted-foreground">Header row</Label>
          <Select value={header} onValueChange={(v) => setHeader(v as HeaderChoice)}>
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto-detect</SelectItem>
              <SelectItem value="yes">Has header</SelectItem>
              <SelectItem value="no">No header</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {meta && sourceName && (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
          <p className="truncate font-medium text-foreground" title={sourceName}>
            {sourceName}
          </p>
          <p className="mt-0.5">
            {meta.rowCount.toLocaleString()} points · {meta.delimiter} delimiter
            {meta.hasHeader ? " · header" : ""}
            {meta.skippedRows ? ` · ${meta.skippedRows} skipped` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
