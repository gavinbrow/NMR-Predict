import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { ChromTrace } from "@/lib/gcms/types";

/**
 * The "Traces" panel: the list of TIC / BPC / XIC traces currently drawn on the
 * chromatogram, plus an XIC builder form below it. Per row:
 *  - colour swatch (popover picker) — doubles as the legend swatch;
 *  - visibility checkbox;
 *  - the trace label;
 *  - a compact offset number input;
 *  - a compact gain (intensity scale) number input — double-click resets it
 *    to 1x; the same value Shift+wheel on the chromatogram adjusts for
 *    whichever trace is active;
 *  - a delete × — TIC rows are NOT deletable, so the × is hidden there.
 *
 * Rows are grouped by run with the run name as a small muted heading. The XIC
 * builder takes a comma-separated m/z list, a tolerance (default `suggestedTol`
 * from the page), a Sum/Max segmented control, and an `Add XIC` button that is
 * disabled while busy or when the m/z list does not parse. Invalid entries are
 * reported inline as `text-xs text-destructive`, never silently dropped.
 */
interface TracesPanelProps {
  traces: ChromTrace[];
  runNames: Record<string, string>;
  activeTraceId: string | null;
  /** Suggested XIC tolerance: 0.3 Da on a coarse m/z grid, 0.01 Da otherwise. */
  suggestedTol: number;
  busy?: boolean;
  onSelect(id: string): void;
  onPatch(id: string, patch: Partial<Pick<ChromTrace, "color" | "visible" | "offset" | "scale">>): void;
  onDelete(id: string): void;
  onAddXic(mzList: number[], tol: number, mode: "sum" | "max"): void;
  /** The active document's currently-selected blank doc id (or null = None).
   *  Pre-resolved by the host from its `backgroundBlankByDoc` map so this
   *  component doesn't need to know the active doc id. */
  activeDocBlank: string | null;
  /** Documents available to pick as the blank (excludes the active doc). */
  blankCandidates: { id: string; name: string }[];
  onPickBlank(blankDocId: string | null): void;
}

