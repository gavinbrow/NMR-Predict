import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { Engine, OptionsResponse } from "@/types/nmr";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ControlPanelProps {
  options: OptionsResponse;
  engines: Engine[];
  nucleus: string;
  conformerStrategy: string;
  selectedEngines: string[];
  onNucleusChange: (v: string) => void;
  onConformerChange: (v: string) => void;
  onToggleEngine: (name: string) => void;
}

const labelClass = "text-xs font-medium uppercase tracking-wider text-muted-foreground";
const selectClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-card transition-smooth focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring";

function conformerStrategyLabel(strategy: string) {
  return strategy === "fast" ? "RDKit force-field preopt" : strategy;
}

export function ControlPanel({
  options,
  engines,
  nucleus,
  conformerStrategy,
  selectedEngines,
  onNucleusChange,
  onConformerChange,
  onToggleEngine,
}: ControlPanelProps) {
  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className={labelClass}>Nucleus</label>
            <select className={selectClass} value={nucleus} onChange={(e) => onNucleusChange(e.target.value)}>
              {options.nuclei.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className={labelClass}>Geometry prep</label>
            <select className={selectClass} value={conformerStrategy} onChange={(e) => onConformerChange(e.target.value)}>
              {options.conformer_strategies.map((s) => (
                <option key={s} value={s}>{conformerStrategyLabel(s)}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-3">
          <label className={labelClass}>Engines</label>

          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {engines.map((engine) => {
              const disabled = !engine.ready;
              const checked = selectedEngines.includes(engine.name);
              return (
                <li
                  key={engine.name}
                  className={cn(
                    "group relative flex items-center justify-between gap-3 rounded-lg border bg-card p-3 shadow-card transition-smooth",
                    checked && !disabled && "border-primary/60 ring-1 ring-primary/30",
                    disabled && "opacity-60",
                  )}
                >
                  <label className={cn("flex flex-1 items-center gap-3", !disabled && "cursor-pointer")}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input text-primary focus:ring-ring disabled:cursor-not-allowed"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => onToggleEngine(engine.name)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-foreground">{engine.label ?? engine.name}</span>
                        {engine.ready ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-label="Ready" />
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <AlertCircle className="h-3.5 w-3.5 text-warning" />
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              {engine.reason ?? "Engine not available"}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      {engine.reason && !engine.ready ? (
                        <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{engine.reason}</p>
                      ) : null}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </TooltipProvider>
  );
}
