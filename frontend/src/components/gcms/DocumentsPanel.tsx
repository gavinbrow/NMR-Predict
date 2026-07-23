import { Check, X } from "lucide-react";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { GcmsDocument } from "@/lib/gcms/types";

/**
 * The GC/MS "Documents" panel: a narrow strip beside the chromatogram listing
 * every open run, one row per document (mirroring mMass's document list and
 * the MALDI workspace's equivalent). Per row:
 *  - colour dot — click to open a native colour picker; doubles as the plot
 *    legend swatch for that trace;
 *  - checkbox — whether the trace is drawn on the plot (`visible`);
 *  - name — bold when this is the active document; clicking it makes it active;
 *  - × — closes the document;
 *  - vertical offset number (compact, revealed on hover).
 *
 * Active and visible are INDEPENDENT states: the active document's trace can
 * be hidden on the chromatogram via its checkbox (the spectrum panel still
 * follows the active document regardless of chromatogram visibility).
 *
 * Panel header: **Normalize** (scale every visible trace to 100 %), **Stack**
 * (spread the visible traces out with evenly-spaced vertical offsets so they
 * don't overlap), and **Lock spectra to cursor RT** — when ON every visible run
 * shows its OWN scan nearest the chromatogram cursor RT (side-by-side
 * comparison); when OFF, inactive runs keep the scan they were pinned at.
 *
 * If the panel gets a drop zone, it MUST call `preventDefault()` — the global
 * window drop handler (`Gcms.tsx`) skips events with `defaultPrevented`, and
 * that guard's old counterpart was the page-level `onDrop`. Forget it and every
 * drop imports twice.
 */
interface DocumentsPanelProps {
  documents: GcmsDocument[];
  activeDocId: string | null;
  /** Normalize: scale every visible trace to a 100 % max. */
  normalize: boolean;
  onNormalizeChange(v: boolean): void;
  /** Stack: spread the visible traces out with evenly-spaced vertical offsets. */
  stacked: boolean;
  onStackedChange(v: boolean): void;
  /** Lock spectra to cursor RT: every visible run shows the scan nearest the
   *  chromatogram cursor RT; when OFF inactive runs keep their pinned scan. */
  lockSpectraToCursor: boolean;
  onLockSpectraToCursorChange(v: boolean): void;
  /** Make the given document the active one (its analysis owns every tab). */
  onSwitch(id: string): void;
  /** Close a document (remove it from the session). */
  onClose(id: string): void;
  /** Patch a document's session-only trace styling (colour / visibility / offset). */
  onPatch(id: string, patch: Partial<Pick<GcmsDocument, "color" | "visible" | "offset">>): void;
  /** Import dropped run files (handled by the host's multi-file importer). */
  onFiles(files: File[]): void;
}

