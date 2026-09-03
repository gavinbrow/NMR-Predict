// Analysis-parameter controls for the DSC left rail: smoothing window,
// minimum peak enthalpy, exotherm display direction, the "↑ Exo" axis-label
// arrow, heat-flow normalization, and auto-detect on/off. Mirrors
// `components/tga/ParamControls.tsx` — every control writes straight into
// the store's `setParams` via `onPatch`, and this component holds no state
// of its own.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { DscParams } from "@/lib/dsc/types";

export function ParamControls({
  params,
  onPatch,
}: {
  params: DscParams;
  onPatch: (p: Partial<DscParams>) => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Smoothing window</Label>
          <Input
            type="number"
            value={params.smoothWindow}
            min={5}
            step={2}
            onChange={(e) => onPatch({ smoothWindow: Math.max(5, Number(e.target.value)) })}
            className="h-8"
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Min peak ΔH (J/g)</Label>
          <Input
            type="number"
            value={params.minPeakEnthalpy}
            min={0}
            step={0.1}
            onChange={(e) => onPatch({ minPeakEnthalpy: Math.max(0, Number(e.target.value)) })}
            className="h-8"
          />
        </div>
      </div>

      <div className="grid gap-1">
        <Label className="text-[11px] text-muted-foreground">Normalization</Label>
        <Select
          value={params.normMode}
          onValueChange={(v) => onPatch({ normMode: v as DscParams["normMode"] })}
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="wattsPerGram">W/g (normalized)</SelectItem>
            <SelectItem value="raw">Raw (mW)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1">
        <Label className="text-[11px] text-muted-foreground">Exotherm direction</Label>
        <div className="inline-flex overflow-hidden rounded-md border border-border/60">
          {([true, false] as const).map((up) => (
            <button
              key={String(up)}
              type="button"
              onClick={() => onPatch({ exoUp: up })}
              className={`h-8 flex-1 text-xs font-medium transition-smooth ${
                params.exoUp === up
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {up ? "↑ Exo up" : "↓ Exo down"}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center justify-between gap-2 text-xs text-foreground">
        Show "↑ Exo" arrow on axis label
        <Switch
          checked={params.showExoArrow}
          onCheckedChange={(v) => onPatch({ showExoArrow: v })}
        />
      </label>

      <label className="flex items-center justify-between gap-2 text-xs text-foreground">
        Auto-detect transitions
        <Switch checked={params.autoDetect} onCheckedChange={(v) => onPatch({ autoDetect: v })} />
      </label>
    </div>
  );
}
