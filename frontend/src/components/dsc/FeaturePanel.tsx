// Left-rail "Transitions" editor for the selected run's active segment: one
// card per feature with a kind select, an editable label, window lo/hi
// inputs, baseline anchor inputs, an "Auto" badge that clears the moment the
// user edits anything (the store's `UPDATE_FEATURE` reducer sets `auto:
// false` on every patch — this component just renders the flag, it never
// clears it itself), a show/hide toggle and a delete button, plus "Add
// transition" and "Re-detect all" actions. Results render read-only beside
// each row, read straight from `run.analysis.results`.
//
// Stateless like every other DSC panel — the selected feature id is hoisted
// in `Dsc.tsx` (`selectedFeatureId`/`setSelectedFeatureId`) because the plot
// uses it for Shift/Alt-drag window setting, so a click here only reports the
// selection via `onSelectFeature` rather than tracking it locally.

import { Eye, EyeOff, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DscFeatureResult } from "@/lib/dsc/compute";
import type { DscRunAnalyzed } from "@/lib/dsc/store";
import type { DscFeature, DscFeatureKind } from "@/lib/dsc/types";

const KIND_OPTIONS: { value: DscFeatureKind; label: string }[] = [
  { value: "glass", label: "Glass transition" },
  { value: "melt", label: "Melt" },
  { value: "crystallization", label: "Crystallization" },
  { value: "coldCrystallization", label: "Cold crystallization" },
  { value: "cure", label: "Cure" },
  { value: "oit", label: "OIT" },
  { value: "custom", label: "Custom" },
];

function fmt(v: number | null | undefined, decimals = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(decimals);
}

/** A short read-only readout of a feature's computed result, kind-aware. */
function ResultLine({ result }: { result: DscFeatureResult | undefined }) {
  if (!result) return <span className="text-muted-foreground">not analyzed</span>;
  if (result.kind === "glass") {
    const g = result.glass;
    return (
      <span>
        Tg {fmt(g.midpointC)} °C · onset {fmt(g.onsetC)} · endset {fmt(g.endsetC)} · Δcp{" "}
        {fmt(g.deltaCp, 3)} J/(g·°C)
      </span>
    );
  }
  if (result.kind === "oit") {
    const o = result.oit;
    return (
      <span>
        onset {fmt(o.onsetMin)} min · OIT {fmt(o.oitMin)} min
      </span>
    );
  }
  const p = result.peak;
  return (
    <span>
      {fmt(p.peakC)} °C · ΔH {fmt(p.enthalpyJPerG)} J/g · FWHM {fmt(p.fwhmC)} °C
    </span>
  );
}

function windowUnit(feature: DscFeature, isIsothermalSegment: boolean): string {
  return feature.kind === "oit" || isIsothermalSegment ? "min" : "°C";
}

/** Build a fresh feature centred on the middle third of the view's own
 *  temperature range, so a hand-added transition starts somewhere sane
 *  rather than at (0, 0). Falls back to a fixed span when the view is empty
 *  (e.g. the run has no computed analysis yet). */
function draftFeature(run: DscRunAnalyzed, segmentId: string, ordinal: number): DscFeature {
  const tempC = run.analysis.view.tempC;
  let lo = 50;
  let hi = 100;
  if (tempC.length > 4) {
    const n = tempC.length;
    const a = tempC[Math.floor(n * 0.4)];
    const b = tempC[Math.floor(n * 0.6)];
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      lo = a;
      hi = b;
    }
  }
  return {
    id: crypto.randomUUID(),
    segmentId,
    kind: "custom",
    label: `Feature ${ordinal}`,
    window: [lo, hi],
    baseline: null,
    baselineMode: "linear",
    auto: false,
    visible: true,
    manualMidpointC: null, // "Add transition" always starts from the auto-fit / blank
  };
}

