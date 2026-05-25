import { Eye, EyeOff, FlaskRound, Layers, Rows3 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ViewMode = "overlay" | "stacked";

export interface CompoundEntry {
  id: string;
  label: string;
  smiles: string;
  engines: string[];
  visible: boolean;
  active: boolean;
  linked: boolean;
  floating: boolean;
  intensityScale: number;
}

interface CompoundsPanelProps {
  compounds: CompoundEntry[];
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onToggleVisible: (id: string) => void;
  onActivate: (id: string) => void;
  onToggleFloating: (id: string) => void;
  onIntensityChange: (id: string, scale: number) => void;
}

function truncate(text: string, limit = 28) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}...`;
}

export function CompoundsPanel({
  compounds,
  viewMode,
  onViewModeChange,
  onToggleVisible,
  onActivate,
  onToggleFloating,
  onIntensityChange,
}: CompoundsPanelProps) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
          <FlaskRound className="h-4 w-4 text-primary" /> Compounds
        </h3>
        <span className="text-xs text-muted-foreground">
          {compounds.length} compound{compounds.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg border border-border/60 bg-muted/30 p-1">
        <button
          type="button"
          onClick={() => onViewModeChange("overlay")}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-smooth",
            viewMode === "overlay"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Layers className="h-3.5 w-3.5" /> Overlay
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange("stacked")}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-smooth",
            viewMode === "stacked"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Rows3 className="h-3.5 w-3.5" /> Stacked
        </button>
      </div>

      {compounds.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Run a prediction to populate the compounds list.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {compounds.map((compound) => (
            <li
              key={compound.id}
              className={cn(
                "rounded-lg border px-3 py-2 transition-smooth",
                compound.active
                  ? "border-primary/50 bg-primary/5"
                  : "border-border/70 bg-background hover:border-primary/30",
              )}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => onToggleVisible(compound.id)}
                  className={cn(
                    "mt-0.5 rounded p-1 transition-smooth",
                    compound.visible
                      ? "text-primary hover:bg-primary/10"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                  aria-label={compound.visible ? "Hide spectrum" : "Show spectrum"}
                  title={compound.visible ? "Hide spectrum" : "Show spectrum"}
                >
                  {compound.visible ? (
                    <Eye className="h-4 w-4" />
                  ) : (
                    <EyeOff className="h-4 w-4" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => onActivate(compound.id)}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-foreground">
                      {compound.label}
                    </span>
                    {compound.linked ? (
                      <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success">
                        Linked
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                    {truncate(compound.smiles)}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {compound.engines.map((engine) => (
                      <span
                        key={engine}
                        className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                      >
                        {engine}
                      </span>
                    ))}
                  </div>
                </button>
              </div>

              <div className="mt-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    className="text-[10px] font-medium text-muted-foreground"
                    htmlFor={`intensity-${compound.id}`}
                  >
                    Intensity
                  </label>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {compound.intensityScale.toFixed(2)}x
                  </span>
                </div>
                <input
                  id={`intensity-${compound.id}`}
                  type="range"
                  min={0.1}
                  max={3}
                  step={0.05}
                  value={compound.intensityScale}
                  onChange={(event) =>
                    onIntensityChange(compound.id, Number.parseFloat(event.target.value))
                  }
                  className="h-1 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                />
              </div>

              <button
                type="button"
                onClick={() => onToggleFloating(compound.id)}
                className={cn(
                  "mt-2 w-full rounded-md border px-2 py-1 text-[11px] font-medium transition-smooth",
                  compound.floating
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-border/70 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground",
                )}
              >
                {compound.floating ? "Hide floating structure" : "Show floating structure"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