export function TracesPanel({
  traces,
  runNames,
  activeTraceId,
  suggestedTol,
  busy = false,
  onSelect,
  onPatch,
  onDelete,
  onAddXic,
  activeDocBlank,
  blankCandidates,
  onPickBlank,
}: TracesPanelProps) {
  const [openColorFor, setOpenColorFor] = useState<string | null>(null);
  const [mzText, setMzText] = useState("");
  const [tol, setTol] = useState<string>(String(suggestedTol));
  const [mode, setMode] = useState<"sum" | "max">("sum");
  const [error, setError] = useState<string | null>(null);

  // Keep the tolerance input in sync with the page's suggestion when it
  // changes (e.g. when the active run switches to one on a finer m/z grid).
  // We re-seed only on a prop change so the user's manual edits aren't clobbered.
  useEffect(() => {
    setTol(String(suggestedTol));
  }, [suggestedTol]);

  // Group traces by runId, preserving first-seen order.
  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, ChromTrace[]>();
    for (const t of traces) {
      if (!map.has(t.runId)) {
        map.set(t.runId, []);
        order.push(t.runId);
      }
      map.get(t.runId)!.push(t);
    }
    return order.map((runId) => ({ runId, items: map.get(runId)! }));
  }, [traces]);

  // Parse the m/z list. Returns null when the text is empty or invalid; the
  // `Add XIC` button is disabled while the parse fails.
  const parsedMz = useMemo(() => parseMzList(mzText), [mzText]);
  const tolNum = Number(tol);
  const tolValid = Number.isFinite(tolNum) && tolNum > 0;

  const handleAdd = () => {
    if (!parsedMz || !tolValid) return;
    onAddXic(parsedMz, tolNum, mode);
    setMzText("");
    setError(null);
  };

  // Validate on blur: surface an inline error if the text is non-empty but
  // does not parse. We don't block typing — only report.
  const validate = () => {
    if (mzText.trim() === "") {
      setError(null);
      return;
    }
    if (!parsedMz) {
      setError("Enter comma-separated m/z values, e.g. 162.3, 201.1");
    } else {
      setError(null);
    }
  };

  return (
    <div className="flex h-full flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-2">
      {/* Trace list, grouped by run. */}
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {groups.map(({ runId, items }) => (
          <li key={runId} className="flex flex-col gap-1">
            <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {runNames[runId] ?? runId}
            </div>
            <ul className="flex flex-col gap-1">
              {items.map((t) => (
                <TraceRow
                  key={t.id}
                  trace={t}
                  active={t.id === activeTraceId}
                  openColor={openColorFor === t.id}
                  onOpenColor={(v) => setOpenColorFor(v ? t.id : null)}
                  onSelect={() => onSelect(t.id)}
                  onPatch={(patch) => onPatch(t.id, patch)}
                  onDelete={() => onDelete(t.id)}
                  onFit={() => {
                    // Scale this trace so its apex roughly matches the tallest
                    // OTHER currently-visible trace's apex (both measured on
                    // raw, unscaled data — "target" already includes each
                    // other trace's own gain since that's what's actually
                    // drawn on screen).
                    const target = traces
                      .filter((o) => o.id !== t.id && o.visible)
                      .reduce((m, o) => Math.max(m, rawMax(o) * (o.scale || 1)), 0);
                    const mine = rawMax(t);
                    if (mine > 0 && target > 0) {
                      onPatch(t.id, { scale: Math.min(1000, Math.max(0.01, target / mine)) });
                    }
                  }}
                />
              ))}
            </ul>
          </li>
        ))}
        {traces.length === 0 && (
          <li className="px-1 py-2 text-[11px] text-muted-foreground">No traces yet.</li>
        )}
      </ul>

      <div className="mx-auto h-px w-full bg-border/60" />

      {/* XIC builder. */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          XIC builder
        </div>
        <Input
          className="h-7 text-xs"
          placeholder="m/z list, e.g. 162.3, 201.1"
          inputMode="decimal"
          value={mzText}
          onChange={(e) => setMzText(e.target.value)}
          onBlur={validate}
        />
        <div className="flex items-center gap-1.5">
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>±</span>
            <Input
              type="number"
              step="any"
              min="0"
              className="h-7 w-16 px-1 text-xs"
              value={tol}
              onChange={(e) => setTol(e.target.value)}
              title="Tolerance (Da)"
            />
            <span>Da</span>
          </label>
          {/* Sum / Max segmented control: two buttons with a variant swap. */}
          <div className="flex overflow-hidden rounded-md border border-border/60">
            <Button
              type="button"
              size="sm"
              variant={mode === "sum" ? "default" : "ghost"}
              className="h-7 rounded-none px-2 text-[11px]"
              onClick={() => setMode("sum")}
            >
              Sum
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "max" ? "default" : "ghost"}
              className="h-7 rounded-none px-2 text-[11px]"
              onClick={() => setMode("max")}
            >
              Max
            </Button>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-7 ml-auto px-2 text-[11px]"
            onClick={handleAdd}
            disabled={busy || !parsedMz || !tolValid}
            title={!parsedMz ? "Enter a valid m/z list first" : !tolValid ? "Enter a valid tolerance" : undefined}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add XIC
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!error && mzText.trim() !== "" && !parsedMz && (
          <p className="text-xs text-destructive">Enter comma-separated m/z values, e.g. 162.3, 201.1</p>
        )}
      </div>

      {/* Background (blank-sample) subtraction picker. The active doc's
          current blank (if any) is preselected; choosing "None" clears it.
          Hidden when there are no other loaded documents. */}
      {blankCandidates.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Background
          </div>
          <div className="flex items-center gap-1.5">
            <select
              className="h-7 flex-1 rounded border border-border/60 bg-background px-1.5 text-[11px]"
              value={activeDocBlank ?? ""}
              onChange={(e) => onPickBlank(e.target.value === "" ? null : e.target.value)}
              title="Subtract a blank run's chromatogram from the active trace"
            >
              <option value="">None</option>
              {blankCandidates.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

/** Raw (unscaled) peak intensity of a trace — used by "Fit" to size one
 *  trace's gain relative to another's actual data, not its current gain. */
function rawMax(t: ChromTrace): number {
  let m = 0;
  for (let i = 0; i < t.intensity.length; i += 1) {
    const v = t.intensity[i];
    if (v > m) m = v;
  }
  return m;
}

function TraceRow({
  trace,
  active,
  openColor,
  onOpenColor,
  onSelect,
  onPatch,
  onDelete,
  onFit,
}: {
  trace: ChromTrace;
  active: boolean;
  openColor: boolean;
  onOpenColor(open: boolean): void;
  onSelect(): void;
  onPatch(patch: Partial<Pick<ChromTrace, "color" | "visible" | "offset" | "scale">>): void;
  onDelete(): void;
  onFit(): void;
}) {
  // TIC (and BPC) traces are not user-deletable — they're the run's baseline
  // chromatograms. Only XIC / UV / FID rows get a delete ×.
  const deletable = trace.kind !== "TIC" && trace.kind !== "BPC";
  return (
    <li
      className={[
        "group flex items-center gap-1.5 rounded-md border px-1.5 py-1 transition-smooth",
        active
          ? "border-primary/60 bg-primary/5"
          : "border-border/50 bg-background/60 hover:border-primary/30",
      ].join(" ")}
    >
      {/* Colour swatch — click opens the native picker. */}
      <div className="relative shrink-0">
        <button
          type="button"
          title="Trace colour"
          onClick={(e) => {
            e.stopPropagation();
            onOpenColor(true);
          }}
          className="block h-4 w-4 rounded-full border border-border/60"
          style={{ backgroundColor: trace.color }}
        />
        {openColor && (
          <>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onOpenColor(false);
              }}
              className="fixed inset-0 z-10 cursor-default"
            />
            <div className="absolute left-0 top-5 z-20" onClick={(e) => e.stopPropagation()}>
              <input
                type="color"
                value={trace.color}
                onChange={(e) => onPatch({ color: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                className="block h-7 w-9 cursor-pointer rounded border border-border/60 bg-background p-0.5"
              />
            </div>
          </>
        )}
      </div>

      {/* Visibility checkbox. */}
      <Checkbox
        checked={trace.visible}
        onCheckedChange={(v) => onPatch({ visible: v === true })}
        className="h-3.5 w-3.5"
        title={trace.visible ? "Hide this trace" : "Show this trace"}
      />

      {/* Label — click to make this the active trace. */}
      <button
        type="button"
        onClick={onSelect}
        className={[
          "min-w-0 flex-1 truncate text-left text-[11px]",
          active ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
        ].join(" ")}
        title={trace.label}
      >
        {trace.label}
      </button>

      {/* Compact offset number, revealed on hover. */}
      <Input
        type="number"
        value={trace.offset ?? 0}
        onChange={(e) => onPatch({ offset: Number(e.target.value) || 0 })}
        title="Vertical offset"
        className="h-6 w-12 shrink-0 px-1 text-[11px] opacity-0 transition-smooth group-hover:opacity-100 focus:opacity-100"
      />

      {/* Gain (intensity scale) control — ALWAYS visible (not hover-only) so a
          low-abundance XIC's gain is discoverable next to a big TIC (bug 10).
          A zero/blank entry falls back to 1 (unscaled) rather than zeroing the
          trace out — the visibility checkbox already covers "make this trace
          disappear". Double-click the number resets to 1x, the same shortcut
          Shift+wheel on the chromatogram itself uses. "Fit" sets an absolute
          gain so this trace's apex matches the tallest other visible trace's
          apex — the Y-axis frame this results in is preserved (not refit) by
          the bug-8 fix in GcmsPlot, so the result actually stays visible. */}
      <div className="flex shrink-0 items-center gap-1">
        <input
          type="range"
          min={0.05}
          max={20}
          step={0.05}
          value={Math.min(20, Math.max(0.05, trace.scale || 1))}
          onChange={(e) => onPatch({ scale: Number(e.target.value) || 1 })}
          title="Intensity gain"
          className="h-1 w-12 accent-primary"
        />
        <Input
          type="number"
          step="any"
          value={trace.scale ?? 1}
          onChange={(e) => onPatch({ scale: Number(e.target.value) || 1 })}
          onDoubleClick={() => onPatch({ scale: 1 })}
          title="Intensity gain (double-click to reset to 1x)"
          className="h-6 w-11 shrink-0 px-1 text-[11px]"
        />
        <button
          type="button"
          onClick={onFit}
          title="Scale this trace's intensity to match the tallest other visible trace"
          className="shrink-0 rounded border border-border/60 px-1 text-[10px] leading-5 text-muted-foreground hover:border-primary/50 hover:text-foreground"
        >
          Fit
        </button>
      </div>

      {/* Delete × — hidden for TIC/BPC rows. */}
      {deletable && (
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 text-muted-foreground/60 hover:text-destructive"
          title="Remove trace"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}

/** Parse a comma-separated m/z list into a number[], or null when invalid. */
function parseMzList(text: string): number[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parts = trimmed.split(/[\s,]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0) return null;
    out.push(n);
  }
  return out;
}