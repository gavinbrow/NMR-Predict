// The DSC "Figure" tab panel: compose what goes into the publication figure
// (which runs, W/g vs mW, derivative or temperature program on the right
// axis, active segment vs every segment, which transition callouts, stack)
// here, then style every detail and export with the shared figure maker.
// Close copy of `TgaFigurePanel.tsx`.
//
// Stateless by design: every piece of editable state (the include toggles,
// the x/y/y2 modes, the segment mode, the marker toggles, the figure
// options) is owned by the host page (`pages/Dsc.tsx`) so switching tabs
// never discards the user's in-progress figure. `TabsContent` has no
// `forceMount` in this codebase, so panel-local state here would be torn
// down on every tab switch — the exact bug
// `components/maldi/figure/MaldiFigurePanel.tsx`'s doc comment calls out
// (its "WP0a"). Mirrors the GcmsFigurePanel / MaldiFigurePanel /
// TgaFigurePanel idiom.

import { Activity } from "lucide-react";
import { FigureMaker } from "@/components/ir/figure/FigureMaker";
import { Switch } from "@/components/ui/switch";
import type { FigureData, FigureOptions } from "@/lib/ir/figure";
import type { DscMarkerToggles, DscXAxis, DscY2, DscYAxis } from "@/lib/dsc/figure";

/** One run offered to the figure, pre-resolved by the host (label and colour
 *  are the same ones the adapter hands the figure engine). */
export interface DscFigureRunInfo {
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

export function DscFigurePanel({
  runs,
  xAxis,
  onXAxisChange,
  yAxis,
  onYAxisChange,
  showCurve,
  onShowCurveChange,
  y2,
  onY2Change,
  segmentMode,
  onSegmentModeChange,
  labelFeatures,
  onLabelFeaturesChange,
  stackRuns,
  onStackRunsChange,
  markers,
  onMarkersChange,
  figureData,
  figureOptions,
  onFigureOptionsChange,
}: {
  runs: DscFigureRunInfo[];
  xAxis: DscXAxis;
  onXAxisChange: (v: DscXAxis) => void;
  yAxis: DscYAxis;
  onYAxisChange: (v: DscYAxis) => void;
  /** Include the primary heat-flow trace at all. Mirrors TGA's `showTga` —
   *  not part of `BuildDscFigureArgs`; the host applies it by passing an
   *  empty `runs` array to `buildDscFigureData` when this is off. */
  showCurve: boolean;
  onShowCurveChange: (v: boolean) => void;
  y2: DscY2;
  onY2Change: (v: DscY2) => void;
  segmentMode: "active" | "all";
  onSegmentModeChange: (v: "active" | "all") => void;
  labelFeatures: boolean;
  onLabelFeaturesChange: (v: boolean) => void;
  stackRuns: boolean;
  onStackRunsChange: (v: boolean) => void;
  markers: DscMarkerToggles;
  onMarkersChange: (m: DscMarkerToggles) => void;
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
        <ToggleLine label="DSC trace" checked={showCurve} onChange={onShowCurveChange} />
        <ToggleLine
          label="Derivative (right axis)"
          checked={y2 === "derivative"}
          onChange={(v) => onY2Change(v ? "derivative" : "none")}
        />
        <ToggleLine
          label="Temperature program (right axis)"
          checked={y2 === "program"}
          onChange={(v) => onY2Change(v ? "program" : "none")}
        />
        <ToggleLine
          label="All segments"
          checked={segmentMode === "all"}
          onChange={(v) => onSegmentModeChange(v ? "all" : "active")}
        />
        <ToggleLine label="Label transitions" checked={labelFeatures} onChange={onLabelFeaturesChange} />
        <ToggleLine label="Stack runs" checked={stackRuns} onChange={onStackRunsChange} />
        <span className="ml-auto text-[11px] text-muted-foreground">
          <Activity className="mr-1 inline h-3 w-3" />
          {runs.length} run{runs.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-card">
        <span className="text-xs font-semibold text-foreground">Markers</span>
        <ToggleLine
          label="Tg onset"
          checked={markers.glassOnset}
          onChange={(v) => onMarkersChange({ ...markers, glassOnset: v })}
        />
        <ToggleLine
          label="Tg midpoint"
          checked={markers.glassMid}
          onChange={(v) => onMarkersChange({ ...markers, glassMid: v })}
        />
        <ToggleLine
          label="Tg endset"
          checked={markers.glassEndset}
          onChange={(v) => onMarkersChange({ ...markers, glassEndset: v })}
        />
        <ToggleLine
          label="Peak T"
          checked={markers.peakTemp}
          onChange={(v) => onMarkersChange({ ...markers, peakTemp: v })}
        />
        <ToggleLine
          label="Peak onset"
          checked={markers.peakOnset}
          onChange={(v) => onMarkersChange({ ...markers, peakOnset: v })}
        />
        <ToggleLine
          label="Peak endset"
          checked={markers.peakEndset}
          onChange={(v) => onMarkersChange({ ...markers, peakEndset: v })}
        />
        <ToggleLine
          label="Baselines"
          checked={markers.baselines}
          onChange={(v) => onMarkersChange({ ...markers, baselines: v })}
        />
        <ToggleLine
          label="Tangents"
          checked={markers.tangents}
          onChange={(v) => onMarkersChange({ ...markers, tangents: v })}
        />
        <ToggleLine
          label="ΔH labels"
          checked={markers.enthalpyLabels}
          onChange={(v) => onMarkersChange({ ...markers, enthalpyLabels: v })}
        />
      </div>

      <FigureMaker data={figureData} options={figureOptions} onChange={onFigureOptionsChange} />
    </div>
  );
}