export function DocumentsPanel({
  documents,
  activeDocId,
  normalize,
  onNormalizeChange,
  stacked,
  onStackedChange,
  lockSpectraToCursor,
  onLockSpectraToCursorChange,
  onSwitch,
  onClose,
  onPatch,
  onFiles,
}: DocumentsPanelProps) {
  // The colour picker is a tiny native `<input type="color">` revealed by
  // clicking a row's colour dot. Only one row's picker is open at a time; we
  // track the open row's id so the dot acts like a popover trigger.
  const [openColorFor, setOpenColorFor] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  if (documents.length === 0) return null;

  return (
    <div
      className="relative flex h-full flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-2"
      onDragOver={(e) => {
        // Mark the panel as a drop target so the GLOBAL window drop handler
        // skips this event (it bails on `defaultPrevented`). Without this, every
        // file dropped here would import twice — once via the panel, once via
        // the window. We don't actually import here; we just prevent the
        // window handler from also firing. The window handler does the import.
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        // `preventDefault` keeps the global window drop handler from
        // re-importing the same files (it bails on `defaultPrevented`). The
        // panel then hands the dropped files to the host's importer directly.
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length) onFiles(files);
      }}
    >
      {/* Header: the three trace-shaping controls. Disabled until there is
          something to shape (>1 document); a single open document has no
          overlay to normalize / stack against. */}
      <div className="flex flex-col gap-1.5">
        <label
          className="flex items-center justify-between gap-1.5 text-[11px] text-muted-foreground"
          title="Scale every visible trace to a 100 % max"
        >
          <span>Normalize</span>
          <Switch checked={normalize} onCheckedChange={onNormalizeChange} disabled={documents.length < 2} />
        </label>
        <label
          className="flex items-center justify-between gap-1.5 text-[11px] text-muted-foreground"
          title="Spread the visible traces out with evenly-spaced vertical offsets"
        >
          <span>Stack</span>
          <Switch checked={stacked} onCheckedChange={onStackedChange} disabled={documents.length < 2} />
        </label>
        <label
          className="flex items-center justify-between gap-1.5 text-[11px] text-muted-foreground"
          title="Every visible run shows the scan nearest the chromatogram cursor RT (side-by-side comparison)"
        >
          <span>Lock spectra to cursor RT</span>
          <Switch checked={lockSpectraToCursor} onCheckedChange={onLockSpectraToCursorChange} />
        </label>
        {lockSpectraToCursor && (
          <p className="text-[10px] leading-tight text-muted-foreground">
            Every visible run shows its own scan nearest the cursor RT.
          </p>
        )}
      </div>

      <div className="mx-auto -mt-1 h-px w-full bg-border/60" />

      {/* One row per open document. */}
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {documents.map((d) => {
          const isActive = d.id === activeDocId;
          const isVisible = d.visible !== false;
          return (
            <li
              key={d.id}
              className={[
                "group flex items-center gap-1.5 rounded-md border px-1.5 py-1 transition-smooth",
                isActive
                  ? "border-primary/60 bg-primary/5"
                  : "border-border/50 bg-background/60 hover:border-primary/30",
              ].join(" ")}
            >
              {/* Colour dot — click opens the native picker (also the legend swatch).
                  The dot only OPENS the picker (it never toggles close) so a single
                  click reliably opens it on the first try; closing is handled by the
                  click-away backdrop below so the picker only closes on an explicit
                  outside click. */}
              <div className="relative shrink-0">
                <button
                  type="button"
                  title="Trace colour"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenColorFor(d.id);
                  }}
                  className="block h-4 w-4 rounded-full border border-border/60"
                  style={{ backgroundColor: d.color }}
                />
                {openColorFor === d.id && (
                  <>
                    {/* Click-away backdrop: a click anywhere outside the picker
                        closes it. Fixed + inset-0 so it covers the viewport without
                        affecting layout; sits below the picker (z-10 vs z-20). */}
                    <button
                      type="button"
                      aria-hidden
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenColorFor(null);
                      }}
                      className="fixed inset-0 z-10 cursor-default"
                    />
                    <div
                      className="absolute left-0 top-5 z-20"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="color"
                        value={d.color}
                        onChange={(e) => onPatch(d.id, { color: e.target.value })}
                        onClick={(e) => e.stopPropagation()}
                        className="block h-7 w-9 cursor-pointer rounded border border-border/60 bg-background p-0.5"
                      />
                    </div>
                  </>
                )}
              </div>

              {/* Visibility checkbox. The active document's checkbox is editable
                  too — hiding the active trace drops it from the chromatogram
                  while the spectrum panel still follows it. */}
              <Checkbox
                checked={isVisible}
                onCheckedChange={(v) => onPatch(d.id, { visible: v === true })}
                className="h-3.5 w-3.5"
                title={isVisible ? "Hide this trace" : "Show this trace"}
              />

              {/* Name — click to make active. Bold when active. */}
              <button
                type="button"
                onClick={() => onSwitch(d.id)}
                className={[
                  "min-w-0 flex-1 truncate text-left text-[11px]",
                  isActive ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
                title={d.name}
              >
                {d.name}
              </button>

              {/* Vertical offset — compact number revealed on hover. The active
                  trace's offset is editable too; the plot applies it to the
                  active trace just like any other. */}
              <Input
                type="number"
                value={d.offset ?? 0}
                onChange={(e) => onPatch(d.id, { offset: Number(e.target.value) || 0 })}
                title="Vertical offset"
                className="h-6 w-12 shrink-0 px-1 text-[11px] opacity-0 transition-smooth group-hover:opacity-100 focus:opacity-100"
              />

              {/* Close. */}
              <button
                type="button"
                onClick={() => onClose(d.id)}
                className="shrink-0 text-muted-foreground/60 hover:text-destructive"
                title="Close document"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-primary/5 text-xs font-medium text-primary">
          Drop run files to import
        </div>
      )}

      {/* Document count for screen readers / a tiny hint at the bottom. */}
      <div className="mt-auto flex items-center justify-between px-1 text-[10px] text-muted-foreground">
        <span>
          {documents.length} document{documents.length === 1 ? "" : "s"}
        </span>
        {lockSpectraToCursor && (
          <span className="flex items-center gap-1">
            <Check className="h-2.5 w-2.5" />
            locked to RT
          </span>
        )}
      </div>
    </div>
  );
}