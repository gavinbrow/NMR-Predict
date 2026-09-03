// One run's row in the Files/Runs left-rail section: colour swatch, editable
// name, editable sample mass (seeded from the parsed metadata, writes a
// per-run override rather than mutating the file's own metadata), segment
// count, visibility toggle, scale/offset numeric fields, and remove. Mirrors
// `components/tga/RunCard.tsx`, swapping TGA's method-step count for DSC's
// segment count and adding the mass field `DscRun.massOverrideMg` exists for
// (§WP1.1 / the plan's §WP2 RunCard bullet).

import { Eye, EyeOff, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { DscRunAnalyzed } from "@/lib/dsc/store";

export function RunCard({
  run,
  onSetColor,
  onRename,
  onSetMass,
  onToggleVisible,
  onSetScale,
  onSetOffset,
  onRemove,
}: {
  run: DscRunAnalyzed;
  onSetColor: (color: string) => void;
  onRename: (label: string) => void;
  /** Writes `massOverrideMg`; `null` reverts display to the parsed
   *  `meta.sampleMassMg`. */
  onSetMass: (massMg: number | null) => void;
  onToggleVisible: () => void;
  onSetScale: (scale: number) => void;
  onSetOffset: (offset: number) => void;
  onRemove: () => void;
}) {
  const effectiveMass = run.massOverrideMg ?? run.meta.sampleMassMg;
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-3">
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={run.color}
          onChange={(e) => onSetColor(e.target.value)}
          title="Series colour"
          className="h-5 w-5 shrink-0 cursor-pointer rounded border border-border/60 bg-transparent p-0"
        />
        <Input
          value={run.label}
          onChange={(e) => onRename(e.target.value)}
          className="h-7 min-w-0 flex-1 text-xs"
          title={run.label}
        />
        <button
          type="button"
          onClick={onToggleVisible}
          title={run.visible ? "Hide run" : "Show run"}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          {run.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="Remove run"
          className="shrink-0 text-muted-foreground/60 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <div className="grid gap-0.5">
          <span className="text-[10px] text-muted-foreground">Mass (mg)</span>
          <Input
            type="number"
            value={effectiveMass ?? ""}
            step={0.01}
            min={0}
            placeholder="—"
            onChange={(e) => {
              const raw = e.target.value;
              onSetMass(raw === "" ? null : Number(raw));
            }}
            className="h-7 text-xs"
          />
        </div>
        <div className="grid gap-0.5">
          <span className="text-[10px] text-muted-foreground">Scale</span>
          <Input
            type="number"
            value={run.scale}
            step={0.1}
            min={0}
            onChange={(e) => onSetScale(Number(e.target.value))}
            className="h-7 text-xs"
          />
        </div>
        <div className="grid gap-0.5">
          <span className="text-[10px] text-muted-foreground">Offset</span>
          <Input
            type="number"
            value={run.offset}
            step={1}
            onChange={(e) => onSetOffset(Number(e.target.value))}
            className="h-7 text-xs"
          />
        </div>
      </div>
      <div className="mt-2 text-[10px] text-muted-foreground">
        {run.meta.instrument || "Unknown instrument"}
        {` · ${run.segments.length} segment${run.segments.length === 1 ? "" : "s"}`}
      </div>
    </div>
  );
}
