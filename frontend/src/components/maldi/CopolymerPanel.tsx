import { Grid3x3, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adductById } from "@/lib/maldi/adducts";
import type { CopolymerSeries } from "@/lib/maldi/polymers";
import type { Adduct } from "@/lib/maldi/types";

interface CopolymerPanelProps {
  series: CopolymerSeries[];
  onDetect: (repeatA: number, repeatB: number) => void;
  repeatA: number;
  repeatB: number;
  onRepeatAChange: (v: number) => void;
  onRepeatBChange: (v: number) => void;
  adducts: Adduct[];
  peakCount: number;
  busy?: boolean;
  selectedId?: string | null;
  onSelect: (series: CopolymerSeries | null) => void;
}

/**
 * Two-monomer (copolymer / alternating) family detection: fits peaks to a
 * 2-D lattice m/z ≈ end + a·A + b·B + adduct. Leave the repeats blank to auto-pick
 * the two strongest spacings.
 */
export function CopolymerPanel({
  series,
  onDetect,
  repeatA,
  repeatB,
  onRepeatAChange,
  onRepeatBChange,
  adducts,
  peakCount,
  busy,
  selectedId,
  onSelect,
}: CopolymerPanelProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        Detect a copolymer of two monomers. Blank repeats auto-select the two strongest spacings.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Repeat A (Da)</Label>
          <Input className="h-8" type="number" step={0.001} value={repeatA || ""} onChange={(e) => onRepeatAChange(Number(e.target.value))} placeholder="auto" />
        </div>
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Repeat B (Da)</Label>
          <Input className="h-8" type="number" step={0.001} value={repeatB || ""} onChange={(e) => onRepeatBChange(Number(e.target.value))} placeholder="auto" />
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={() => onDetect(repeatA, repeatB)} disabled={busy || peakCount < 6 || adducts.length === 0}>
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Grid3x3 className="mr-1.5 h-4 w-4" />}
        Detect copolymer
      </Button>
      {adducts.length === 0 && <p className="text-[11px] text-amber-600">Select at least one adduct first.</p>}

      {series.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {series.map((s) => {
            const isSel = s.id === selectedId;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect(isSel ? null : s)}
                  className={[
                    "w-full rounded-lg border p-2 text-left transition-smooth",
                    isSel ? "border-primary bg-primary/5" : "border-border/60 bg-background/60 hover:border-primary/40",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground">{adductById(adducts, s.adductId).label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">score {Math.round(s.score * 100)}%</span>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                    <span>A {s.repeatA.toFixed(2)}</span>
                    <span>B {s.repeatB.toFixed(2)}</span>
                    <span>{s.members.length} points</span>
                    <span>err {s.meanErrorDa.toFixed(3)} Da</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
