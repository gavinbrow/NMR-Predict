import { Loader2, Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { adductById } from "@/lib/maldi/adducts";
import type { EndGroupCandidate } from "@/lib/maldi/endgroups";
import type { Adduct } from "@/lib/maldi/types";

interface EndGroupPanelProps {
  repeatMass: number;
  candidates: EndGroupCandidate[];
  onSolve: () => void;
  adducts: Adduct[];
  busy?: boolean;
}

export function EndGroupPanel({ repeatMass, candidates, onSolve, adducts, busy }: EndGroupPanelProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        Solve the residual end-group mass (α + ω termini) for the current repeat unit and adducts,
        and match it against a small end-group library.
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={onSolve}
        disabled={busy || !(repeatMass > 0) || adducts.length === 0}
      >
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Puzzle className="mr-1.5 h-4 w-4" />}
        Solve end groups
      </Button>

      {candidates.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {candidates.map((c) => (
            <li key={c.id} className="rounded-lg border border-border/60 bg-background/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-foreground">
                  {c.residualMass.toFixed(3)} Da
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {adductById(adducts, c.adductId).label}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                <span>{c.matchedOligomers} oligomers</span>
                <span>err {c.meanErrorDa.toFixed(3)} Da</span>
                <span>conf {Math.round(c.confidence * 100)}%</span>
              </div>
              {c.libraryMatch && (
                <p className="mt-1 inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                  {c.libraryMatch}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
