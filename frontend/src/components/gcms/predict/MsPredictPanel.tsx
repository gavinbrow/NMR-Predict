import { ArrowDown, ArrowUp, ArrowUpDown, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MoleculeEditor } from "@/components/nmr/MoleculeEditor";
import { Button } from "@/components/ui/button";
import { useDebounced } from "@/hooks/use-debounced";
import { predictEiSpectrum, smilesToFormula, type PredictEiResult } from "@/lib/gcms/predictMs";
import type { PredictedRunMatch } from "@/lib/gcms/predictMatch";
import type { MassSpectrum, MsRun, SpecPeak } from "@/lib/gcms/types";
import { GcmsPlot, type PanelTrace } from "@/components/gcms/GcmsPlot";

export type MsPredictMatchResult = PredictedRunMatch;

/** Resolve the app's --primary design token for the predicted trace colour,
 *  matching `SpectrumPanel`'s fallback so the predicted sticks match the
 *  on-screen live spectrum's colour convention. */
function primaryToken(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  if (!raw) return "hsl(190 90% 38%)";
  return raw.startsWith("hsl") ? raw : `hsl(${raw})`;
}

interface MsPredictPanelProps {
  /** The active run, used by the confidence-gated current-file search.
   *  null when no run is loaded — the panel still works as a pure predictor. */
  activeRun: MsRun | null;
  /** The SMILES string, hoisted to the page so a tab switch preserves the
   *  user's drawing. The panel is presentational; this state survives. */
  smiles: string;
  onSmilesChange(smiles: string): void;
  /** Find a fragment m/z across the active run's scans (existing handler). */
  onFindFragment(mz: number, tol: number, minRelPct: number): void;
  /** Score the prediction against the active run using spectral similarity,
   * diagnostic-ion count, and predicted-ion coverage. */
  onMatchSpectrum(predicted: MassSpectrum): MsPredictMatchResult | null;
  onSelectRt(rtMin: number): void;
}

/**
 * "Predict MS" panel: draw a molecule in Ketcher → heuristic predicted EI
 * spectrum (molecular ion + isotope envelope + neutral losses + single-bond
 * cleavage fragments), labelled APPROXIMATE. The current-file search requires
 * multiple diagnostic ions plus full-spectrum agreement before it calls a
 * candidate a likely match; weak candidates remain inspectable without being
 * presented as an identification.
 *
 * Reuses `MoleculeEditor` (Ketcher) verbatim and `GcmsPlot` in stick mode for
 * the preview. The predictor is pure (`lib/gcms/predictMs.ts`); this panel is
 * presentational + stateful (SMILES, last prediction). Hoisted to the page so
 * a tab switch preserves the user's drawing + result.
 */
