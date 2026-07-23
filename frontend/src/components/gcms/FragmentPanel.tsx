import { FlaskConical, Layers, Scissors, Sigma } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Input } from "@/components/ui/input";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SpecPeak } from "@/lib/gcms/types";

/**
 * "Find fragment ion spectrum" — four tools inside collapsible sections:
 *
 *  a. **Extract ion** — an m/z input + tolerance + Sum/Max + `Extract` button;
 *     identical semantics to the TracesPanel XIC builder, offered here for
 *     discoverability. Calls `onAddXic`.
 *  b. **Fragment finder** — an m/z input, a `Min rel %` threshold (default 5)
 *     and a `Find` button calling `onFindFragment(mz, tol, minRelPct)`. Renders
 *     the `fragmentHits` prop: RT (3 dp), the ion's rel % in that peak's apex
 *     spectrum, the apex base-peak m/z. Clicking a row calls `onRowClick(rt)`.
 *     Sorted by rel % descending.
 *  c. **Neutral losses** — given the current spectrum's peaks (`specPeaks`),
 *     compute Δm from the BASE PEAK to each of the top N other peaks and render
 *     a table of `Δm`, `m/z`, `rel %`, `assignment`. Look Δm up (±0.3 Da) in a
 *     fixed table and show the match, or "—". This is a pure computation done
 *     inline — no new lib file.
 *  d. **Library match** — a `Compare with active spectrum` button calling
 *     `onCompareSpectra()` and displays the returned `similarity` prop as a
 *     percentage. Shows `—` when null.
 */
interface FragmentPanelProps {
  suggestedTol: number;
  busy?: boolean;
  specPeaks: SpecPeak[];
  fragmentHits: { rtMin: number; relPct: number; basePeakMz: number | null; abundance: number }[] | null;
  similarity: number | null;
  onAddXic(mzList: number[], tol: number, mode: "sum" | "max"): void;
  onFindFragment(mz: number, tol: number, minRelPct: number): void;
  onRowClick(rtMin: number): void;
  onCompareSpectra(): void;
}

export function FragmentPanel({
  suggestedTol,
  busy = false,
  specPeaks,
  fragmentHits,
  similarity,
  onAddXic,
  onFindFragment,
  onRowClick,
  onCompareSpectra,
}: FragmentPanelProps) {
  return (
    <div className="flex flex-col gap-2">
      <ExtractIonTool suggestedTol={suggestedTol} busy={busy} onAddXic={onAddXic} />
      <FragmentFinderTool suggestedTol={suggestedTol} busy={busy} fragmentHits={fragmentHits} onFindFragment={onFindFragment} onRowClick={onRowClick} />
      <NeutralLossesTool specPeaks={specPeaks} />
      <LibraryMatchTool similarity={similarity} busy={busy} onCompareSpectra={onCompareSpectra} />
    </div>
  );
}

/* ------------------------------------------------------------------ a. Extract ion */

function ExtractIonTool({
  suggestedTol,
  busy,
  onAddXic,
}: {
  suggestedTol: number;
  busy: boolean;
  onAddXic(mzList: number[], tol: number, mode: "sum" | "max"): void;
}) {
  const [mzText, setMzText] = useState("");
  const [tol, setTol] = useState(String(suggestedTol));
  const [mode, setMode] = useState<"sum" | "max">("sum");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setTol(String(suggestedTol)), [suggestedTol]);

  const parsed = useMemo(() => parseMzList(mzText), [mzText]);
  const tolNum = Number(tol);
  const tolValid = Number.isFinite(tolNum) && tolNum > 0;

  const handleExtract = () => {
    if (!parsed || !tolValid) return;
    onAddXic(parsed, tolNum, mode);
    setMzText("");
    setError(null);
  };

  return (
    <CollapsibleSection title="Extract ion" icon={Layers} defaultOpen>
      <div className="flex flex-col gap-1.5">
        <Input
          className="h-7 text-xs"
          placeholder="m/z list, e.g. 162.3, 201.1"
          inputMode="decimal"
          value={mzText}
          onChange={(e) => setMzText(e.target.value)}
          onBlur={() => setError(mzText.trim() === "" || parsed ? null : "Enter comma-separated m/z values")}
        />
        <div className="flex items-center gap-1.5">
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>±</span>
            <Input
              type="number"
              step="any"
              min="0"
              className="h-7 w-16 px-1 text-xs"
              value={tol}
              onChange={(e) => setTol(e.target.value)}
              title="Tolerance (Da)"
            />
            <span>Da</span>
          </label>
          <div className="flex overflow-hidden rounded-md border border-border/60">
            <Button
              type="button"
              size="sm"
              variant={mode === "sum" ? "default" : "ghost"}
              className="h-7 rounded-none px-2 text-[11px]"
              onClick={() => setMode("sum")}
            >
              Sum
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "max" ? "default" : "ghost"}
              className="h-7 rounded-none px-2 text-[11px]"
              onClick={() => setMode("max")}
            >
              Max
            </Button>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-7 ml-auto px-2 text-[11px]"
            onClick={handleExtract}
            disabled={busy || !parsed || !tolValid}
          >
            Extract
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!error && mzText.trim() !== "" && !parsed && (
          <p className="text-xs text-destructive">Enter comma-separated m/z values.</p>
        )}
      </div>
    </CollapsibleSection>
  );
}