export function FeaturePanel({
  run,
  segmentId,
  selectedFeatureId,
  onSelectFeature,
  onAddFeature,
  onUpdateFeature,
  onRemoveFeature,
  onResetFeatures,
}: {
  run: DscRunAnalyzed | null;
  /** The segment to edit features for; falls back to the run's resolved
   *  active segment (`run.analysis.segmentId`) when omitted. */
  segmentId?: string | null;
  selectedFeatureId: string | null;
  onSelectFeature: (featureId: string | null) => void;
  onAddFeature: (feature: DscFeature) => void;
  onUpdateFeature: (featureId: string, patch: Partial<Omit<DscFeature, "id">>) => void;
  onRemoveFeature: (featureId: string) => void;
  onResetFeatures: () => void;
}) {
  if (!run) {
    return <p className="text-xs text-muted-foreground">Select a run to edit its transitions.</p>;
  }

  const segId = segmentId ?? run.analysis.segmentId;
  const segment = run.segments.find((s) => s.id === segId);
  const isIso = segment?.kind === "isothermal";
  const features = run.features.filter((f) => f.segmentId === segId);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          onClick={() => {
            const feature = draftFeature(run, segId, features.length + 1);
            onAddFeature(feature);
            onSelectFeature(feature.id);
          }}
        >
          <Plus className="h-3 w-3" />
          Add transition
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 text-xs text-muted-foreground"
          onClick={onResetFeatures}
          title="Drop every transition (user-placed or auto) and re-detect from scratch"
        >
          <RotateCcw className="h-3 w-3" />
          Re-detect all
        </Button>
      </div>

      {features.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No transitions on this segment yet — add one, or turn on auto-detect in Analysis
          parameters.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {features.map((feature) => {
          const unit = windowUnit(feature, isIso);
          const result = run.analysis.results[feature.id];
          const selected = feature.id === selectedFeatureId;
          const baseline = feature.baseline;
          return (
            <div
              key={feature.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectFeature(feature.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelectFeature(feature.id);
              }}
              className={`rounded-lg border bg-background/40 p-3 text-left ${
                selected ? "border-primary/60 ring-1 ring-primary/30" : "border-border/50"
              }`}
            >
              <div className="flex items-center gap-2">
                <Select
                  value={feature.kind}
                  onValueChange={(v) => onUpdateFeature(feature.id, { kind: v as DscFeatureKind })}
                >
                  <SelectTrigger
                    className="h-7 w-[150px] shrink-0 text-xs"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KIND_OPTIONS.map((k) => (
                      <SelectItem key={k.value} value={k.value} className="text-xs">
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={feature.label}
                  onChange={(e) => onUpdateFeature(feature.id, { label: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  className="h-7 min-w-0 flex-1 text-xs"
                />
                {feature.auto && (
                  <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">
                    Auto
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdateFeature(feature.id, { visible: !feature.visible });
                  }}
                  title={feature.visible ? "Hide" : "Show"}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  {feature.visible ? (
                    <Eye className="h-3.5 w-3.5" />
                  ) : (
                    <EyeOff className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveFeature(feature.id);
                  }}
                  title="Delete"
                  className="shrink-0 text-muted-foreground/60 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="grid gap-0.5">
                  <span className="text-[10px] text-muted-foreground">Window lo ({unit})</span>
                  <Input
                    type="number"
                    value={feature.window[0]}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      onUpdateFeature(feature.id, {
                        window: [Number(e.target.value), feature.window[1]],
                      })
                    }
                    className="h-7 text-xs"
                  />
                </div>
                <div className="grid gap-0.5">
                  <span className="text-[10px] text-muted-foreground">Window hi ({unit})</span>
                  <Input
                    type="number"
                    value={feature.window[1]}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      onUpdateFeature(feature.id, {
                        window: [feature.window[0], Number(e.target.value)],
                      })
                    }
                    className="h-7 text-xs"
                  />
                </div>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="grid gap-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    Baseline anchor 1 ({unit})
                  </span>
                  <Input
                    type="number"
                    value={baseline ? baseline[0] : feature.window[0]}
                    placeholder="window lo"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      onUpdateFeature(feature.id, {
                        baseline: [Number(e.target.value), baseline ? baseline[1] : feature.window[1]],
                      })
                    }
                    className="h-7 text-xs"
                  />
                </div>
                <div className="grid gap-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    Baseline anchor 2 ({unit})
                  </span>
                  <Input
                    type="number"
                    value={baseline ? baseline[1] : feature.window[1]}
                    placeholder="window hi"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      onUpdateFeature(feature.id, {
                        baseline: [baseline ? baseline[0] : feature.window[0], Number(e.target.value)],
                      })
                    }
                    className="h-7 text-xs"
                  />
                </div>
              </div>
              {baseline && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdateFeature(feature.id, { baseline: null });
                  }}
                  className="mt-1 text-[10px] text-muted-foreground underline decoration-dotted hover:text-foreground"
                >
                  Reset anchors to window ends
                </button>
              )}

              {feature.kind === "glass" && (
                <div className="mt-2 grid gap-0.5">
                  <span className="text-[10px] text-muted-foreground">Tg (°C)</span>
                  <Input
                    type="number"
                    step={0.1}
                    value={feature.manualMidpointC ?? ""}
                    // The fitted midpoint, so the empty state visibly reads
                    // "use the fit" rather than a bare blank — when there is
                    // no override yet, `result.glass.midpointC` IS the pure
                    // fit (the override only diverges from it once one
                    // exists, at which point the input shows that value
                    // instead and the placeholder is moot).
                    placeholder={result?.kind === "glass" ? fmt(result.glass.midpointC) : "—"}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const raw = e.target.value;
                      // Clearing the box reverts to the fit (§ "manually set
                      // the Tg if needed") — `UPDATE_FEATURE` still clears
                      // `auto` on this patch even though the value goes back
                      // to `null`, same as clearing any other field would.
                      onUpdateFeature(feature.id, {
                        manualMidpointC: raw === "" ? null : Number(raw),
                      });
                    }}
                    className="h-7 text-xs"
                  />
                </div>
              )}

              <div className="mt-2 text-[11px] text-muted-foreground">
                <ResultLine result={result} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