export function MsPredictPanel({
  activeRun,
  smiles,
  onSmilesChange,
  onFindFragment,
  onMatchSpectrum,
  onSelectRt,
}: MsPredictPanelProps): JSX.Element {
  const debouncedSmiles = useDebounced(smiles, 400);
  const [match, setMatch] = useState<MsPredictMatchResult | null>(null);
  const [matching, setMatching] = useState(false);
  // Bug 4a: the index GcmsPlot's onHover last reported, used to look up
  // which ion is under the cursor (prediction.peaks is index-aligned with
  // prediction.spectrum.mz — both built from the same sorted array).
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const prediction: PredictEiResult | null = useMemo(() => {
    const f = smilesToFormula(debouncedSmiles);
    if (!f) return null;
    return predictEiSpectrum(f);
  }, [debouncedSmiles]);

  // Bug 4b fix: GcmsPlot only re-fits its x-view when its rebuild key changes
  // ([traceIdsKey, xDomainKey, ...]) — the predicted trace's id is always the
  // literal "predict", so without an explicit xDomain, switching to a LARGER
  // molecule after a smaller one silently keeps the smaller one's fitted
  // x-range (peaks past it exist in the data but are outside the view). A
  // small padding keeps the outermost sticks from touching the plot edge.
  const predictXDomain = useMemo<[number, number] | undefined>(() => {
    const mzArr = prediction?.spectrum.mz;
    if (!mzArr || mzArr.length === 0) return undefined;
    const lo = mzArr[0];
    const hi = mzArr[mzArr.length - 1];
    const pad = Math.max(2, (hi - lo) * 0.03);
    return [Math.max(0, lo - pad), hi + pad];
  }, [prediction]);

  // Reset the hover readout whenever the prediction itself changes (a stale
  // index from the previous molecule could otherwise point at the wrong ion
  // for one frame before the next real hover event corrects it).
  useEffect(() => {
    setHoverIdx(null);
    setMatch(null);
  }, [prediction]);

  const hoveredPeak = hoverIdx != null ? prediction?.peaks[hoverIdx] ?? null : null;

  // Stick traces for the predicted spectrum (single trace, stick mode).
  const panelTraces: PanelTrace[] = useMemo(() => {
    if (!prediction) return [];
    return [
      {
        id: "predict",
        label: prediction.spectrum.label,
        x: prediction.spectrum.mz,
        y: prediction.spectrum.intensity,
        color: primaryToken(),
        visible: true,
        offset: 0,
        width: 1.4,
      },
    ];
  }, [prediction]);

  const handleSearch = () => {
    if (!prediction || !activeRun) return;
    setMatching(true);
    try {
      const r = onMatchSpectrum(prediction.spectrum);
      setMatch(r);
      if (r?.accepted && r.best) onSelectRt(r.best.rtMin);
    } finally {
      setMatching(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Left: Ketcher editor. */}
      <div className="flex flex-col gap-2">
        <div className="rounded-lg border border-border/60 bg-card/40 p-2">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Sparkles className="h-3.5 w-3.5" />
            Draw a molecule
          </div>
          <div className="h-[360px]">
            <MoleculeEditor value={smiles} onSmilesChange={onSmilesChange} />
          </div>
        </div>
        {prediction && (
          <div className="rounded-lg border border-border/60 bg-card/40 p-2 text-xs">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>
                Formula: <span className="font-mono font-medium">{prediction.formula}</span>
              </span>
              <span>
                Exact mass:{" "}
                <span className="font-mono font-medium">{prediction.exactMass.toFixed(4)}</span>
              </span>
              <span>
                Peaks: <span className="font-mono font-medium">{prediction.peaks.length}</span>
              </span>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleSearch}
            disabled={!activeRun || !prediction || matching}
            title="Require multiple diagnostic ions and full-spectrum agreement, then jump to a confident candidate"
          >
            <Search className="mr-1.5 h-3.5 w-3.5" />
            {matching ? "Searching…" : "Search current file"}
          </Button>
        </div>
        {match && <MatchResult result={match} onSelectRt={onSelectRt} />}
        {!activeRun && (
          <p className="text-[11px] text-muted-foreground">
            Import a run to search its scans for the predicted spectrum.
          </p>
        )}
      </div>

      {/* Right: predicted stick spectrum + approximate badge. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-foreground">Predicted MS</span>
          <span
            className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning"
            title="Heuristic client-side prediction (molecular ion + isotope envelope + neutral losses + single-bond cleavage). A real EI fragmentation model belongs in a backend."
          >
            approximate
          </span>
        </div>
        <div className="h-[360px] rounded-lg border border-border/60 bg-card/40 p-2">
          {prediction && prediction.peaks.length > 0 ? (
            <div className="flex h-full flex-col gap-1">
              <div className="flex h-4 shrink-0 items-center justify-end text-[11px] text-muted-foreground">
                {hoveredPeak && (
                  <span className="font-mono">
                    m/z {hoveredPeak.mz.toFixed(3)} · {hoveredPeak.relPct.toFixed(1)}%
                    {hoveredPeak.ion ? ` · ${hoveredPeak.ion}` : ""}
                  </span>
                )}
              </div>
              <div className="min-h-0 flex-1">
                <GcmsPlot
                  axis="mz"
                  drawMode="stick"
                  xLabel="m/z"
                  title={prediction.spectrum.label}
                  traces={panelTraces}
                  activeTraceId="predict"
                  annotations={[]}
                  markers={[]}
                  cursorX={null}
                  selections={[]}
                  background={null}
                  xDomain={predictXDomain}
                  normalize={false}
                  stacked={false}
                  logY={false}
                  onHover={(_x, idx) => setHoverIdx(idx)}
                  onClick={() => {}}
                  onSelectRange={() => {}}
                />
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {smiles.trim() === "" ? "Draw a molecule to predict its MS" : "Could not parse SMILES"}
            </div>
          )}
        </div>
        {prediction && prediction.peaks.length > 0 && (
          <PeakTable
            peaks={prediction.peaks}
            onFindMz={(mz) => activeRun && onFindFragment(mz, 0.3, 5)}
            findable={!!activeRun}
          />
        )}
      </div>
    </div>
  );
}

/** Compact predicted-peak table: m/z, rel%. Clicking a row feeds that
 *  peak's m/z into the fragment finder (when a run is loaded). */
function PeakTable({
  peaks,
  onFindMz,
  findable,
}: {
  peaks: SpecPeak[];
  onFindMz(mz: number): void;
  findable: boolean;
}) {
  const [sort, setSort] = useState<{ key: "mz" | "relPct"; direction: "asc" | "desc" }>({
    key: "mz",
    direction: "asc",
  });
  const sortedPeaks = useMemo(
    () =>
      peaks
        .map((peak, sourceIndex) => ({ peak, sourceIndex }))
        .sort((a, b) => {
          const delta = a.peak[sort.key] - b.peak[sort.key];
          return (sort.direction === "asc" ? delta : -delta) || a.sourceIndex - b.sourceIndex;
        }),
    [peaks, sort],
  );
  const toggleSort = (key: "mz" | "relPct") => {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  };
  const SortIcon = ({ column }: { column: "mz" | "relPct" }) =>
    sort.key !== column ? (
      <ArrowUpDown className="h-3 w-3 opacity-50" />
    ) : sort.direction === "asc" ? (
      <ArrowUp className="h-3 w-3" />
    ) : (
      <ArrowDown className="h-3 w-3" />
    );

  return (
    <div className="max-h-40 overflow-auto rounded-md border border-border/60">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card">
          <tr>
            <th className="h-7 px-2 text-left text-xs">
              <button
                type="button"
                className="inline-flex items-center gap-1 hover:text-primary"
                onClick={() => toggleSort("mz")}
              >
                m/z <SortIcon column="mz" />
              </button>
            </th>
            <th className="h-7 px-2 text-left text-xs">
              <button
                type="button"
                className="inline-flex items-center gap-1 hover:text-primary"
                onClick={() => toggleSort("relPct")}
              >
                Rel % <SortIcon column="relPct" />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedPeaks.map(({ peak: p, sourceIndex }) => (
            <tr
              key={`${p.id}:${sourceIndex}`}
              className={["h-7", findable ? "cursor-pointer hover:bg-muted/40" : ""].join(" ")}
              onClick={() => findable && onFindMz(p.mz)}
              title={findable ? "Find this m/z in the current file" : undefined}
            >
              <td className="h-7 px-2 font-mono text-xs">{p.mz.toFixed(3)}</td>
              <td className="h-7 px-2 font-mono text-xs">{p.relPct.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatchResult({
  result,
  onSelectRt,
}: {
  result: MsPredictMatchResult;
  onSelectRt(rtMin: number): void;
}) {
  const best = result.best;
  return (
    <div
      className={[
        "rounded-lg border px-3 py-2 text-xs",
        result.accepted
          ? "border-success/35 bg-success/10"
          : "border-warning/35 bg-warning/10",
      ].join(" ")}
    >
      <p className="font-semibold text-foreground">
        {result.accepted ? "Likely match found" : "No confident match"}
      </p>
      <p className="mt-0.5 text-muted-foreground">{result.reason}</p>
      {best && (
        <p className="mt-1 font-mono text-[11px] text-foreground">
          Best RT {best.rtMin.toFixed(3)} min · similarity {(best.score * 100).toFixed(1)}% ·{" "}
          {best.matchedIons}/{best.diagnosticIons} diagnostic ions · coverage{" "}
          {(best.coverage * 100).toFixed(0)}%
        </p>
      )}
      {result.candidates.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Inspect candidate:</span>
          {result.candidates.map((candidate) => (
            <button
              key={candidate.rtMin}
              type="button"
              onClick={() => onSelectRt(candidate.rtMin)}
              className="rounded-md border border-border/70 bg-background/70 px-2 py-1 font-mono text-[11px] hover:border-primary hover:text-primary"
              title={`${(candidate.score * 100).toFixed(1)}% similarity; ${candidate.matchedIons}/${candidate.diagnosticIons} ions`}
            >
              {candidate.rtMin.toFixed(3)} min
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
