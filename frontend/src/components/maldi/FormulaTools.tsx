import { Atom, Eraser, Loader2, Search, Sigma } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { neutralMass } from "@/lib/maldi/adducts";
import {
  ELEMENT_SYMBOLS,
  formulaMass,
  isotopePattern,
  parseFormula,
  type FormulaCandidate,
  type IsotopePeak,
} from "@/lib/maldi/formula";
import { formulaCandidates as runCandidates, isCancelledError } from "@/lib/maldi/workerClient";
import type { Adduct } from "@/lib/maldi/types";

export interface IsotopeOverlay {
  formula: string;
  adductLabel: string;
  sticks: { mz: number; abundance: number }[];
}

interface FormulaToolsProps {
  adducts: Adduct[];
  /** m/z of the currently highlighted peak, used to anchor the candidate search. */
  selectedPeakMz?: number | null;
  /** Push an isotope overlay to the spectrum plot (null clears it). */
  onOverlay: (overlay: IsotopeOverlay | null) => void;
}

const DEFAULT_ELEMENTS = ["C", "H", "N", "O"];

export function FormulaTools({ adducts, selectedPeakMz, onOverlay }: FormulaToolsProps) {
  // --- Formula → mass + isotope pattern (instant, main thread) ----------------
  const [formula, setFormula] = useState("C2H4O");
  const [overlayAdductId, setOverlayAdductId] = useState<string>("");

  const parsed = useMemo(() => {
    if (!formula.trim()) return null;
    try {
      return formulaMass(formula);
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Invalid formula" } as const;
    }
  }, [formula]);

  const pattern = useMemo<IsotopePeak[]>(() => {
    if (!parsed || "error" in parsed) return [];
    try {
      return isotopePattern(parseFormula(formula), { maxPeaks: 12 });
    } catch {
      return [];
    }
  }, [parsed, formula]);

  const overlayAdduct = adducts.find((a) => a.id === overlayAdductId) ?? adducts[0];

  const pushOverlay = () => {
    if (!parsed || "error" in parsed || pattern.length === 0) return;
    const shift = overlayAdduct ? overlayAdduct.massShift : 0;
    const charge = overlayAdduct ? Math.abs(overlayAdduct.charge) : 1;
    const sticks = pattern.map((p) => ({ mz: (p.mass + shift) / charge, abundance: p.abundance }));
    onOverlay({ formula: parsed.formula, adductLabel: overlayAdduct?.label ?? "neutral", sticks });
    toast.success("Isotope pattern overlaid on the spectrum");
  };

  // --- Formula candidate search (worker) --------------------------------------
  const [searchElements, setSearchElements] = useState<string[]>(DEFAULT_ELEMENTS);
  const [tolerance, setTolerance] = useState("0.2");
  const [manualMass, setManualMass] = useState("");
  const [searchAdductId, setSearchAdductId] = useState<string>("");
  const [candidates, setCandidates] = useState<FormulaCandidate[]>([]);
  const [searching, setSearching] = useState(false);

  const searchAdduct = adducts.find((a) => a.id === searchAdductId) ?? adducts[0];

  const targetMass = useMemo(() => {
    if (manualMass.trim()) return Number(manualMass);
    if (selectedPeakMz && searchAdduct) return neutralMass(selectedPeakMz, searchAdduct);
    return NaN;
  }, [manualMass, selectedPeakMz, searchAdduct]);

  const toggleElement = (sym: string) => {
    setSearchElements((prev) => (prev.includes(sym) ? prev.filter((s) => s !== sym) : [...prev, sym]));
  };

  const handleSearch = async () => {
    if (!Number.isFinite(targetMass) || targetMass <= 0) {
      toast.error("Pick a peak or enter a neutral mass first");
      return;
    }
    setSearching(true);
    try {
      const result = await runCandidates(targetMass, {
        elements: searchElements,
        toleranceDa: Number(tolerance) || 0.2,
        maxResults: 40,
      });
      setCandidates(result.candidates);
      toast.success(`${result.candidates.length} formula candidates`);
    } catch (e) {
      if (!isCancelledError(e)) {
        console.error(e);
        toast.error("Formula search failed");
      }
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Formula → mass + isotope pattern */}
      <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/50 p-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Sigma className="h-4 w-4 text-primary" /> Formula → mass &amp; isotopes
        </div>
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Molecular formula</Label>
          <Input
            className="h-8 font-mono"
            value={formula}
            onChange={(e) => setFormula(e.target.value)}
            placeholder="C2H4O"
          />
        </div>

        {parsed && "error" in parsed && <p className="text-[11px] text-destructive">{parsed.error}</p>}

        {parsed && !("error" in parsed) && (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="Exact mass" value={parsed.exact.toFixed(5)} />
              <Stat label="Nominal" value={String(parsed.nominal)} />
              <Stat label="RDBE" value={parsed.rdbe.toFixed(1)} />
            </div>

            {pattern.length > 0 && (
              <div className="flex flex-col gap-1">
                <Label className="text-[11px] text-muted-foreground">Isotope pattern</Label>
                <div className="flex flex-col gap-0.5">
                  {pattern.map((p) => (
                    <div key={p.mass.toFixed(4)} className="flex items-center gap-2">
                      <span className="w-20 font-mono text-[10px] text-muted-foreground">{p.mass.toFixed(3)}</span>
                      <span className="h-2 flex-1 overflow-hidden rounded bg-border">
                        <span className="block h-full bg-primary" style={{ width: `${p.abundance * 100}%` }} />
                      </span>
                      <span className="w-9 text-right font-mono text-[10px] text-muted-foreground">
                        {Math.round(p.abundance * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-end gap-2">
              <div className="grid flex-1 gap-1">
                <Label className="text-[11px] text-muted-foreground">Overlay as</Label>
                <Select value={overlayAdduct?.id ?? ""} onValueChange={setOverlayAdductId}>
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="Adduct…" />
                  </SelectTrigger>
                  <SelectContent>
                    {adducts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" className="h-8" onClick={pushOverlay} disabled={!adducts.length}>
                <Atom className="mr-1 h-3.5 w-3.5" /> Overlay
              </Button>
              <Button size="sm" variant="outline" className="h-8" onClick={() => onOverlay(null)}>
                <Eraser className="h-3.5 w-3.5" />
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Formula candidate search */}
      <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/50 p-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Search className="h-4 w-4 text-primary" /> Find formulas for a mass
        </div>

        <p className="text-[11px] text-muted-foreground">
          {selectedPeakMz
            ? `Anchored to selected peak m/z ${selectedPeakMz.toFixed(3)}${searchAdduct ? ` (neutral ${Number.isFinite(targetMass) ? targetMass.toFixed(3) : "—"} via ${searchAdduct.label})` : ""}.`
            : "Select a peak in the table, or enter a neutral mass below."}
        </p>

        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Neutral mass (override)</Label>
            <Input
              className="h-8"
              type="number"
              value={manualMass}
              onChange={(e) => setManualMass(e.target.value)}
              placeholder="optional"
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Adduct</Label>
            <Select value={searchAdduct?.id ?? ""} onValueChange={setSearchAdductId}>
              <SelectTrigger className="h-8 w-28">
                <SelectValue placeholder="Adduct…" />
              </SelectTrigger>
              <SelectContent>
                {adducts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Elements</Label>
          <div className="flex flex-wrap gap-1">
            {ELEMENT_SYMBOLS.map((sym) => (
              <button
                key={sym}
                type="button"
                onClick={() => toggleElement(sym)}
                className={[
                  "rounded border px-1.5 py-0.5 font-mono text-[10px] transition-smooth",
                  searchElements.includes(sym)
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border/70 bg-background/60 text-muted-foreground hover:border-primary/40",
                ].join(" ")}
              >
                {sym}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-end gap-2">
          <div className="grid w-24 gap-1">
            <Label className="text-[11px] text-muted-foreground">Tol (Da)</Label>
            <Input className="h-8" type="number" step={0.05} value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
          </div>
          <Button size="sm" className="h-8" onClick={handleSearch} disabled={searching || searchElements.length === 0}>
            {searching ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-1 h-3.5 w-3.5" />}
            Search
          </Button>
        </div>

        {candidates.length > 0 && (
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Formula</th>
                  <th className="px-2 py-1 text-right font-medium">Mass</th>
                  <th className="px-2 py-1 text-right font-medium">Δ ppm</th>
                  <th className="px-2 py-1 text-right font-medium">RDBE</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.formula} className="border-t border-border/40">
                    <td className="px-2 py-1 font-mono font-medium text-foreground">{c.formula}</td>
                    <td className="px-2 py-1 text-right font-mono text-muted-foreground">{c.exactMass.toFixed(4)}</td>
                    <td className="px-2 py-1 text-right font-mono text-muted-foreground">{c.errorPpm.toFixed(1)}</td>
                    <td className="px-2 py-1 text-right font-mono text-muted-foreground">{c.rdbe.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-1.5">
      <p className="font-mono text-xs font-semibold text-foreground">{value}</p>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}
