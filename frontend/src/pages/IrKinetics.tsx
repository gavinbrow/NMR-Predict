import { AlertTriangle, FileUp, HardDrive, Loader2, Trash2, Waves } from "lucide-react";
import { useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Kinetics } from "@/components/ir/Kinetics";
import { ViewExport } from "@/components/ir/ViewExport";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { naturalCompare } from "@/lib/ir/numerics";
import { loadSpectra } from "@/lib/ir/spectrum";
import type { Spectrum } from "@/lib/ir/types";

type Mode = "View & Export" | "Kinetics";

/**
 * IR Kinetics workspace — a browser-only reader for Shimadzu IRAffinity-1S
 * `.ispd` files. A persistent sidebar handles file loading and the mode switch;
 * the main panel shows an empty-state blurb until spectra are loaded, then the
 * selected mode. Nothing is uploaded; all parsing and math runs locally.
 *
 * Both modes are live: View & Export (Phase 5) and Kinetics (Phases 7–9).
 */
const IrKinetics = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [spectra, setSpectra] = useState<Spectrum[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<Mode>("View & Export");

  // Additive: new files open alongside the loaded ones. A re-upload of the same
  // filename replaces that spectrum; "Clear all" resets the workspace.
  const handleFiles = async (files: File[] | FileList | null) => {
    if (!files || files.length === 0) return;
    setLoading(true);
    try {
      const { spectra: loaded, errors: errs } = await loadSpectra(files);
      setSpectra((prev) => {
        const byName = new Map(prev.map((s) => [s.name, s]));
        for (const s of loaded) byName.set(s.name, s);
        return [...byName.values()].sort((a, b) => naturalCompare(a.name, b.name));
      });
      setErrors(errs);
    } finally {
      setLoading(false);
    }
  };

  const clearAll = () => {
    setSpectra([]);
    setErrors([]);
  };

  // Drop accepts the same files the browse dialog would: `.ispd` only. (The
  // input's `accept` attribute filters the picker but not a drop, so we filter
  // here too.) The drag state just toggles the dashed-border highlight.
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped = Array.from(e.dataTransfer.files).filter((f) =>
      f.name.toLowerCase().endsWith(".ispd"),
    );
    void handleFiles(dropped);
  };

  const count = spectra.length;
  const hasSpectra = count > 0;

  return (
    <AppShell
      headerAccessory={
        <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 font-medium text-success">
          <HardDrive className="h-3 w-3" />
          Local IR workspace
        </span>
      }
      mainClassName="container py-6"
    >
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Sidebar — always visible */}
        <aside className="lg:w-72 lg:shrink-0">
          <div className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-card p-5 shadow-card">
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-foreground">IR</h1>
              <p className="text-xs text-muted-foreground">
                Shimadzu IRAffinity-1S .ispd reader
              </p>
            </div>

            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                if (!dragging) setDragging(true);
              }}
              onDragLeave={(e) => {
                // Ignore leaves that bubble up from child elements.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
              }}
              onDrop={handleDrop}
              className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-6 text-center transition-smooth ${
                dragging
                  ? "border-primary bg-primary/5"
                  : "border-border/70 bg-background/40 hover:border-primary/40"
              }`}
            >
              {loading ? (
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10">
                  <FileUp className="h-5 w-5 text-primary" />
                </div>
              )}
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {hasSpectra ? "Add files" : "Load .ispd files"}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Shimadzu .ispd, multiple. Drag &amp; drop or click to browse.
                </p>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept=".ispd"
                multiple
                className="hidden"
                onChange={(e) => {
                  // Copy the list, then reset so picking the same file(s)
                  // again re-fires `change`.
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  void handleFiles(files);
                }}
              />
            </button>

            {hasSpectra && (
              <>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-foreground">
                    {count} {count === 1 ? "spectrum" : "spectra"} loaded
                  </p>
                  <button
                    type="button"
                    onClick={clearAll}
                    className="inline-flex items-center gap-1 rounded-lg border border-border/70 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-smooth hover:border-destructive/40 hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear all
                  </button>
                </div>
                <div className="grid gap-2">
                  <Label className="text-xs text-muted-foreground">Mode</Label>
                  <RadioGroup value={mode} onValueChange={(v) => setMode(v as Mode)}>
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="View & Export" id="mode-view" />
                      View &amp; Export
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="Kinetics" id="mode-kinetics" />
                      Kinetics
                    </label>
                  </RadioGroup>
                </div>
              </>
            )}

            {errors.length > 0 && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-[11px]">
                <p className="flex items-center gap-1.5 font-medium text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {errors.length} file{errors.length === 1 ? "" : "s"} could not be read
                </p>
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
                  {errors.map((e) => (
                    <li key={e} className="break-words">
                      {e}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              Files are read locally in your browser — never uploaded, never modified.
            </p>
          </div>
        </aside>

        {/* Main panel */}
        <div className="min-w-0 flex-1">
          {!hasSpectra ? (
            <EmptyState />
          ) : mode === "View & Export" ? (
            <ViewExport spectra={spectra} />
          ) : (
            <Kinetics spectra={spectra} />
          )}
        </div>
      </div>
    </AppShell>
  );
};

/** Centered intro shown before any files are loaded. */
function EmptyState() {
  return (
    <section className="mx-auto max-w-3xl rounded-[2rem] border border-border/70 bg-card px-6 py-16 text-center shadow-card sm:px-10">
      <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-primary shadow-elegant">
        <Waves className="h-7 w-7 text-primary-foreground" />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">IR</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Load one or more Shimadzu .ispd files from the sidebar to begin.
      </p>

      <div className="mt-8 grid gap-4 text-left sm:grid-cols-2">
        <div className="rounded-2xl border border-border/60 bg-background/60 p-5">
          <h2 className="text-sm font-semibold text-foreground">View &amp; Export</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Overlay any number of spectra, switch between %T and absorbance, apply a baseline
            correction, and export the aligned data to CSV or Excel.
          </p>
        </div>
        <div className="rounded-2xl border border-border/60 bg-background/60 p-5">
          <h2 className="text-sm font-semibold text-foreground">Kinetics</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Load a time series, track a disappearing IR peak, and fit a first-order rate constant,
            half-life, and conversion — with a 0/1/2 reaction-order comparison.
          </p>
        </div>
      </div>
    </section>
  );
}

export default IrKinetics;
