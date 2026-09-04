// The DSC on-screen plot's controls: what the x/y/y2 axes show, whether every
// segment or just the active one is drawn, and which transition kinds are
// overlaid.
//
// Stateless — every value is owned by `Dsc.tsx`, never held locally, because
// `TabsContent` has no `forceMount` here and panel-local state is destroyed
// on every tab switch (the bug `components/maldi/figure/MaldiFigurePanel.tsx`
// and `pages/Dsc.tsx`'s own doc comment call out). A close relative of
// `components/tga/MarkersPanel.tsx` — same `Segmented`/`Toggle` building
// blocks — extended with a segment-mode control and a per-`DscFeatureKind`
// toggle row instead of TGA's fixed five.

import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import type {
  DscMarkerToggles,
  DscPlotSegmentMode,
  DscPlotXAxis,
  DscPlotY2Mode,
  DscPlotYAxis,
} from "@/lib/dsc/plot";
import type { DscFeatureKind } from "@/lib/dsc/types";

function Toggle({
  label,
  checked,
  onChange,
  disabled,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label
      className={`flex items-center gap-2 text-xs ${disabled ? "text-muted-foreground/60" : "text-foreground"}`}
      title={title}
    >
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} className="scale-90" />
      {label}
    </label>
  );
}

/** A segmented control — smaller and quicker to hit than a `Select` for a
 *  short, closed set of axis modes. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  title,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border/60" title={title}>
      {options.map((o) => (
        <Button
          key={o.value}
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`h-7 rounded-none px-2.5 text-xs ${
            value === o.value ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground"
          }`}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/** Order + short labels for the per-kind toggle row. `"custom"` is
 *  deliberately absent — a user-placed feature has no kind-level toggle and
 *  is always drawn (see `buildDscPlotMarkers`'s doc comment). */
const FEATURE_KIND_TOGGLES: { kind: Exclude<DscFeatureKind, "custom">; label: string }[] = [
  { kind: "glass", label: "Tg" },
  { kind: "melt", label: "Melt" },
  { kind: "crystallization", label: "Cryst." },
  { kind: "coldCrystallization", label: "Cold cryst." },
  { kind: "cure", label: "Cure" },
  { kind: "oit", label: "OIT" },
];

export interface MarkersPanelProps {
  xAxis: DscPlotXAxis;
  onXAxisChange: (v: DscPlotXAxis) => void;
  yAxis: DscPlotYAxis;
  onYAxisChange: (v: DscPlotYAxis) => void;
  y2Mode: DscPlotY2Mode;
  onY2ModeChange: (v: DscPlotY2Mode) => void;
  segmentMode: DscPlotSegmentMode;
  onSegmentModeChange: (v: DscPlotSegmentMode) => void;
  showMarkerLabels: boolean;
  onShowMarkerLabelsChange: (v: boolean) => void;
  markers: DscMarkerToggles;
  onMarkersChange: (m: DscMarkerToggles) => void;
  /** Maps every drawn trace onto its own 0..1 span (`buildDscPlotTraces`'s
   *  matching flag). Page-level state, shared verbatim with the Figure
   *  tab's own "Normalize" toggle — see `Dsc.tsx`. */
  normalizeTraces: boolean;
  onNormalizeTracesChange: (v: boolean) => void;
}

export function MarkersPanel({
  xAxis,
  onXAxisChange,
  yAxis,
  onYAxisChange,
  y2Mode,
  onY2ModeChange,
  segmentMode,
  onSegmentModeChange,
  showMarkerLabels,
  onShowMarkerLabelsChange,
  markers,
  onMarkersChange,
  normalizeTraces,
  onNormalizeTracesChange,
}: MarkersPanelProps) {
  // Every feature kind except OIT lives on the temperature axis; OIT lives on
  // the time axis. Disable (not silently ignore) whichever set the current
  // x-axis mode withholds, mirroring `buildDscPlotMarkers`'s own rule.
  const temperatureWithheld = xAxis !== "temperature";
  const timeWithheld = xAxis !== "time";

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">X</span>
        <Segmented<DscPlotXAxis>
          value={xAxis}
          onChange={onXAxisChange}
          options={[
            { value: "temperature", label: "Temperature" },
            { value: "time", label: "Time" },
          ]}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">Y</span>
        <Segmented<DscPlotYAxis>
          value={yAxis}
          onChange={onYAxisChange}
          disabled={normalizeTraces}
          title={normalizeTraces ? "W/g vs mW is meaningless once every trace is normalized to 0..1" : undefined}
          options={[
            { value: "wattsPerGram", label: "W/g" },
            { value: "milliwatts", label: "mW" },
          ]}
        />
      </div>
      <Toggle
        label="Normalize"
        checked={normalizeTraces}
        onChange={onNormalizeTracesChange}
        title="Map every trace onto its own 0..1 range, to compare shapes across runs of different amplitude"
      />
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">Segments</span>
        <Segmented<DscPlotSegmentMode>
          value={segmentMode}
          onChange={onSegmentModeChange}
          options={[
            { value: "active", label: "Active" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      <Toggle
        label={xAxis === "temperature" ? "dHF/dT (right axis)" : "Temp. program (right axis)"}
        checked={y2Mode !== "off"}
        onChange={(v) => onY2ModeChange(v ? "derivative" : "off")}
      />
      <span className="h-4 w-px bg-border/60" />
      {FEATURE_KIND_TOGGLES.map(({ kind, label }) => {
        const disabled = kind === "oit" ? timeWithheld : temperatureWithheld;
        return (
          <Toggle
            key={kind}
            label={label}
            checked={markers[kind]}
            onChange={(v) => onMarkersChange({ ...markers, [kind]: v })}
            disabled={disabled}
            title={
              disabled
                ? kind === "oit"
                  ? "OIT is a time value — switch X to Time"
                  : `${label} is plotted against temperature — switch X to Temperature`
                : undefined
            }
          />
        );
      })}
      <span className="h-4 w-px bg-border/60" />
      <Toggle
        label="Baselines"
        checked={markers.baselines}
        onChange={(v) => onMarkersChange({ ...markers, baselines: v })}
      />
      <Toggle
        label="Tangents"
        checked={markers.tangents}
        onChange={(v) => onMarkersChange({ ...markers, tangents: v })}
      />
      <Toggle
        label="ΔH"
        checked={markers.enthalpyLabels}
        onChange={(v) => onMarkersChange({ ...markers, enthalpyLabels: v })}
      />
      <Toggle
        label="Marker lines"
        checked={markers.verticals}
        onChange={(v) => onMarkersChange({ ...markers, verticals: v })}
        title="Turn off to keep every Tg/Tm/… label without the vertical lines"
      />
      <Toggle label="Labels" checked={showMarkerLabels} onChange={onShowMarkerLabelsChange} />
    </div>
  );
}