/* ------------------------------------------------------------------ b. Fragment finder */

function FragmentFinderTool({
  suggestedTol,
  busy,
  fragmentHits,
  onFindFragment,
  onRowClick,
}: {
  suggestedTol: number;
  busy: boolean;
  fragmentHits: { rtMin: number; relPct: number; basePeakMz: number | null; abundance: number }[] | null;
  onFindFragment(mz: number, tol: number, minRelPct: number): void;
  onRowClick(rtMin: number): void;
}) {
  const [mzText, setMzText] = useState("");
  const [tol, setTol] = useState(String(suggestedTol));
  const [minRel, setMinRel] = useState("5");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setTol(String(suggestedTol)), [suggestedTol]);

  const mz = Number(mzText);
  const mzValid = Number.isFinite(mz) && mz > 0;
  const tolNum = Number(tol);
  const tolValid = Number.isFinite(tolNum) && tolNum > 0;
  const minRelNum = Number(minRel);
  const minRelValid = Number.isFinite(minRelNum);

  // Sort hits by rel % descending for display.
  const sortedHits = useMemo(() => {
    if (!fragmentHits) return null;
    return [...fragmentHits].sort((a, b) => b.relPct - a.relPct);
  }, [fragmentHits]);

  // Bug 5: the single hit with the highest ABSOLUTE intensity — usually a
  // different scan than the "most pure" (highest rel %) one, so both get
  // surfaced (see the badges in the table below).
  const mostAbundantHit = useMemo(() => {
    if (!fragmentHits || fragmentHits.length === 0) return null;
    return fragmentHits.reduce((a, b) => (b.abundance > a.abundance ? b : a));
  }, [fragmentHits]);

  const handleFind = () => {
    if (!mzValid || !tolValid || !minRelValid) return;
    onFindFragment(mz, tolNum, minRelNum);
    setError(null);
  };

  return (
    <CollapsibleSection title="Fragment finder" icon={Scissors} defaultOpen={false}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Input
            className="h-7 w-24 text-xs"
            placeholder="m/z"
            inputMode="decimal"
            value={mzText}
            onChange={(e) => setMzText(e.target.value)}
            title="Target fragment m/z"
          />
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>±</span>
            <Input
              type="number"
              step="any"
              min="0"
              className="h-7 w-16 px-1 text-xs"
              value={tol}
              onChange={(e) => setTol(e.target.value)}
              title="Tolerance (Da)"
            />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>Min %</span>
            <Input
              type="number"
              step="any"
              min="0"
              className="h-7 w-14 px-1 text-xs"
              value={minRel}
              onChange={(e) => setMinRel(e.target.value)}
              title="Minimum relative %"
            />
          </label>
          <Button
            type="button"
            size="sm"
            className="h-7 ml-auto px-2 text-[11px]"
            onClick={handleFind}
            disabled={busy || !mzValid || !tolValid || !minRelValid}
          >
            Find
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {mzText.trim() !== "" && !mzValid && (
          <p className="text-xs text-destructive">Enter a valid m/z.</p>
        )}
        {sortedHits != null && (
          <div className="mt-1 max-h-48 overflow-auto rounded-md border border-border/60">
            {sortedHits.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-muted-foreground">No hits above threshold.</p>
            ) : (
              <table className="w-full text-sm">
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead className="h-7 px-2 text-xs">RT</TableHead>
                    <TableHead className="h-7 px-2 text-xs">Rel %</TableHead>
                    <TableHead className="h-7 px-2 text-xs">Abundance</TableHead>
                    <TableHead className="h-7 px-2 text-xs">Base m/z</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedHits.map((hit, i) => {
                    // sortedHits is sorted by rel % descending, so index 0 IS
                    // the most-pure hit; the most-abundant hit is found by
                    // absolute intensity instead (bug 5: report both — they
                    // are frequently different scans).
                    const isMostPure = i === 0;
                    const isMostAbundant = hit === mostAbundantHit;
                    return (
                      <TableRow
                        key={i}
                        className="h-7 cursor-pointer"
                        onClick={() => onRowClick(hit.rtMin)}
                      >
                        <TableCell className="h-7 py-0 px-2 font-mono text-xs">
                          {hit.rtMin.toFixed(3)}
                        </TableCell>
                        <TableCell className="h-7 py-0 px-2 font-mono text-xs">
                          {hit.relPct.toFixed(2)}
                          {isMostPure && (
                            <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0 text-[10px] font-medium text-primary">
                              most pure
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="h-7 py-0 px-2 font-mono text-xs">
                          {hit.abundance.toFixed(0)}
                          {isMostAbundant && (
                            <span className="ml-1.5 rounded-full bg-warning/10 px-1.5 py-0 text-[10px] font-medium text-warning">
                              most abundant
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="h-7 py-0 px-2 font-mono text-xs">
                          {hit.basePeakMz != null ? hit.basePeakMz.toFixed(3) : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </table>
            )}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

/* ------------------------------------------------------------------ c. Neutral losses */

// Δm -> assignment(s). Lookup is ±0.3 Da.
const NEUTRAL_LOSSES: { dm: number; assignment: string }[] = [
  { dm: 15, assignment: "CH3" },
  { dm: 17, assignment: "OH" },
  { dm: 18, assignment: "H2O" },
  { dm: 28, assignment: "CO or C2H4" },
  { dm: 29, assignment: "CHO or C2H5" },
  { dm: 31, assignment: "OCH3" },
  { dm: 35, assignment: "Cl" },
  { dm: 43, assignment: "C3H7 or CH3CO" },
  { dm: 45, assignment: "COOH or OC2H5" },
  { dm: 57, assignment: "C4H9" },
  { dm: 59, assignment: "CO2CH3" },
  { dm: 77, assignment: "C6H5" },
  { dm: 79, assignment: "Br" },
  { dm: 91, assignment: "C7H7 (tropylium)" },
  { dm: 105, assignment: "C6H5CO" },
  { dm: 127, assignment: "I" },
];

function NeutralLossesTool({ specPeaks }: { specPeaks: SpecPeak[] }) {
  const rows = useMemo(() => computeNeutralLosses(specPeaks), [specPeaks]);

  return (
    <CollapsibleSection title="Neutral losses" icon={Sigma} defaultOpen={false}>
      <div className="flex flex-col gap-1.5">
        {rows.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No spectrum peaks to analyse.</p>
        ) : (
          <div className="max-h-48 overflow-auto rounded-md border border-border/60">
            <table className="w-full text-sm">
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead className="h-7 px-2 text-xs">Δm</TableHead>
                  <TableHead className="h-7 px-2 text-xs">m/z</TableHead>
                  <TableHead className="h-7 px-2 text-xs">Rel %</TableHead>
                  <TableHead className="h-7 px-2 text-xs">Assignment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={i} className="h-7">
                    <TableCell className="h-7 py-0 px-2 font-mono text-xs">
                      {r.dm.toFixed(2)}
                    </TableCell>
                    <TableCell className="h-7 py-0 px-2 font-mono text-xs">
                      {r.mz.toFixed(3)}
                    </TableCell>
                    <TableCell className="h-7 py-0 px-2 font-mono text-xs">
                      {r.relPct.toFixed(2)}
                    </TableCell>
                    <TableCell className="h-7 py-0 px-2 text-xs">
                      {r.assignment}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

/** Compute Δm from the base peak to each of the top N other peaks and look up
 *  an assignment (±0.3 Da). Returns rows sorted by rel % descending. */
function computeNeutralLosses(specPeaks: SpecPeak[]): { dm: number; mz: number; relPct: number; assignment: string }[] {
  if (specPeaks.length < 2) return [];
  // Base peak = highest intensity.
  const base = [...specPeaks].sort((a, b) => b.intensity - a.intensity)[0];
  // Top N others by rel % (excluding the base peak itself), sorted descending.
  const others = specPeaks
    .filter((p) => p.id !== base.id)
    .sort((a, b) => b.relPct - a.relPct)
    .slice(0, 12);
  const out: { dm: number; mz: number; relPct: number; assignment: string }[] = [];
  for (const p of others) {
    const dm = base.mz - p.mz;
    if (dm <= 0) continue;
    const match = NEUTRAL_LOSSES.find((n) => Math.abs(n.dm - dm) <= 0.3);
    out.push({ dm, mz: p.mz, relPct: p.relPct, assignment: match?.assignment ?? "—" });
  }
  return out.sort((a, b) => b.relPct - a.relPct);
}

/* ------------------------------------------------------------------ d. Library match */

function LibraryMatchTool({
  similarity,
  busy,
  onCompareSpectra,
}: {
  similarity: number | null;
  busy: boolean;
  onCompareSpectra(): void;
}) {
  return (
    <CollapsibleSection title="Library match" icon={FlaskConical} defaultOpen={false}>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={onCompareSpectra}
          disabled={busy}
        >
          Compare with active spectrum
        </Button>
        <span className="text-xs text-muted-foreground">
          Similarity:{" "}
          <span className="font-mono text-foreground">
            {similarity == null ? "—" : `${(similarity * 100).toFixed(1)}%`}
          </span>
        </span>
      </div>
    </CollapsibleSection>
  );
}

/* ------------------------------------------------------------------ helpers */

/** Parse a comma-separated m/z list into a number[], or null when invalid. */
function parseMzList(text: string): number[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parts = trimmed.split(/[\s,]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0) return null;
    out.push(n);
  }
  return out;
}