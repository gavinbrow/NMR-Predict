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
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { FigureData, FigureOptions } from "@/lib/ir/figure";
import type { DscMarkerToggles, DscXAxis, DscY2, DscYAxis } from "@/lib/dsc/figure";

/** One run offered to the figure, pre-resolved by the host (label and colour
 *  are the same ones the adapter hands the figure engine). `scale`/`offset`
 *  mirror `RunCard`'s own fields — the per-run gain strip below is the
 *  Figure tab's only way to reach `onSetScale`/`onSetOffset`, which
 *  previously existed only in the Files/Runs rail (unreachable from here,
 *  where the user is actually composing the figure). */
export interface DscFigureRunInfo {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  scale: number;
  offset: number;
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
  stackSpacing,
  onStackSpacingChange,
  normalizeTraces,
  onNormalizeTracesChange,
  markers,
  onMarkersChange,
  offsetStep = 0.01,
  onSetRunScale,
  onSetRunOffset,
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
  /** Fixed rung spacing (`BuildDscFigureArgs.stackSpacing`) — `null` (or the
   *  field left blank) keeps the automatic per-run-height ladder. */
  stackSpacing: number | null;
  onStackSpacingChange: (v: number | null) => void;
  /** Maps every drawn trace onto its own 0..1 span (`BuildDscFigureArgs.
   *  normalizeTraces`) — the SAME page-level flag the on-screen plot's
   *  Markers strip toggles, per `Dsc.tsx`'s shared-state design. */
  normalizeTraces: boolean;
  onNormalizeTracesChange: (v: boolean) => void;
  markers: DscMarkerToggles;
  onMarkersChange: (m: DscMarkerToggles) => void;
  /** Spinner increment for each run's Y-offset field below — see
   *  `RunCard`'s matching prop for why this isn't hardcoded. */
  offsetStep?: number;
  onSetRunScale: (runId: string, scale: number) => void;
  onSetRunOffset: (runId: string, offset: number) => void;
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
        <ToggleLine
          label="Normalize"
          checked={normalizeTraces}
          onChange={onNormalizeTracesChange}
        />
        <ToggleLine label="Stack runs" checked={stackRuns} onChange={onStackRunsChange} />
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            value={stackSpacing ?? ""}
            step={normalizeTraces ? 0.1 : 1}
            min={0}
            placeholder="auto"
            disabled={!stackRuns}
            title="Fixed spacing between stacked runs, in the current display y units — blank keeps the automatic per-run-height spacing"
            onChange={(e) => {
              const raw = e.target.value;
              onStackSpacingChange(raw === "" ? null : Number(raw));
            }}
            className="h-7 w-20 text-xs"
          />
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground">
          <Activity className="mr-1 inline h-3 w-3" />
          {runs.length} run{runs.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex flex-col gap-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-card">
        <span className="text-xs font-semibold text-foreground">Run offsets</span>
        <div className="flex flex-col gap-1.5">
          {runs.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <span
                className="h-3 w-3 shrink-0 rounded-full border border-border/60"
                style={{ backgroundColor: r.color }}
              />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={r.label}>
                {r.label}
              </span>
              <span className="text-[10px] text-muted-foreground">Scale</span>
              <Input
                type="number"
                value={r.scale}
                step={0.1}
                min={0}
                onChange={(e) => onSetRunScale(r.id, Number(e.target.value))}
                className="h-7 w-20 text-xs"
              />
              <span className="text-[10px] text-muted-foreground">Offset</span>
              <Input
                type="number"
                value={r.offset}
                step={offsetStep}
                onChange={(e) => onSetRunOffset(r.id, Number(e.target.value))}
                className="h-7 w-20 text-xs"
              />
            </div>
          ))}
        </div>
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
        <ToggleLine
          label="Marker lines"
          checked={markers.verticals}
          onChange={(v) => onMarkersChange({ ...markers, verticals: v })}
        />
      </div>

      <FigureMaker data={figureData} options={figureOptions} onChange={onFigureOptionsChange} />
    </div>
  );
}
