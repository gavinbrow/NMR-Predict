import * as SliderPrimitive from "@radix-ui/react-slider";
import { RotateCcw, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_PARAMS } from "@/lib/tensile/compute";
import { useTensileStore } from "@/lib/tensile/store";
import type { AnalysisParams, BreakDefinition, StrainUnitOverride } from "@/lib/tensile/types";

// Standard-method presets that snap the modulus window + offset to common values.
const PRESETS: Record<string, Pick<AnalysisParams, "eLo" | "eHi" | "offsetPct">> = {
  "ISO 527": { eLo: 0.05, eHi: 0.25, offsetPct: 0.2 },
  "ASTM D638": { eLo: 0.1, eHi: 0.3, offsetPct: 0.2 },
};

function detectPreset(p: AnalysisParams): string {
  for (const [name, v] of Object.entries(PRESETS)) {
    if (p.eLo === v.eLo && p.eHi === v.eHi && p.offsetPct === v.offsetPct) return name;
  }
  return "Custom";
}

/**
 * Live analysis-parameter controls (Phase 6). The modulus window is a dual-handle
 * slider over % strain; the offset, peak-drop, break definition and strain-unit
 * override are exposed too, with standard-method presets. Slider drags update a
 * local value instantly (so the thumb is smooth) and commit to the store on the
 * next animation frame — the store's memoized recompute then re-runs the engine
 * across every specimen, so the table, stats and chart all update live.
 */
export function ParamControls() {
  const { params, setParams } = useTensileStore();

  // Local mirror so dragging stays perfectly smooth; committed to the store via
  // rAF coalescing (collapses a burst of pointermoves into one recompute/frame).
  const [local, setLocal] = useState(params);
  const raf = useRef<number | null>(null);
  const pending = useRef<Partial<AnalysisParams>>({});

  // Keep the local mirror in sync when the store changes from elsewhere
  // (presets, reset, a different file changing nothing here — but safe).
  useEffect(() => {
    setLocal(params);
  }, [params]);

  const commit = useCallback(
    (patch: Partial<AnalysisParams>) => {
      pending.current = { ...pending.current, ...patch };
      if (raf.current == null) {
        raf.current = requestAnimationFrame(() => {
          raf.current = null;
          const merged = pending.current;
          pending.current = {};
          setParams(merged);
        });
      }
    },
    [setParams],
  );

  useEffect(() => () => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
  }, []);

  // A continuous control: update local immediately, commit (coalesced) to store.
  const onLive = (patch: Partial<AnalysisParams>) => {
    setLocal((prev) => ({ ...prev, ...patch }));
    commit(patch);
  };

  const applyPreset = (name: string) => {
    if (name === "Custom") return;
    const p = PRESETS[name];
    setLocal((prev) => ({ ...prev, ...p }));
    setParams(p);
  };

  const reset = () => {
    setLocal(DEFAULT_PARAMS);
    setParams(DEFAULT_PARAMS);
  };

  const preset = detectPreset(local);
  const breakMode = local.breakDefinition.mode;

  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-border/70 bg-card p-4 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <SlidersHorizontal className="h-4 w-4 text-primary" />
          Analysis parameters
        </h3>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={reset}>
          <RotateCcw className="h-3 w-3" />
          Reset
        </Button>
      </div>

      {/* Preset */}
      <div className="grid gap-1.5">
        <Label className="text-xs text-muted-foreground">Preset</Label>
        <Select value={preset} onValueChange={applyPreset}>
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ISO 527">ISO 527</SelectItem>
            <SelectItem value="ASTM D638">ASTM D638</SelectItem>
            <SelectItem value="Custom" disabled>
              Custom
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Modulus window */}
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Modulus window (% strain)</Label>
          <span className="text-xs font-medium tabular-nums text-foreground">
            {local.eLo.toFixed(2)}–{local.eHi.toFixed(2)}%
          </span>
        </div>
        <SliderPrimitive.Root
          className="relative flex w-full touch-none select-none items-center py-1"
          min={0}
          max={2}
          step={0.01}
          minStepsBetweenThumbs={1}
          value={[local.eLo, local.eHi]}
          onValueChange={([lo, hi]) => onLive({ eLo: lo, eHi: hi })}
        >
          <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary">
            <SliderPrimitive.Range className="absolute h-full bg-primary" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
          <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
        </SliderPrimitive.Root>
      </div>

      {/* Offset yield */}
      <NumberRow
        label="0.2% offset (% strain)"
        value={local.offsetPct}
        min={0}
        max={2}
        step={0.05}
        onChange={(v) => onLive({ offsetPct: v })}
      />

      {/* Peak-drop fraction */}
      <NumberRow
        label="Peak-drop fraction (× UTS)"
        value={local.peakDropFrac}
        min={0}
        max={0.5}
        step={0.01}
        onChange={(v) => onLive({ peakDropFrac: v })}
      />

      {/* Break definition */}
      <div className="grid gap-1.5">
        <Label className="text-xs text-muted-foreground">Break definition</Label>
        <Select
          value={breakMode}
          onValueChange={(mode) => {
            const next: BreakDefinition =
              mode === "last"
                ? { mode: "last" }
                : mode === "dropFromPeak"
                  ? { mode: "dropFromPeak", dropFrac: 0.5 }
                  : { mode: "forceThreshold", threshold: 1 };
            onLive({ breakDefinition: next });
          }}
        >
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="last">Last data point</SelectItem>
            <SelectItem value="dropFromPeak">% drop from peak</SelectItem>
            <SelectItem value="forceThreshold">Stress threshold</SelectItem>
          </SelectContent>
        </Select>
        {breakMode === "dropFromPeak" && (
          <NumberRow
            label="Drops to (× UTS)"
            value={(local.breakDefinition as Extract<BreakDefinition, { mode: "dropFromPeak" }>).dropFrac}
            min={0.05}
            max={0.95}
            step={0.05}
            onChange={(v) => onLive({ breakDefinition: { mode: "dropFromPeak", dropFrac: v } })}
          />
        )}
        {breakMode === "forceThreshold" && (
          <NumberRow
            label="Stress threshold (MPa)"
            value={(local.breakDefinition as Extract<BreakDefinition, { mode: "forceThreshold" }>).threshold}
            min={0}
            max={100}
            step={0.5}
            onChange={(v) => onLive({ breakDefinition: { mode: "forceThreshold", threshold: v } })}
          />
        )}
      </div>

      {/* Strain-unit override */}
      <div className="grid gap-1.5">
        <Label className="text-xs text-muted-foreground">Strain unit</Label>
        <Select
          value={local.strainUnitOverride}
          onValueChange={(v) => onLive({ strainUnitOverride: v as StrainUnitOverride })}
        >
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto-detect</SelectItem>
            <SelectItem value="%">Force %</SelectItem>
            <SelectItem value="mm/mm">Force mm/mm</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/** A labelled number input + range slider pair that commit live. */
function NumberRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <Input
          type="number"
          value={Number.isFinite(value) ? value : ""}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = Number.parseFloat(e.target.value);
            if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
          }}
          className="h-7 w-20 text-right text-xs tabular-nums"
        />
      </div>
      <SliderPrimitive.Root
        className="relative flex w-full touch-none select-none items-center py-1"
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(Number.parseFloat(v.toFixed(4)))}
      >
        <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary">
          <SliderPrimitive.Range className="absolute h-full bg-primary" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
      </SliderPrimitive.Root>
    </div>
  );
}
