import { Scale } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { summarizeMolWeight, type MolWeightSource } from "@/lib/maldi/molweight";
import type { Adduct, Peak, Series } from "@/lib/maldi/types";

interface MolWeightPanelProps {
  peaks: Peak[];
  series: Series[];
  adducts: Adduct[];
  repeatMass: number;
  /** Selected peak ids (from the table / repeat-unit preview), used by the "selected" source. */
  selectedPeakIds?: Set<string>;
}

const NONE = "__none__";

/**
 * MALDI-apparent molecular-weight statistics. Every value is explicitly labelled
 * apparent — MALDI ion intensities are not quantitative — and recomputes live as
 * the source subset, adduct basis, or end group changes.
 */
export function MolWeightPanel({
  peaks,
  series,
  adducts,
  repeatMass,
  selectedPeakIds,
}: MolWeightPanelProps) {
  const [source, setSource] = useState<MolWeightSource>("all");
  const [adductId, setAdductId] = useState<string>(NONE);
  const [endGroup, setEndGroup] = useState("");
  const [threshold, setThreshold] = useState("5");

  const adduct = adducts.find((a) => a.id === adductId);

  const stats = useMemo(
    () =>
      summarizeMolWeight(peaks, series, source, {
        adduct,
        repeatMass: repeatMass > 0 ? repeatMass : undefined,
        endGroupMass: endGroup ? Number(endGroup) : 0,
        intensityThreshold: (Number(threshold) || 0) / 100,
        selectedPeakIds,
      }),
    [peaks, series, source, adduct, repeatMass, endGroup, threshold, selectedPeakIds],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <Scale className="h-4 w-4 text-primary" /> MALDI-apparent molecular weight
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Peak source</Label>
          <Select value={source} onValueChange={(v) => setSource(v as MolWeightSource)}>
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All analyte peaks</SelectItem>
              <SelectItem value="series">Assigned-series peaks</SelectItem>
              <SelectItem value="selected">Selected peaks</SelectItem>
              <SelectItem value="threshold">Above intensity threshold</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Mass basis</Label>
          <Select value={adductId} onValueChange={setAdductId}>
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Observed m/z</SelectItem>
              {adducts.map((a) => (
                <SelectItem key={a.id} value={a.id}>Neutral via {a.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {source === "threshold" && (
        <div className="grid w-32 gap-1">
          <Label className="text-[11px] text-muted-foreground">Threshold (% base)</Label>
          <Input className="h-8" type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Repeat (Da)</Label>
          <Input className="h-8" value={repeatMass ? repeatMass.toFixed(4) : ""} readOnly placeholder="set in Series" />
        </div>
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">End group (Da)</Label>
          <Input className="h-8" type="number" value={endGroup} onChange={(e) => setEndGroup(e.target.value)} placeholder="for DPn/DPw" />
        </div>
      </div>

      {stats.count === 0 ? (
        <p className="rounded-lg border border-dashed border-border/60 p-3 text-center text-[11px] text-muted-foreground">
          No peaks in this selection. Pick peaks (and assign a series) first.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Mn" value={stats.mn} />
            <Metric label="Mw" value={stats.mw} />
            <Metric label="Mz" value={stats.mz} />
            <Metric label="Đ" value={stats.dispersity} digits={3} />
            <Metric label="Peak max" value={stats.peakMaxMass} />
            {stats.dpn != null && <Metric label="DPn" value={stats.dpn} digits={1} />}
            {stats.dpw != null && <Metric label="DPw" value={stats.dpw} digits={1} />}
            <Metric label="Peaks" value={stats.count} digits={0} />
          </div>
          <p className="text-[10px] text-muted-foreground">
            {stats.massBasis === "neutral" ? "Neutral-mass" : "Observed m/z"} basis ·{" "}
            <span className="font-medium text-amber-600">MALDI-apparent</span> — ion intensities are not
            quantitative; values are indicative only.
          </p>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, digits = 0 }: { label: string; value: number; digits?: number }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-2 text-center">
      <p className="font-mono text-sm font-semibold text-foreground">
        {Number.isFinite(value) ? value.toFixed(digits) : "—"}
      </p>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}
