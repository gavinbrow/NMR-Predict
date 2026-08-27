// The on-screen plot's controls: what the x and y axes show, whether the DTG
// curve is drawn on the right-hand axis, and which analysis markers are overlaid.
//
// Stateless — every value is owned by the page, so the Analysis tab's view
// survives a trip to the Figure tab and back. The same `TgaMarkerToggles` shape
// drives the figure adapter, so the screen and the publication figure can be
// kept in step (or deliberately differ) without a second vocabulary.

import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import type { TgaMarkerToggles, TgaXAxis, TgaYAxis } from "@/lib/tga/figure";

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
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="scale-90"
      />
      {label}
    </label>
  );
}

/** A two-option segmented control — smaller and quicker to hit than a Select
 *  for a binary axis mode. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border/60">
      {options.map((o) => (
        <Button
          key={o.value}
          type="button"
          variant="ghost"
          size="sm"
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

export function MarkersPanel({
  xAxis,
  onXAxisChange,
  yAxis,
  onYAxisChange,
  showDtg,
  onShowDtgChange,
  showMarkerLabels,
  onShowMarkerLabelsChange,
  markers,
  onMarkersChange,
}: {
  xAxis: TgaXAxis;
  onXAxisChange: (v: TgaXAxis) => void;
  yAxis: TgaYAxis;
  onYAxisChange: (v: TgaYAxis) => void;
  showDtg: boolean;
  onShowDtgChange: (v: boolean) => void;
  showMarkerLabels: boolean;
  onShowMarkerLabelsChange: (v: boolean) => void;
  markers: TgaMarkerToggles;
  onMarkersChange: (m: TgaMarkerToggles) => void;
}) {
  // Onset/endset/Tmax/Td are temperatures; drawn against time they would sit at
  // meaningless x positions, so they're disabled (not silently ignored) there.
  const temperatureOnly = xAxis !== "temperature";
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">X</span>
        <Segmented<TgaXAxis>
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
        <Segmented<TgaYAxis>
          value={yAxis}
          onChange={onYAxisChange}
          options={[
            { value: "weightPct", label: "Weight %" },
            { value: "weightMg", label: "Weight mg" },
          ]}
        />
      </div>
      <Toggle label="DTG (right axis)" checked={showDtg} onChange={onShowDtgChange} />
      <span className="h-4 w-px bg-border/60" />
      <Toggle
        label="Onset"
        checked={markers.onset}
        onChange={(v) => onMarkersChange({ ...markers, onset: v })}
        disabled={temperatureOnly}
        title={temperatureOnly ? "Onset is a temperature — switch X to Temperature" : undefined}
      />
      <Toggle
        label="Endset"
        checked={markers.endset}
        onChange={(v) => onMarkersChange({ ...markers, endset: v })}
        disabled={temperatureOnly}
        title={temperatureOnly ? "Endset is a temperature — switch X to Temperature" : undefined}
      />
      <Toggle
        label="Td"
        checked={markers.td}
        onChange={(v) => onMarkersChange({ ...markers, td: v })}
        disabled={temperatureOnly}
        title={temperatureOnly ? "Td is a temperature — switch X to Temperature" : undefined}
      />
      <Toggle
        label="Tmax"
        checked={markers.tmax}
        onChange={(v) => onMarkersChange({ ...markers, tmax: v })}
        disabled={temperatureOnly}
        title={temperatureOnly ? "Tmax is a temperature — switch X to Temperature" : undefined}
      />
      <Toggle
        label="Residue"
        checked={markers.residue}
        onChange={(v) => onMarkersChange({ ...markers, residue: v })}
      />
      <Toggle label="Labels" checked={showMarkerLabels} onChange={onShowMarkerLabelsChange} />
    </div>
  );
}
