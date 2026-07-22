import { Loader2, Play, X } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { PEAK_PRESETS, type PeakPickParams, type PeakPreset } from "@/lib/maldi/peaks";

interface PeakPickingPanelProps {
  params: PeakPickParams;
  onChange: (params: PeakPickParams) => void;
  onRun: () => void;
  onClear: () => void;
  busy?: boolean;
  peakCount: number;
  disabled?: boolean;
}

const PRESET_LABELS: Record<PeakPreset, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  sensitive: "Sensitive",
  lowResLinear: "Low-res linear",
  highResReflectron: "High-res reflectron",
  isotopeResolved: "Isotope-resolved",
};

/**
 * Select value for the preset dropdown. Every manual control (except the
 * monoisotopic toggle) sets `params.preset` to `undefined`, so a custom param
 * set must show an explicit "Custom" entry rather than misreporting "Balanced".
 */
const PRESET_SELECT_VALUE = "__custom__";

export function PeakPickingPanel({
  params,
  onChange,
  onRun,
  onClear,
  busy,
  peakCount,
  disabled,
}: PeakPickingPanelProps) {
  const set = (patch: Partial<PeakPickParams>) => onChange({ ...params, ...patch });
  const applyPreset = (preset: PeakPreset) => onChange({ ...PEAK_PRESETS[preset] });
  // A defined preset id shows as itself; once any control is hand-edited the
  // preset is cleared (undefined) and the dropdown reports "Custom". "Custom"
  // is a real, selectable entry: selecting it clears `params.preset` while
  // keeping the current values, so a user on a named preset can explicitly
  // switch to custom mode without hand-editing a field first. Selecting
  // "Custom" when already custom is a harmless no-op (preset stays undefined).
  const selectPreset = (v: string) => {
    if (v === PRESET_SELECT_VALUE) {
      if (params.preset !== undefined) set({ preset: undefined });
    } else {
      applyPreset(v as PeakPreset);
    }
  };
  const presetValue = params.preset ?? PRESET_SELECT_VALUE;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1.5">
        <Label className="text-[11px] text-muted-foreground">Preset</Label>
        <Select value={presetValue} onValueChange={selectPreset}>
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PRESET_SELECT_VALUE}>Custom</SelectItem>
            {(Object.keys(PRESET_LABELS) as PeakPreset[]).map((preset) => (
              <SelectItem key={preset} value={preset}>
                {PRESET_LABELS[preset]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Min S/N">
          <Input
            type="number"
            step={0.5}
            className="h-7 text-xs"
            value={params.minSnr}
            onChange={(e) => set({ minSnr: Number(e.target.value), preset: undefined })}
          />
        </Field>
        <Field label="Noise window (pts)">
          <Input
            type="number"
            className="h-7 text-xs"
            value={params.noiseWindow}
            onChange={(e) => set({ noiseWindow: Number(e.target.value), preset: undefined })}
          />
        </Field>
        <Field label="Min intensity (rel)">
          <Input
            type="number"
            step={0.001}
            className="h-7 text-xs"
            value={params.minRelIntensity}
            onChange={(e) => set({ minRelIntensity: Number(e.target.value), preset: undefined })}
          />
        </Field>
        <Field label="Local-max radius">
          <Input
            type="number"
            className="h-7 text-xs"
            value={params.localMaxRadius}
            onChange={(e) => set({ localMaxRadius: Number(e.target.value), preset: undefined })}
          />
        </Field>
        <Field label="Min width (m/z)">
          <Input
            type="number"
            step={0.05}
            className="h-7 text-xs"
            value={params.minWidth}
            onChange={(e) => set({ minWidth: Number(e.target.value), preset: undefined })}
          />
        </Field>
        <Field label="Max width (m/z)">
          <Input
            type="number"
            step={0.1}
            className="h-7 text-xs"
            value={params.maxWidth}
            onChange={(e) => set({ maxWidth: Number(e.target.value), preset: undefined })}
          />
        </Field>
        <Field label="Min prominence (S/N)">
          <Input
            type="number"
            step={0.5}
            className="h-7 text-xs"
            value={params.minProminence ?? params.minSnr}
            onChange={(e) => set({ minProminence: Number(e.target.value), preset: undefined })}
          />
        </Field>
        <Field label="Min separation (0=auto)">
          <Input
            type="number"
            step={0.05}
            className="h-7 text-xs"
            value={params.minSeparation ?? 0}
            onChange={(e) => set({ minSeparation: Number(e.target.value), preset: undefined })}
          />
        </Field>
        <Field label="Smoothing (pts)">
          <Input
            type="number"
            className="h-7 text-xs"
            value={params.smoothing ?? 0}
            onChange={(e) => set({ smoothing: Number(e.target.value), preset: undefined })}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background/60 p-2.5">
        <Toggle label="Centroid refinement" checked={params.centroid} onChange={(v) => set({ centroid: v, preset: undefined })} />
        <Toggle label="Isotope-aware (flag satellites)" checked={params.isotopeAware} onChange={(v) => set({ isotopeAware: v, preset: undefined })} />
        <Toggle label="Detect shoulders" checked={params.detectShoulders} onChange={(v) => set({ detectShoulders: v, preset: undefined })} />
      </div>

      <div className="flex flex-col gap-1 rounded-lg border border-primary/30 bg-primary/5 p-2.5">
        <Toggle
          label="Monoisotopic peaks only"
          checked={params.monoisotopicOnly ?? true}
          onChange={(v) => set({ monoisotopicOnly: v })}
        />
        <p className="text-[10px] leading-snug text-muted-foreground">
          Within each isotope cluster, keep only the left-most (monoisotopic) peak — the one without
          ¹³C / deuterium — and drop the satellites. Use before fitting repeat units and end groups.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" className="flex-1" onClick={onRun} disabled={busy || disabled}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
          Pick peaks
        </Button>
        {peakCount > 0 && (
          <Button size="sm" variant="outline" onClick={onClear}>
            <X className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>
      {peakCount > 0 && (
        <p className="text-[11px] text-muted-foreground">{peakCount} peaks picked.</p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
