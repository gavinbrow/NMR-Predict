// The TGA "Figure" tab panel: compose what goes into the publication figure
// (which runs, weight % vs mg, show DTG on the right axis, which markers, stack)
// here, then style every detail and export with the shared figure maker.
//
// Stateless by design: all editable state (the include toggles, the x/y mode,
// the marker toggles, the figure options) is owned by the host page so
// switching tabs never discards the user's in-progress figure. Mirrors the
// GcmsFigurePanel / MaldiFigurePanel idiom and the WP0a hoist pattern.

import { Activity, Flame } from "lucide-react";
import { FigureMaker } from "@/components/ir/figure/FigureMaker";
import { Switch } from "@/components/ui/switch";
import type { FigureData, FigureOptions } from "@/lib/ir/figure";
import type { TgaMarkerToggles, TgaXAxis, TgaYAxis } from "@/lib/tga/figure";
import type { TgaRunAnalyzed } from "@/lib/tga/store";

export interface TgaFigureRunInfo {
  id: string;
  label: string;
  color: string;
  visible: boolean;
}

function ToggleLine({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-foreground">
      <Switch checked={checked} onCheckedChange={onChange} className="scale-90" />
      {label}
    </label>
  );
}

export function TgaFigurePanel({
  runs,
  xAxis,
  onXAxisChange,
  yAxis,
  onYAxisChange,
  showTga,
  onShowTgaChange,
  showDtg,
  onShowDtgChange,
  labelMarkers,
  onLabelMarkersChange,
  stackRuns,
  onStackRunsChange,
  markers,
  onMarkersChange,
  figureData,
  figureOptions,
  onFigureOptionsChange,
}: {
  runs: TgaFigureRunInfo[];
  xAxis: TgaXAxis;
  onXAxisChange: (v: TgaXAxis) => void;
  yAxis: TgaYAxis;
  onYAxisChange: (v: TgaYAxis) => void;
  showTga: boolean;
  onShowTgaChange: (v: boolean) => void;
  showDtg: boolean;
  onShowDtgChange: (v: boolean) => void;
  labelMarkers: boolean;
  onLabelMarkersChange: (v: boolean) => void;
  stackRuns: boolean;
  onStackRunsChange: (v: boolean) => void;
  markers: TgaMarkerToggles;
  onMarkersChange: (m: TgaMarkerToggles) => void;
  figureData: FigureData;
  figureOptions: FigureOptions;
  onFigureOptionsChange: (next: FigureOptions) => void;
}) {
  if (runs.length === 0) {
    return (
      <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-card">
        <p className="py-20 text-center text-sm text-muted-foreground">
          Import a run to build a figure.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-card">
        <span className="text-xs font-semibold text-foreground">Include</span>
        <ToggleLine label="TGA (left)" checked={showTga} onChange={onShowTgaChange} />
        <ToggleLine label="DTG (right axis)" checked={showDtg} onChange={onShowDtgChange} />
        <ToggleLine label="Label markers" checked={labelMarkers} onChange={onLabelMarkersChange} />
        <ToggleLine label="Stack runs" checked={stackRuns} onChange={onStackRunsChange} />
        <span className="ml-auto text-[11px] text-muted-foreground">
          <Activity className="mr-1 inline h-3 w-3" />
          {runs.length} run{runs.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-card">
        <span className="text-xs font-semibold text-foreground">Markers</span>
        <ToggleLine
          label="Onset"
          checked={markers.onset}
          onChange={(v) => onMarkersChange({ ...markers, onset: v })}
        />
        <ToggleLine
          label="Endset"
          checked={markers.endset}
          onChange={(v) => onMarkersChange({ ...markers, endset: v })}
        />
        <ToggleLine
          label="Td callouts"
          checked={markers.td}
          onChange={(v) => onMarkersChange({ ...markers, td: v })}
        />
        <ToggleLine
          label="Tmax"
          checked={markers.tmax}
          onChange={(v) => onMarkersChange({ ...markers, tmax: v })}
        />
        <ToggleLine
          label="Residue"
          checked={markers.residue}
          onChange={(v) => onMarkersChange({ ...markers, residue: v })}
        />
      </div>

      <FigureMaker
        data={figureData}
        options={figureOptions}
        onChange={onFigureOptionsChange}
      />
    </div>
  );
}