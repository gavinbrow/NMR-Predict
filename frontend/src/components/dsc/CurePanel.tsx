// Left-rail "Cure / OIT" section for the selected run: the cure exotherm ΔH
// (from `run.analysis.cure`, the largest-|ΔH| "cure" feature on the active
// segment), degree of cure against a user-entered theoretical total, and —
// when the active segment is isothermal — the oxidative induction time,
// computed directly from the segment view (§3.8's `oxidativeInductionTime`)
// rather than requiring a stored "oit" feature.
//
// Stateless: the theoretical total ΔH is a genuinely persistent value (it
// should survive a tab switch, same as every other view-state field), so it
// is NOT local state here — `totalJPerG`/`onTotalChange` are a hoisted-state
// contract for `Dsc.tsx` to fulfil, the same pattern as `selectedFeatureId`.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { degreeOfCure, oxidativeInductionTime } from "@/lib/dsc/compute";
import type { DscRunAnalyzed } from "@/lib/dsc/store";

function fmt(v: number | null | undefined, decimals = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(decimals);
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span>{label}</span>
      <span className="text-foreground">
        {value} <span className="text-muted-foreground">{unit}</span>
      </span>
    </div>
  );
}

export function CurePanel({
  run,
  totalJPerG,
  onTotalChange,
}: {
  run: DscRunAnalyzed | null;
  /** User-entered theoretical total cure enthalpy (J/g), for degree-of-cure
   *  (`1 - residual/total`). `null` until the user enters one. */
  totalJPerG: number | null;
  onTotalChange: (value: number | null) => void;
}) {
  if (!run) {
    return <p className="text-xs text-muted-foreground">Select a run to see cure / OIT results.</p>;
  }

  const segment = run.segments.find((s) => s.id === run.analysis.segmentId);
  const isIsothermal = segment?.kind === "isothermal";
  const cure = run.analysis.cure;
  const residual = cure?.enthalpyJPerG != null ? Math.abs(cure.enthalpyJPerG) : null;
  const degree =
    totalJPerG != null && residual != null ? degreeOfCure(totalJPerG, residual) : null;

  const oit =
    isIsothermal && run.analysis.view.rawTimeMin.length > 0
      ? oxidativeInductionTime(run.analysis.view, run.analysis.view.rawTimeMin[0])
      : null;

  return (
    <div className="flex flex-col gap-3 text-[11px]">
      <div className="rounded-lg border border-border/50 bg-background/40 p-3">
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Cure exotherm
        </div>
        <Stat label="ΔH" value={fmt(cure?.enthalpyJPerG)} unit="J/g" />
        <Stat label="Peak" value={fmt(cure?.peakC)} unit="°C" />
        <Stat label="Onset" value={fmt(cure?.onsetC)} unit="°C" />
      </div>

      <div className="rounded-lg border border-border/50 bg-background/40 p-3">
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Degree of cure
        </div>
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Total ΔH (J/g)</Label>
          <Input
            type="number"
            value={totalJPerG ?? ""}
            placeholder="theoretical total"
            min={0}
            step={0.1}
            onChange={(e) => onTotalChange(e.target.value === "" ? null : Number(e.target.value))}
            className="h-7 text-xs"
          />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-muted-foreground">α (1 − residual/total)</span>
          <span className="font-semibold text-foreground">
            {degree == null ? "—" : `${(degree * 100).toFixed(1)} %`}
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-border/50 bg-background/40 p-3">
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Oxidative induction time
        </div>
        {!isIsothermal ? (
          <p className="text-muted-foreground">
            The active segment isn't isothermal — OIT applies only to a hold.
          </p>
        ) : (
          <>
            <Stat label="Onset" value={fmt(oit?.onsetMin)} unit="min" />
            <Stat label="OIT" value={fmt(oit?.oitMin)} unit="min" />
          </>
        )}
      </div>
    </div>
  );
}
