import {
  CircleCheck,
  CircleSlash,
  FolderOpen,
  HardDrive,
  Loader2,
  RotateCw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { AdductPanel } from "@/components/maldi/AdductPanel";
import { BatchPanel } from "@/components/maldi/BatchPanel";
import { CopolymerPanel } from "@/components/maldi/CopolymerPanel";
import { MaldiFigurePanel } from "@/components/maldi/figure/MaldiFigurePanel";
import { useFigureOptions } from "@/components/ir/figure/useFigureOptions";
import { FormulaTools, type IsotopeOverlay } from "@/components/maldi/FormulaTools";
import { ImportPanel } from "@/components/maldi/ImportPanel";
import { InterpretationPanel, type ExportKind } from "@/components/maldi/InterpretationPanel";
import { MaldiSpectrumPlot, type MaldiSpectrumPlotHandle } from "@/components/maldi/MaldiSpectrumPlot";
import { DocumentsPanel } from "@/components/maldi/DocumentsPanel";
import { MolWeightPanel } from "@/components/maldi/MolWeightPanel";
import { PeakPickingPanel } from "@/components/maldi/PeakPickingPanel";
import { PeakTable, type AssignableSeries } from "@/components/maldi/PeakTable";
import { ProcessingPanel } from "@/components/maldi/ProcessingPanel";
import { SeriesPanel, type RepeatGroupItem } from "@/components/maldi/SeriesPanel";
import { SeriesTable } from "@/components/maldi/SeriesTable";
import { TemplatePanel } from "@/components/maldi/TemplatePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useMaldiUndo, type UndoSnapshot } from "@/hooks/useMaldiUndo";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { adductById, ALL_BUILTIN_ADDUCTS } from "@/lib/maldi/adducts";
import { buildMaldiFigureData, type MaldiFigureSeriesGroup, type MaldiFigureSpectrum } from "@/lib/maldi/figure";
import {
  exportProjectJson,
  exportReportExcel,
  exportReportPdf,
  deserializeProject,
  type ReportPayload,
} from "@/lib/maldi/export";
import { interpretSpectrum, type Finding } from "@/lib/maldi/interpret";
import { summarizeMolWeight } from "@/lib/maldi/molweight";
import type { ParseMeta } from "@/lib/maldi/parse";
import { manualPeak, PEAK_PRESETS, type PeakPickParams } from "@/lib/maldi/peaks";
import {
  fitLadder,
  mergeSeriesGroup,
  peaksForRepeat,
  seriesAdductLabel,
  seriesForRepeat,
  splitMergedSeries,
} from "@/lib/maldi/polymers";
import { explainedPeakIds as explainedPeakIdsHelper, sameLadderSiblings, unexplainedPeaks } from "@/lib/maldi/seriesMatch";
import { buildLadderColorMap, SERIES_COLORS } from "@/lib/maldi/seriesColor";
import type { CopolymerSeries, RepeatCandidate, RepeatSeriesGroup } from "@/lib/maldi/polymers";
import {
  createProject,
  deleteProject,
  listProjects,
  loadProject,
  saveProject,
} from "@/lib/maldi/project";
import type { ChemistryTemplate } from "@/lib/maldi/repeatLibrary";
import { emptyProjectState } from "@/lib/maldi/types";
import type {
  Adduct,
  ExportRecord,
  Peak,
  ProcessingStep,
  ProjectState,
  ProjectSummary,
  Series,
  SpectrumData,
  StackSpectrum,
} from "@/lib/maldi/types";
import {
  assignSeries,
  detectCopolymer,
  detectRepeatUnits,
  disposeWorker,
  flagBackground,
  isCancelledError,
  parse,
  parseMs,
  pickPeaks,
  ping,
  process,
} from "@/lib/maldi/workerClient";

type WorkerStatus = "checking" | "ready" | "error";

/** One open spectrum in the session, carrying its own full analysis state. */
export interface MaldiDocument {
  id: string;
  name: string;
  /** Saved-project id once persisted, else null. */
  projectId: string | null;
  createdAt: number;
  state: ProjectState;
  /**
   * Per-document trace styling. Session-only UI state — deliberately NOT part of
   * `ProjectState`, NOT persisted, and NOT in `useMaldiUndo`'s deps (hiding a
   * trace must not undo an unrelated analysis edit). The colour doubles as the
   * legend swatch in the Documents panel; `offset` is the per-trace vertical
   * shift used by the overlay/stack view; `visible` gates whether the trace is
   * drawn at all.
   */
  color: string;
  visible: boolean;
  offset: number;
}

/** Owning document for a pooled peak (Combine documents mode). */
export interface PeakOwner {
  docId: string;
  name: string;
  color: string;
}

/**
 * Pick the trace colour for the next-opened document. Walks `SERIES_COLORS` by
 * a monotonically increasing counter (total documents ever created this
 * session) rather than the current live document count, so closing a document
 * can't cause a subsequent import to reuse a colour still held by an open
 * document. The palette has 10 entries (see `seriesColor.ts`); positional
 * assignment keeps a document's colour stable for the rest of the session.
 */
function nextDocColor(count: number): string {
  return SERIES_COLORS[count % SERIES_COLORS.length];
}

/**
 * A fresh SNIP baseline step, auto-applied on every import so the spectrum's
 * baseline sits at zero — peaks then grow up from the axis when the user scrolls
 * to scale the y-axis, instead of a noise band floating mid-plot. It is a normal
 * processing step: fully visible, editable, and removable in the Processing panel.
 */
function defaultBaselineStep(): ProcessingStep {
  return {
    id: crypto.randomUUID(),
    kind: "baseline",
    params: { method: "snip", iterations: 40, windowPoints: 50, lambda: 100000, p: 0.01 },
    enabled: true,
  };
}

/** Sidebar cards that default open; every other card id defaults collapsed. */
const DEFAULT_CARD_OPEN: Record<string, boolean> = { import: true, "peak-picking": true };

/** Two repeat units are the same entry when they agree to 4 dp — the precision the
 *  detector rounds candidates to and the panel's input step. */
function sameRepeat(a: number, b: number): boolean {
  return Math.abs(a - b) < 5e-5;
}

const Maldi = () => {
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>("checking");

  // --- Core project state -----------------------------------------------------
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("Untitled MALDI project");
  const projectCreatedAt = useRef<number>(Date.now());
  const [sourceName, setSourceName] = useState("");
  const [parseMeta, setParseMeta] = useState<ParseMeta | null>(null);
  const [raw, setRaw] = useState<SpectrumData | null>(null);
  const [processed, setProcessed] = useState<SpectrumData | null>(null);
  const [steps, setSteps] = useState<ProcessingStep[]>([]);
  const [peaks, setPeaks] = useState<Peak[]>([]);
  const [pickParams, setPickParams] = useState<PeakPickParams>({ ...PEAK_PRESETS.conservative });
  const [selectedAdductIds, setSelectedAdductIds] = useState<string[]>(["H", "Na", "K"]);
  const [customAdducts, setCustomAdducts] = useState<Adduct[]>([]);
  const [repeatCandidates, setRepeatCandidates] = useState<RepeatCandidate[]>([]);
  const [repeatMass, setRepeatMass] = useState(0);
  // Every repeat unit kept for this spectrum — a sample with two polymers in it
  // carries one entry per polymer. `repeatMass` above is whichever of these is
  // currently active (previewed / assigned next); each assigned series records its
  // own repeat mass, so series built from different repeat units coexist.
  const [repeatMasses, setRepeatMasses] = useState<number[]>([]);
  const [endGroupMass, setEndGroupMass] = useState(0);
  const [series, setSeries] = useState<Series[]>([]);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  const [highlightedPeakIds, setHighlightedPeakIds] = useState<Set<string> | undefined>();
  // Series-level highlight: one coloured group per assigned series (replaces the
  // flat pink set when whole series are emphasised, so ladders keep their colours).
  const [highlightedSeriesIds, setHighlightedSeriesIds] = useState<Set<string> | undefined>();
  // Hide non-highlighted peaks while a series/end-group is selected, so the
  // chosen ladder stands alone. Controlled here (the plot's switch reflects it).
  const [isolateSelection, setIsolateSelection] = useState(false);
  // Fold isotope-shifted spacings (~1 Da apart) into one repeat unit on detect.
  const [repeatIsotopeAware, setRepeatIsotopeAware] = useState(true);
  // Picking a repeat unit always previews it broken into its distinct ladders.
  const [repeatGroups, setRepeatGroups] = useState<RepeatSeriesGroup[]>([]);
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);

  // --- Phase 3/4 state --------------------------------------------------------
  const [overlay, setOverlay] = useState<IsotopeOverlay | null>(null);
  const [copolymerSeries, setCopolymerSeries] = useState<CopolymerSeries[]>([]);
  const [copolymerA, setCopolymerA] = useState(0);
  const [copolymerB, setCopolymerB] = useState(0);
  const [selectedCopolymerId, setSelectedCopolymerId] = useState<string | null>(null);
  const [exportHistory, setExportHistory] = useState<ExportRecord[]>([]);
  // Mirror of exportHistory read by the undo restore (the log is append-only and
  // excluded from snapshots, so a restore must preserve the current log).
  const exportHistoryRef = useRef<ExportRecord[]>(exportHistory);
  useEffect(() => {
    exportHistoryRef.current = exportHistory;
  }, [exportHistory]);
  const [documents, setDocuments] = useState<MaldiDocument[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  // Monotonically increasing count of documents ever created this session
  // (never decremented on close). Drives `nextDocColor` so closing a document
  // can't make a subsequent import reuse a colour still held by an open doc.
  const docsCreatedCountRef = useRef(0);
  // The "reference" document is the minuend of the active − reference difference
  // trace (the Difference toggle in the Documents panel). It is session-only UI
  // state — NOT part of `ProjectState`, NOT persisted, NOT in `useMaldiUndo`'s
  // deps (same exclusion rule as the per-document trace styling). The reference
  // survives document switches and refreshes don't.
  const [referenceDocId, setReferenceDocId] = useState<string | null>(null);
  const [difference, setDifference] = useState(false);
  // Combine documents: treat every VISIBLE document as one for the Peak table,
  // Figure and Mol. weight tabs. Session-only UI state — NOT part of ProjectState,
  // NOT persisted, NOT in useMaldiUndo's deps (same exclusion rule as the per-
  // document trace styling). Picking, processing and series assignment stay
  // scoped to the active document even while this is on.
  const [combineDocuments, setCombineDocuments] = useState(false);
  const plotHandleRef = useRef<MaldiSpectrumPlotHandle>(null);
  const projectImportRef = useRef<HTMLInputElement>(null);

  // --- Busy flags -------------------------------------------------------------
  const [parsing, setParsing] = useState(false);
  const [processingBusy, setProcessingBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [detectingCopolymer, setDetectingCopolymer] = useState(false);
  const [saving, setSaving] = useState(false);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [manageProjectsOpen, setManageProjectsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);

  const allAdducts = useMemo(() => [...ALL_BUILTIN_ADDUCTS, ...customAdducts], [customAdducts]);
  const selectedAdducts = useMemo(
    () => allAdducts.filter((a) => selectedAdductIds.includes(a.id)),
    [allAdducts, selectedAdductIds],
  );

  const selectedPeakMz = useMemo(() => {
    if (!highlightedPeakIds || highlightedPeakIds.size !== 1) return null;
    const [id] = [...highlightedPeakIds];
    const p = peaks.find((pk) => pk.id === id);
    return p ? p.centroid ?? p.mz : null;
  }, [highlightedPeakIds, peaks]);

  // The split-series ladders, decorated with a stable colour (by position) for the
  // panel swatches. The plot consumes the same colours via `plotHighlightGroups`.
  const repeatGroupItems = useMemo<RepeatGroupItem[]>(
    () =>
      repeatGroups.map((g, i) => ({
        key: String(i),
        color: SERIES_COLORS[i % SERIES_COLORS.length],
        count: g.peakIds.length,
        startMz: g.startMz,
        endMz: g.endMz,
      })),
    [repeatGroups],
  );

  // Ladder-based colouring: one colour per distinct peak ladder. Different adducts
  // of the same ladder share their member peaks, so [M+H]⁺/[M+Na]⁺/[M+K]⁺ of one
  // polymer get one colour; distinct ladders (disjoint peaks) get distinct colours.
  const ladderColorMap = useMemo(() => buildLadderColorMap(series), [series]);
  const colorForSeries = useCallback(
    (s: Series) =>
      s.color ?? ladderColorMap.get(s.id) ?? SERIES_COLORS[series.indexOf(s) % SERIES_COLORS.length],
    [ladderColorMap, series],
  );
  // Colour-coded peak groups for the plot: all ladders at once, or just the
  // isolated one when a single ladder is selected.
  const plotHighlightGroups = useMemo(() => {
    // Highlighted assigned series take precedence: one coloured group per series,
    // each in its own (or positional) colour. This is what makes "Highlight all
    // series" show the same colours as the split ladders instead of collapsing to pink.
    if (highlightedSeriesIds && highlightedSeriesIds.size > 0) {
      const groups = series
        .filter((s) => highlightedSeriesIds.has(s.id))
        .map((s) => {
          const idx = series.indexOf(s);
          return {
            color:
              s.color ??
              ladderColorMap.get(s.id) ??
              SERIES_COLORS[(idx < 0 ? 0 : idx) % SERIES_COLORS.length],
            ids: new Set(s.members.map((m) => m.peakId)),
          };
        });
      return groups.length ? groups : undefined;
    }
    // Otherwise, the split-series preview ladders (pre-assignment).
    if (!repeatGroups.length) return undefined;
    return repeatGroups
      .map((g, i) => ({ color: SERIES_COLORS[i % SERIES_COLORS.length], ids: new Set(g.peakIds) }))
      .filter((_g, i) => !selectedGroupKey || String(i) === selectedGroupKey);
  }, [highlightedSeriesIds, series, repeatGroups, selectedGroupKey, ladderColorMap]);

  // Peak ids explained by any assigned series (drives the PeakTable "unexplained
  // only" filter and the plot's unexplained-only mode).
  const explainedPeakIds = useMemo(() => explainedPeakIdsHelper(series), [series]);

  // The Series column of the Peak table: which ladders a peak can be hand-assigned
  // to, and which one currently owns it. Confirmed series come first (they are the
  // ones an analyst is filing leftover peaks into); superseded adduct alternatives
  // are excluded, matching every other view. A peak in several ladders shows the
  // first — assignment from the table moves the peak, so this stays single-owner.
  const { assignableSeries, seriesByPeakId } = useMemo(() => {
    const ordered = series
      .filter((s) => !s.supersededBy)
      .slice()
      .sort((a, b) => Number(!!b.endGroupLocked) - Number(!!a.endGroupLocked));
    const list: AssignableSeries[] = ordered.map((s) => ({
      id: s.id,
      label: s.label || `${seriesAdductLabel(s, allAdducts)} · ${s.repeatMass.toFixed(1)} Da`,
      color: colorForSeries(s),
      confirmed: !!s.endGroupLocked,
    }));
    const byPeak = new Map<string, AssignableSeries>();
    ordered.forEach((s, i) => {
      for (const m of s.members) if (!byPeak.has(m.peakId)) byPeak.set(m.peakId, list[i]);
    });
    return { assignableSeries: list, seriesByPeakId: byPeak };
  }, [series, allAdducts, colorForSeries]);


  // Every open document's display spectrum, for the overlay / stacked view modes.
  // Carries the per-document trace styling (color / visible / offset) so the plot
  // and the Documents panel share one source of truth. The active doc keeps its
  // special case: its spectrum is read from the live `processed ?? raw` hooks
  // (which may be newer than `documents[active].state`), while inactive docs are
  // read from their snapshotted state.
  const docSpectra = useMemo<StackSpectrum[]>(() => {
    return documents
      .map((d): StackSpectrum | null => {
        const spectrum = d.id === activeDocId ? processed ?? raw : d.state.processedSpectrum ?? d.state.rawSpectrum;
        return spectrum
          ? { id: d.id, name: d.name, spectrum, color: d.color, visible: d.visible, offset: d.offset }
          : null;
      })
      .filter((x): x is StackSpectrum => x !== null);
  }, [documents, activeDocId, processed, raw]);

  // Other open spectra (excluding the active one) — overlayable in the figure maker.
  const otherFigureSpectra = useMemo(
    () => docSpectra.filter((d) => d.id !== activeDocId),
    [docSpectra, activeDocId],
  );

  // Combine documents: the active doc's LIVE peaks plus each OTHER VISIBLE doc's
  // snapshotted `state.peaks`, flat-merged (peak ids are crypto.randomUUID, so
  // cross-document collisions are impossible) and sorted by m/z. Only computed
  // when the toggle is ON; otherwise the host everywhere uses the live `peaks`
  // hook exactly as before. `peakOwnerMap` keys each pooled peak id to its owning
  // document so the Peak table's Source column and the write-back split can route
  // edits to the right document. Hidden documents are excluded — combining never
  // touches a hidden document's peaks.
  const { pooledPeaks, peakOwnerMap } = useMemo<{
    pooledPeaks: Peak[];
    peakOwnerMap: Map<string, PeakOwner>;
  }>(() => {
    if (!combineDocuments) return { pooledPeaks: [], peakOwnerMap: new Map() };
    const out: Peak[] = [];
    const owners = new Map<string, PeakOwner>();
    for (const d of documents) {
      if (d.visible === false) continue;
      const isOwnerActive = d.id === activeDocId;
      const owner: PeakOwner = { docId: d.id, name: d.name, color: d.color };
      const src = isOwnerActive ? peaks : (d.state.peaks ?? []);
      for (const p of src) {
        out.push(p);
        owners.set(p.id, owner);
      }
    }
    out.sort((a, b) => (a.centroid ?? a.mz) - (b.centroid ?? b.mz));
    return { pooledPeaks: out, peakOwnerMap: owners };
  }, [combineDocuments, documents, activeDocId, peaks]);

  // The peak list the right-hand tabs read: pooled when Combine is on, otherwise
  // the live active-doc peaks (unchanged single-document behaviour).
  const analysisPeaks = combineDocuments ? pooledPeaks : peaks;

  // Merged confirmed-series list for the Series tab when Combine is on: every
  // VISIBLE document's `endGroupLocked` series, each tagged with its owning
  // document so the table can show a Source column. The assign/detect actions
  // stay scoped to the active document (see the hint under the tab), so this
  // merged view is read-only display — editing a series still writes back to the
  // active doc's `series` via the existing handlers.
  const pooledSeries = useMemo(() => {
    if (!combineDocuments) return [];
    const out: { series: Series; owner: PeakOwner }[] = [];
    for (const d of documents) {
      if (d.visible === false) continue;
      const src = d.id === activeDocId ? series : (d.state.series ?? []);
      const owner: PeakOwner = { docId: d.id, name: d.name, color: d.color };
      for (const s of src) {
        if (!s.endGroupLocked) continue;
        out.push({ series: s, owner });
      }
    }
    return out;
  }, [combineDocuments, documents, activeDocId, series]);

  // The flat trace list the plot renders: ALL open documents in document order,
  // active INCLUDED. The plot renders the set of visible documents and does not
  // care which is active; the active trace is emphasised but otherwise just
  // another row. Field names map `StackSpectrum` (optional styling) to the
  // plot's `PlotTrace` (required styling with sensible defaults).
  const plotTraces = useMemo(
    () =>
      docSpectra.map((d) => ({
        id: d.id,
        name: d.name,
        spectrum: d.spectrum,
        color: d.color ?? "#0ea5e9",
        visible: d.visible !== false,
        offset: d.offset ?? 0,
      })),
    [docSpectra],
  );
  // Normalize: ON by default when more than one document is visible (a weak
  // spectrum is invisible under a strong one), OFF for a single document —
  // normalising a lone spectrum would change today's behaviour and the Peak
  // table's intensity numbers (which read the primary, un-normalised). The
  // Documents panel's Normalize switch is the user-facing override; the auto
  // rule re-applies only when the visible-count crosses the 1↔2 boundary, so a
  // manual toggle inside one regime (one vs. many visible docs) sticks until
  // the regime changes. (WP3 §7 + WP4.)
  const visibleDocCount = useMemo(
    () => docSpectra.filter((d) => d.visible !== false).length,
    [docSpectra],
  );
  const [normalize, setNormalize] = useState(false);
  const prevVisibleCountRef = useRef(0);
  useEffect(() => {
    const prev = prevVisibleCountRef.current;
    // Re-apply the auto rule only on a 1↔many crossing; leave the user's manual
    // toggle untouched within the same regime.
    if ((prev <= 1) !== (visibleDocCount <= 1)) {
      setNormalize(visibleDocCount > 1);
    }
    prevVisibleCountRef.current = visibleDocCount;
  }, [visibleDocCount]);

  // Stack: spread the visible traces out with evenly-spaced vertical offsets so
  // they don't overlap. Session-only — NOT in `ProjectState`, `buildState`,
  // `loadState`, or `useMaldiUndo`'s deps (same exclusion rule as the per-
  // document trace styling). Turning ON snapshots every document's current
  // offset into a ref so turning OFF can restore it; the active document is
  // included in the stack order just like any other, so the picture is
  // identical regardless of which document is active. The step is unit-aware:
  // 120 in normalized-% units, or 1.2 × the max intensity across the visible
  // traces in raw-count units (Normalize off).
  const [stacked, setStacked] = useState(false);
  const savedOffsetsRef = useRef<Record<string, number>>({});
  const visibleStackKey = useMemo(
    () => documents.filter((d) => d.visible !== false).map((d) => d.id).join("|"),
    [documents],
  );
  const maxIntensityAcrossVisibleTraces = useMemo(() => {
    let m = 0;
    for (const d of docSpectra) {
      if (d.visible === false) continue;
      const arr = d.spectrum.intensity;
      for (let i = 0; i < arr.length; i += 1) {
        const v = arr[i];
        if (Number.isFinite(v) && v > m) m = v;
      }
    }
    return m;
  }, [docSpectra]);
  const stackStep = useMemo(
    () => (normalize ? 120 : 1.2 * maxIntensityAcrossVisibleTraces),
    [normalize, maxIntensityAcrossVisibleTraces],
  );
  const stackStepRef = useRef(stackStep);
  stackStepRef.current = stackStep;

  // The reference spectrum for Difference mode: the snapshotted display
  // spectrum of the document the user marked "ref" in the Documents panel. Read
  // from `docSpectra` (never `documents[].state.rawSpectrum` directly — that's
  // stale for the active doc by design; see `docSpectra`'s comment). Null when
  // difference mode is off, no reference is set, the reference has no spectrum,
  // or the reference trace is hidden — subtracting a trace the user can't see is
  // confusing, so `MaldiSpectrumPlot` then renders the primary trace unchanged.
  const differenceWith = useMemo<SpectrumData | null>(() => {
    if (!difference || !referenceDocId) return null;
    const ref = docSpectra.find((d) => d.id === referenceDocId);
    if (!ref || ref.visible === false) return null;
    return ref.spectrum ?? null;
  }, [difference, referenceDocId, docSpectra]);

  // If the reference document becomes hidden while Difference mode is active,
  // automatically clear the reference and turn Difference off — silently
  // plotting `active − hidden_trace` would be confusing because the user can no
  // longer see what is being subtracted. This runs whenever the reference doc's
  // visibility flips; the `differenceWith` memo above is a belt-and-suspenders
  // guard so the plot never receives a hidden reference even transiently.
  useEffect(() => {
    if (!referenceDocId) return;
    const refDoc = documents.find((d) => d.id === referenceDocId);
    if (!refDoc || refDoc.visible === false) {
      setReferenceDocId(null);
      setDifference(false);
    }
  }, [referenceDocId, documents]);

  // --- Figure tab state, hoisted to the always-mounted host (WP0a). ----------
  // The Figure tab's TabsContent has no forceMount, so keeping this state inside
  // MaldiFigurePanel meant every tab switch tore it down and discarded the
  // user's in-progress figure (include toggles, styling, scale). The codebase's
  // own convention (FigureDialog.tsx:16-18, ViewExport.tsx:196) is to hold
  // useFigureOptions at the host; MALDI was the lone violator.
  const [figShowProfile, setFigShowProfile] = useState(true);
  const [figShowSticks, setFigShowSticks] = useState(false);
  const [figSelectedOnly, setFigSelectedOnly] = useState(false);
  // Flagged peaks (isotope/shoulder/matrix/salt) are excluded from the figure by
  // default — matches unexplainedPeaks (seriesMatch.ts:16-18) and the PeakTable
  // "unexplained" filter. The switch is a figure-only override (WP0c).
  const [figIncludeFlagged, setFigIncludeFlagged] = useState(false);
  // Figure-only ladder picker + peak deletes (WP6b). Both are figure-local and
  // deliberately kept OUT of the plot's highlight and undo (they're a composition
  // aid, not analysis state): ticking ladders shows only their peaks, and a
  // figure-only delete drops a peak's stick + label while it stays in the Peak
  // table / exports (decision 1). Session-only, so NOT in useMaldiUndo's deps.
  const [figSeriesIds, setFigSeriesIds] = useState<Set<string>>(() => new Set());
  const [figExcludedPeakIds, setFigExcludedPeakIds] = useState<Set<string>>(() => new Set());

  const figHasSelection = (highlightedPeakIds?.size ?? 0) > 0;

  // The confirmed ladders the figure picker offers — the same set the Series tab
  // shows (superseded duplicate readings are hidden). Ticked ones both filter the
  // peaks and drive the per-series stick grouping.
  const figConfirmedSeries = useMemo(() => series.filter((s) => s.endGroupLocked), [series]);
  // Intersect the ticked ids with the still-existing confirmed ladders, so a
  // ladder deleted after being picked can't strand the figure in an empty state.
  const figSelectedSeries = useMemo(
    () => figConfirmedSeries.filter((s) => figSeriesIds.has(s.id)),
    [figConfirmedSeries, figSeriesIds],
  );

  // Peaks that drive the sticks + labels: accepted, not ignored, optionally
  // narrowed to the current selection and/or the picked ladders, with library-
  // flagged peaks excluded by default, and finally minus the figure-only deletes.
  // `figHiddenCount` counts only deletes that would otherwise be visible here, so
  // "N hidden" reflects the current view (and drops stale ids from past re-picks).
  const { figShownPeaks, figHiddenCount } = useMemo(() => {
    const accepted = analysisPeaks.filter((p) => p.accepted !== false && !p.ignored);
    const unflagged = figIncludeFlagged ? accepted : accepted.filter((p) => !p.flag);
    let base = unflagged;
    if (figSelectedOnly && figHasSelection) {
      base = base.filter((p) => highlightedPeakIds!.has(p.id));
    }
    if (figSelectedSeries.length > 0) {
      const inSelected = new Set<string>();
      for (const s of figSelectedSeries) for (const m of s.members) inSelected.add(m.peakId);
      base = base.filter((p) => inSelected.has(p.id));
    }
    const shown =
      figExcludedPeakIds.size > 0 ? base.filter((p) => !figExcludedPeakIds.has(p.id)) : base;
    return { figShownPeaks: shown, figHiddenCount: base.length - shown.length };
  }, [analysisPeaks, figIncludeFlagged, figSelectedOnly, figHasSelection, highlightedPeakIds, figSelectedSeries, figExcludedPeakIds]);

  // Per-series stick groups for the adapter: one per ticked ladder, ordered by
  // precedence so a peak shared by several ladders is claimed by the right one —
  // confirmed first (all are, here) then higher score. Colour comes straight from
  // `colorForSeries` so the figure agrees with the plot stems. Undefined when no
  // ladder is ticked → the adapter emits the single legacy "sticks" series.
  const figSeriesGroups = useMemo<MaldiFigureSeriesGroup[] | undefined>(() => {
    if (figSelectedSeries.length === 0) return undefined;
    return figSelectedSeries
      .slice()
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((s) => ({
        id: s.id,
        label: s.label || seriesAdductLabel(s, allAdducts),
        color: colorForSeries(s),
        peakIds: new Set(s.members.map((m) => m.peakId)),
      }));
  }, [figSelectedSeries, allAdducts, colorForSeries]);

  const reportSeriesColors = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of figConfirmedSeries) {
      const color = colorForSeries(s);
      for (const mem of s.members) m.set(mem.peakId, color);
    }
    return m;
  }, [figConfirmedSeries, colorForSeries]);

  // The figure-engine data: profile traces + optional stick series + m/z labels.
  // Recomputed when the inputs change; the options hook below carries the user's
  // styling across these updates (reconcileFigureOptions). The overlay set is
  // driven by document **visibility** (WP4) — every visible non-active document
  // becomes an extra profile trace, so the screen and the exported figure can't
  // disagree. The Documents panel's per-row checkbox is the single source of
  // truth; the old `includeOthers` switch is gone.
  const figureData = useMemo(() => {
    const activeSpectrum = processed ?? raw;
    const spectra: MaldiFigureSpectrum[] = [];
    if (activeSpectrum) {
      spectra.push({ id: "active", name: sourceName || projectName || "spectrum", spectrum: activeSpectrum });
    }
    spectra.push(...otherFigureSpectra.filter((d) => d.visible !== false).map((d) => ({ id: d.id, name: d.name, spectrum: d.spectrum })));
    return buildMaldiFigureData({
      spectra,
      peaks: figShownPeaks,
      showProfile: figShowProfile,
      showSticks: figShowSticks,
      labelPeaks: true, // label DATA is always supplied; the maker toggles display.
      sourceName: sourceName || projectName,
      seriesGroups: figSeriesGroups,
    });
  }, [processed, raw, sourceName, projectName, otherFigureSpectra, figShownPeaks, figShowProfile, figShowSticks, figSeriesGroups]);

  const [figureOptions, setFigureOptions] = useFigureOptions(figureData);

  // Figure picker + figure-only-delete handlers (WP6b). All mutate figure-local
  // Sets only; none touch analysis state or undo.
  const handleToggleFigureSeries = useCallback((id: string) => {
    setFigSeriesIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const handleFigureDeletePeak = useCallback((id: string) => {
    setFigExcludedPeakIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  const handleFigureRestorePeaks = useCallback(() => setFigExcludedPeakIds(new Set()), []);

  // Verify the compute worker — with retries. A single transient miss (e.g. the
  // Vite dev re-optimization that fires the first time MALDI's worker-only deps
  // are discovered, or a one-off spawn hiccup) must not strand the badge on
  // "unavailable" forever, so we respawn and retry before giving up, and the
  // error badge exposes a manual retry. Each run gets a token so a newer check
  // (or the manual retry) supersedes any older one still in flight.
  const workerCheck = useRef(0);
  const checkWorker = useCallback(async () => {
    const token = (workerCheck.current += 1);
    setWorkerStatus("checking");
    const attempts = 4;
    for (let i = 0; i < attempts; i += 1) {
      try {
        await ping("maldi");
        if (workerCheck.current === token) setWorkerStatus("ready");
        return;
      } catch {
        if (workerCheck.current !== token) return; // superseded by a newer check
        disposeWorker(); // the next ping respawns a fresh worker
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        }
      }
    }
    if (workerCheck.current === token) setWorkerStatus("error");
  }, []);

  // Run the worker check on first mount and load the project list.
  useEffect(() => {
    void checkWorker();
    refreshProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshProjects = useCallback(() => {
    listProjects()
      .then(setProjects)
      .catch(() => {
        /* IndexedDB unavailable; project list stays empty */
      });
  }, []);

  // Re-derive the processed spectrum whenever raw or the step list changes.
  useEffect(() => {
    if (!raw) {
      setProcessed(null);
      return;
    }
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      setProcessingBusy(true);
      process(raw, steps, { signal: controller.signal })
        .then((result) => setProcessed(result.processed))
        .catch((error) => {
          if (!isCancelledError(error)) {
            console.error(error);
            toast.error("Processing failed");
          }
        })
        .finally(() => setProcessingBusy(false));
    }, 200);
    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [raw, steps]);

  const spectrumRange = useMemo(() => {
    if (!raw || raw.mz.length === 0) return null;
    return { min: raw.mz[0], max: raw.mz[raw.mz.length - 1] };
  }, [raw]);

  // Set a single highlight set, clearing any split-series ladder colouring so the
  // two highlight modes never render on top of each other.
  const highlightPeaks = useCallback((ids: Set<string> | undefined) => {
    setRepeatGroups([]);
    setSelectedGroupKey(null);
    setHighlightedSeriesIds(undefined);
    setIsolateSelection(false); // series/end-group handlers re-enable after this
    setHighlightedPeakIds(ids);
  }, []);

  const resetDownstream = useCallback(() => {
    setPeaks([]);
    setSeries([]);
    setRepeatCandidates([]);
    setCopolymerSeries([]);
    setRepeatMass(0);
    setRepeatMasses([]);
    setEndGroupMass(0);
    setOverlay(null);
    setHighlightedPeakIds(undefined);
    setRepeatGroups([]);
    setSelectedGroupKey(null);
    setSelectedSeriesId(null);
    setIsolateSelection(false);
    setSelectedCopolymerId(null);
  }, []);

  // --- Document (open-spectrum) model -----------------------------------------
  // Each open spectrum keeps its own analysis. The active document lives in the
  // hooks above; inactive ones are snapshotted into `documents`.
  const buildState = useCallback((): ProjectState => {
    const state = emptyProjectState(sourceName);
    state.rawSpectrum = raw;
    state.processedSpectrum = processed;
    state.processing = steps;
    state.peaks = peaks;
    state.adducts = customAdducts;
    state.series = series;
    state.selectedAdductIds = selectedAdductIds;
    state.pickParams = pickParams;
    state.repeatMass = repeatMass;
    state.repeatMasses = repeatMasses;
    state.endGroupMass = endGroupMass;
    state.repeatIsotopeAware = repeatIsotopeAware;
    state.copolymerA = copolymerA;
    state.copolymerB = copolymerB;
    state.exportHistory = exportHistory;
    return state;
  }, [sourceName, raw, processed, steps, peaks, customAdducts, series, selectedAdductIds, pickParams, repeatMass, repeatMasses, endGroupMass, repeatIsotopeAware, copolymerA, copolymerB, exportHistory]);

  const loadState = useCallback((s: ProjectState) => {
    setSourceName(s.sourceName);
    setRaw(s.rawSpectrum);
    setProcessed(s.processedSpectrum);
    setSteps(s.processing);
    setPeaks(s.peaks);
    setCustomAdducts(s.adducts ?? []);
    setSeries(s.series ?? []);
    setSelectedAdductIds(s.selectedAdductIds ?? ["H", "Na", "K"]);
    setPickParams(s.pickParams ?? { ...PEAK_PRESETS.conservative });
    setRepeatMass(s.repeatMass ?? 0);
    // Projects saved before multi-repeat support have no list — the single active
    // repeat unit is then the whole list.
    setRepeatMasses(s.repeatMasses ?? (s.repeatMass && s.repeatMass > 0 ? [s.repeatMass] : []));
    setEndGroupMass(s.endGroupMass ?? 0);
    setRepeatIsotopeAware(s.repeatIsotopeAware ?? true);
    setCopolymerA(s.copolymerA ?? 0);
    setCopolymerB(s.copolymerB ?? 0);
    setExportHistory(s.exportHistory ?? []);
    setRepeatCandidates([]);
    setCopolymerSeries([]);
    setOverlay(null);
    setHighlightedPeakIds(undefined);
    setHighlightedSeriesIds(undefined);
    setRepeatGroups([]);
    setSelectedGroupKey(null);
    setSelectedSeriesId(null);
    setIsolateSelection(false);
    setSelectedCopolymerId(null);
    setParseMeta(null);
    setFigSeriesIds(new Set());
    setFigExcludedPeakIds(new Set());
  }, []);

  const snapshotActiveDoc = useCallback((): MaldiDocument | null => {
    if (!activeDocId) return null;
    // Preserve the document's session-only trace styling (colour/visibility/offset)
    // across the snapshot — those fields are not part of ProjectState and must
    // survive the round-trip through `documents[].state` unchanged.
    const existing = documents.find((d) => d.id === activeDocId);
    let color = existing?.color;
    if (!color) {
      color = nextDocColor(docsCreatedCountRef.current);
      docsCreatedCountRef.current += 1;
    }
    return {
      id: activeDocId,
      name: projectName,
      projectId,
      createdAt: projectCreatedAt.current,
      state: buildState(),
      color,
      visible: existing?.visible ?? true,
      offset: existing?.offset ?? 0,
    };
  }, [activeDocId, documents, projectName, projectId, buildState]);

  const clearLive = useCallback(() => {
    setProjectId(null);
    setProjectName("Untitled MALDI project");
    projectCreatedAt.current = Date.now();
    setSourceName("");
    setParseMeta(null);
    setRaw(null);
    setProcessed(null);
    setSteps([]);
    setCustomAdducts([]);
    setSelectedAdductIds(["H", "Na", "K"]);
    setExportHistory([]);
    resetDownstream();
  }, [resetDownstream]);

  // Open one or more imported spectra as brand-new documents (carrying over the
  // current processing pipeline + adduct selection as a sensible starting point).
  // IMPORTANT: this cannot be implemented as a loop over a single-file "apply one"
  // helper, because that helper would close over `snapshotActiveDoc()` — which
  // captures `buildState`'s ~15 `useCallback` deps. A synchronous loop would
  // snapshot the outgoing doc with the pre-flush state on every iteration after
  // the first (the setDocuments updates haven't committed yet), so subsequent
  // snapshots would either drop or cross-contaminate documents. Instead we
  // snapshot the outgoing active doc exactly once, append all new documents in a
  // single `setDocuments` update, and make the LAST imported one active. The
  // per-file read + extension-dispatch mirrors BatchPanel's sequential loop.
  const applySpectra = useCallback(
    (items: { spectrum: SpectrumData; fileName: string; meta: ParseMeta | null }[]) => {
      if (items.length === 0) return;
      const snap = snapshotActiveDoc();
      const createdAt = Date.now();
      // Mint ids + colours up front from the monotonically increasing
      // `docsCreatedCountRef` (never decremented on close), so all new documents
      // get distinct palette entries and closing a document can't make a later
      // import reuse a colour still held by an open doc.
      const startCount = docsCreatedCountRef.current;
      const newDocs = items.map((it, i) => ({
        id: crypto.randomUUID(),
        name: it.fileName.replace(/\.[^.]+$/, ""),
        projectId: null as string | null,
        createdAt,
        state: {
          ...emptyProjectState(it.fileName),
          rawSpectrum: it.spectrum,
          processing: [defaultBaselineStep()],
          selectedAdductIds,
          pickParams,
        },
        visible: true,
        offset: 0,
        color: nextDocColor(startCount + i),
      }));
      docsCreatedCountRef.current = startCount + newDocs.length;
      const last = items[items.length - 1];
      const lastDocId = newDocs[newDocs.length - 1].id;
      setDocuments((prev) => {
        const saved = snap ? prev.map((d) => (d.id === snap.id ? snap : d)) : prev;
        return [...saved, ...newDocs];
      });
      // Reset the live hooks to the LAST imported spectrum.
      resetDownstream();
      setRaw(last.spectrum);
      setProcessed(null);
      // Auto-baseline every newly imported spectrum (reversible in Processing).
      setSteps([defaultBaselineStep()]);
      setParseMeta(last.meta);
      setSourceName(last.fileName);
      setProjectId(null);
      projectCreatedAt.current = createdAt;
      setProjectName(last.fileName.replace(/\.[^.]+$/, ""));
      setActiveDocId(lastDocId);
      // `viewMode` was deleted in WP4 — both documents stay visible and overlay
      // on the single always-mounted plot; the newest becomes active.
    },
    [snapshotActiveDoc, resetDownstream, pickParams, selectedAdductIds],
  );

  // --- Import -----------------------------------------------------------------
  // Multi-file import. Reads each file sequentially (CSV/TXT via `parse`, mzML/
  // mzXML/MGF via `parseMs` — the same extension dispatch BatchPanel uses), then
  // hands the whole batch to `applySpectra` in one shot. A naive per-file loop
  // that snapshotted + setDocuments'd on each iteration would re-snapshot the
  // outgoing doc before React had flushed the previous update, dropping or
  // cross-contaminating documents (see `applySpectra`).
  const handleImportFiles = useCallback(
    async (files: FileList | File[], options: Parameters<typeof parse>[1]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      setParsing(true);
      try {
        const items: { spectrum: SpectrumData; fileName: string; meta: ParseMeta | null }[] = [];
        let lastError: Error | null = null;
        for (const file of list) {
          try {
            if (/\.(mzml|mzxml|mgf)$/i.test(file.name)) {
              const buffer = await file.arrayBuffer();
              const result = await parseMs(buffer, file.name);
              items.push({ spectrum: result.spectrum, fileName: file.name, meta: null });
            } else {
              const text = await file.text();
              const result = await parse(text, options);
              items.push({ spectrum: result.spectrum, fileName: file.name, meta: result.meta });
            }
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.error(error);
            // Continue with the rest so one bad file in a multi-file drop doesn't
            // discard the others; surface the failure as a toast at the end.
            toast.error(`${file.name}: ${lastError.message}`);
          }
        }
        if (items.length > 0) {
          applySpectra(items);
          const points = items.reduce((sum, it) => sum + it.spectrum.mz.length, 0);
          toast.success(
            `Imported ${items.length} ${items.length === 1 ? "spectrum" : "spectra"} · ${points.toLocaleString()} points${lastError ? " (some files failed — see console)" : ""}`,
          );
        }
      } finally {
        setParsing(false);
      }
    },
    [applySpectra],
  );

  // --- Global drag-and-drop import ------------------------------------------
  // Drop a spectrum file ANYWHERE on the page (not just the import box). A window
  // listener handles drops that a dedicated drop zone (the import box) did not
  // already handle — those call preventDefault, so we skip them here via
  // `defaultPrevented` to avoid a double import.
  const [pageDragActive, setPageDragActive] = useState(false);
  const dragDepth = useRef(0);

  const importDroppedFile = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      // The global drop handler dispatches every dropped file in one batch so a
      // multi-file drop opens them all as documents in a single `applySpectra`
      // update (rather than snapshotting the active doc once per file, which
      // would cross-contaminate the outgoing state — see `applySpectra`).
      void handleImportFiles(files, { delimiter: "auto", hasHeader: "auto" });
    },
    [handleImportFiles],
  );

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current += 1;
      setPageDragActive(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // mark the window as a valid drop target
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setPageDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      dragDepth.current = 0;
      setPageDragActive(false);
      if (e.defaultPrevented) return; // a dedicated drop zone already handled it
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      importDroppedFile(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [importDroppedFile]);

  // --- Peak picking -----------------------------------------------------------
  const handlePick = useCallback(async () => {
    const target = processed ?? raw;
    if (!target) return;
    setPicking(true);
    try {
      const result = await pickPeaks(target, pickParams);
      setSeries([]);
      setCopolymerSeries([]);
      setSelectedSeriesId(null);
      highlightPeaks(undefined);
      const flagged = await flagBackground(result.peaks, { preserveExisting: true });
      setPeaks(flagged.peaks);
      const bg = Object.values(flagged.counts).reduce((a, b) => a + b, 0);
      const mono = pickParams.monoisotopicOnly ? " · monoisotopic only" : "";
      toast.success(
        `Picked ${result.peaks.length} peaks${bg ? ` · flagged ${bg} background` : ""}${mono}`,
      );
    } catch (error) {
      if (!isCancelledError(error)) {
        console.error(error);
        toast.error("Peak picking failed");
      }
    } finally {
      setPicking(false);
    }
  }, [processed, raw, pickParams, highlightPeaks]);

  // Manual peak picking from the plot: add at a clicked apex, or remove a peak.
  const handleAddPeak = useCallback((mz: number, intensity: number) => {
    setPeaks((prev) => {
      // Ignore a click that lands on an existing peak (≈ same m/z).
      if (prev.some((p) => Math.abs((p.centroid ?? p.mz) - mz) < 1e-6)) return prev;
      return [...prev, manualPeak(mz, intensity)].sort(
        (a, b) => (a.centroid ?? a.mz) - (b.centroid ?? b.mz),
      );
    });
  }, []);

  const handleRemovePeak = useCallback((id: string) => {
    setPeaks((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // --- Repeat / series / end-groups ------------------------------------------
  const runDetectRepeats = useCallback(
    async (isotopeAware: boolean) => {
      setDetecting(true);
      try {
        const result = await detectRepeatUnits(peaks, { isotopeAware });
        setRepeatCandidates(result.candidates);
        if (result.candidates.length > 0) {
          const top = Number(result.candidates[0].repeatMass.toFixed(4));
          setRepeatMass((current) => (current > 0 ? current : top));
        }
        toast.success(`${result.candidates.length} candidate repeat units`);
      } catch (error) {
        console.error(error);
        toast.error("Repeat detection failed");
      } finally {
        setDetecting(false);
      }
    },
    [peaks],
  );

  const handleDetectRepeats = useCallback(
    () => runDetectRepeats(repeatIsotopeAware),
    [runDetectRepeats, repeatIsotopeAware],
  );

  // Toggle isotope-aware merging and immediately re-detect (with the new flag) so
  // the candidate list reflects the choice without a second click.
  const handleToggleIsotopeAware = useCallback(
    (on: boolean) => {
      setRepeatIsotopeAware(on);
      if (peaks.length >= 3) void runDetectRepeats(on);
    },
    [peaks, runDetectRepeats],
  );

  // Preview the peaks that fit a repeat unit, always broken into its distinct
  // interleaved ladders (each its own colour). Falls back to one lumped highlight
  // when the repeat produces no clean multi-member ladders.
  const previewRepeat = useCallback(
    (mass: number) => {
      setSelectedSeriesId(null);
      setSelectedGroupKey(null);
      const groups = seriesForRepeat(peaks, mass);
      setRepeatGroups(groups);
      if (groups.length) {
        setHighlightedPeakIds(undefined); // colours come from the groups instead
        return;
      }
      const ids = peaksForRepeat(peaks, mass);
      setHighlightedPeakIds(ids.size ? ids : undefined);
    },
    [peaks],
  );

  // Click a candidate repeat unit: adopt it and preview its series.
  const handleSelectRepeatCandidate = useCallback(
    (mass: number) => {
      setRepeatMass(mass);
      previewRepeat(mass);
    },
    [previewRepeat],
  );

  // Typing a known repeat unit: adopt it and live-preview its ladder, so the user
  // can enter their expected repeat mass and immediately see (and then Assign /
  // Solve against) the peaks it explains.
  const handleRepeatMassChange = useCallback(
    (mass: number) => {
      setRepeatMass(mass);
      if (mass > 0) previewRepeat(mass);
      else highlightPeaks(undefined);
    },
    [previewRepeat, highlightPeaks],
  );

  // Click a ladder: isolate it (click again to show all ladders together).
  const handleSelectGroup = useCallback((key: string) => {
    setSelectedGroupKey((cur) => (cur === key ? null : key));
  }, []);

  // Fold a freshly-assigned batch into the existing series list. Assigning one
  // repeat unit must not wipe the work done on the others — a sample with two
  // polymers is assigned one repeat unit at a time — so only the *pending* series
  // built from the SAME repeat unit are replaced. Confirmed series survive, as do
  // the superseded adduct alternatives that belong to a confirmed series (deleting
  // the confirmed one is what restores those).
  const mergeAssigned = useCallback((prev: Series[], mass: number, assigned: Series[]): Series[] => {
    const confirmedIds = new Set(prev.filter((s) => s.endGroupLocked).map((s) => s.id));
    const kept = prev.filter(
      (s) =>
        s.endGroupLocked ||
        (s.supersededBy != null && confirmedIds.has(s.supersededBy)) ||
        !sameRepeat(s.repeatMass, mass),
    );
    return [...kept, ...assigned];
  }, []);

  const handleAssignSeries = useCallback(async () => {
    setAssigning(true);
    try {
      const result = await assignSeries(peaks, repeatMass, selectedAdducts);
      setSeries((prev) => mergeAssigned(prev, repeatMass, result.series));
      setRepeatMasses((prev) => (prev.some((m) => sameRepeat(m, repeatMass)) ? prev : [...prev, repeatMass]));
      toast.success(`Assigned ${result.series.length} series at ${repeatMass.toFixed(3)} Da`);
    } catch (error) {
      console.error(error);
      toast.error("Series assignment failed");
    } finally {
      setAssigning(false);
    }
  }, [peaks, repeatMass, selectedAdducts, mergeAssigned]);

  // Assign every kept repeat unit in one pass — the one-click path for a sample
  // with two polymers once both repeat units are in the list.
  const handleAssignAllRepeats = useCallback(async () => {
    const masses = repeatMasses.filter((m) => m > 0);
    if (masses.length === 0) return;
    setAssigning(true);
    try {
      let total = 0;
      for (const mass of masses) {
        const result = await assignSeries(peaks, mass, selectedAdducts);
        total += result.series.length;
        setSeries((prev) => mergeAssigned(prev, mass, result.series));
      }
      toast.success(`Assigned ${total} series across ${masses.length} repeat units`);
    } catch (error) {
      console.error(error);
      toast.error("Series assignment failed");
    } finally {
      setAssigning(false);
    }
  }, [peaks, repeatMasses, selectedAdducts, mergeAssigned]);

  const handleAddRepeatMass = useCallback((mass: number) => {
    if (!(mass > 0)) return;
    setRepeatMasses((prev) => (prev.some((m) => sameRepeat(m, mass)) ? prev : [...prev, mass]));
  }, []);

  // Drop a repeat unit from the list. Series already built from it are deliberately
  // left alone — the list is the set of repeat units in play, not an owner of the
  // assignments (delete a series from the Series table to remove it).
  const handleRemoveRepeatMass = useCallback((mass: number) => {
    setRepeatMasses((prev) => prev.filter((m) => !sameRepeat(m, mass)));
  }, []);



  const handleDetectCopolymer = useCallback(
    async (a: number, b: number) => {
      setDetectingCopolymer(true);
      try {
        const result = await detectCopolymer(peaks, selectedAdducts, {
          repeatA: a > 0 ? a : undefined,
          repeatB: b > 0 ? b : undefined,
        });
        setCopolymerSeries(result.series);
        if (result.series[0]) {
          setCopolymerA(Number(result.series[0].repeatA.toFixed(4)));
          setCopolymerB(Number(result.series[0].repeatB.toFixed(4)));
        }
        toast.success(`${result.series.length} copolymer families`);
      } catch (error) {
        console.error(error);
        toast.error("Copolymer detection failed");
      } finally {
        setDetectingCopolymer(false);
      }
    },
    [peaks, selectedAdducts],
  );

  const handleSelectSeries = useCallback((s: Series | null) => {
    setSelectedSeriesId(s?.id ?? null);
    setSelectedCopolymerId(null);
    if (s) {
      // Emphasise this series as a coloured group (keeps its colour, no pink collapse)
      // and isolate it so the ladder stands alone. The flat highlight set is also
      // populated as a safety net + so the mol-weight panel follows the selection.
      setHighlightedPeakIds(new Set(s.members.map((m) => m.peakId)));
      setHighlightedSeriesIds(new Set([s.id]));
      setIsolateSelection(true);
    } else {
      setHighlightedSeriesIds(undefined);
      setHighlightedPeakIds(undefined);
      setIsolateSelection(false);
    }
  }, []);

  // Manual ladder editing: click a peak in the plot to add/remove it from the
  // selected series. The end group (Y-intercept), error and score are re-fit live,
  // and the highlight follows the new membership.
  const handleToggleSeriesMember = useCallback(
    (peakId: string) => {
      if (!selectedSeriesId) return;
      const s = series.find((x) => x.id === selectedSeriesId);
      if (!s) return;
      const has = s.members.some((m) => m.peakId === peakId);
      const ids = has
        ? s.members.filter((m) => m.peakId !== peakId).map((m) => m.peakId)
        : [...s.members.map((m) => m.peakId), peakId];
      const fit = fitLadder(peaks, ids, s.repeatMass, adductById(allAdducts, s.adductId));
      const members = fit?.members ?? [];
      setSeries((prev) =>
        prev.map((x) =>
          x.id === s.id
            ? {
                ...x,
                members,
                endGroupMass: x.endGroupLocked ? x.endGroupMass : (fit?.endGroupMass ?? x.endGroupMass),
                meanErrorDa: fit?.meanErrorDa ?? x.meanErrorDa,
                score: fit?.score ?? 0,
                r2: fit?.r2 ?? x.r2,
              }
            : x,
        ),
      );
      // The selected series is already in highlightedSeriesIds, so the coloured
      // group refreshes from the updated series state — no flat-pink override needed.
    },
    [selectedSeriesId, series, peaks, allAdducts],
  );

  // Re-fit one series around an explicit member set, preserving a locked end group.
  // Shared by every membership edit (hand-assignment from the Peak table, combine,
  // split) so n, end group, error, R² and score always describe the current ladder.
  const refitSeries = useCallback(
    (s: Series, peakIds: string[]): Series => {
      const fit = fitLadder(peaks, peakIds, s.repeatMass, adductById(allAdducts, s.adductId));
      return {
        ...s,
        members: fit?.members ?? [],
        endGroupMass: s.endGroupLocked ? s.endGroupMass : fit?.endGroupMass ?? s.endGroupMass,
        meanErrorDa: fit?.meanErrorDa ?? s.meanErrorDa,
        score: fit?.score ?? 0,
        r2: fit?.r2 ?? s.r2,
      };
    },
    [peaks, allAdducts],
  );

  // Hand-assign peaks to a ladder from the Peak table. The automatic assignment
  // links peaks by spacing, so a lone oligomer at the high-mass end with no
  // neighbour a repeat away is left unexplained however obviously it belongs — this
  // is the manual override. The peak MOVES: it is dropped from any other visible
  // series first, so the table's Series column stays a single-owner picker.
  // Superseded series (the hidden adduct alternatives of a confirmed one) are left
  // untouched, so deleting the confirmed series still restores them intact.
  const handleAddPeaksToSeries = useCallback(
    (seriesId: string, peakIds: string[]) => {
      const add = new Set(peakIds);
      if (add.size === 0) return;
      setSeries((prev) =>
        prev.map((s) => {
          if (s.supersededBy) return s;
          if (s.id === seriesId) {
            const ids = new Set(s.members.map((m) => m.peakId));
            const before = ids.size;
            for (const id of add) ids.add(id);
            return ids.size === before ? s : refitSeries(s, [...ids]);
          }
          if (!s.members.some((m) => add.has(m.peakId))) return s;
          return refitSeries(s, s.members.filter((m) => !add.has(m.peakId)).map((m) => m.peakId));
        }),
      );
      const target = series.find((s) => s.id === seriesId);
      toast.success(
        `Added ${add.size} ${add.size === 1 ? "peak" : "peaks"} to ${target?.label || (target ? seriesAdductLabel(target, allAdducts) : "series")}`,
      );
    },
    [refitSeries, series, allAdducts],
  );

  const handleRemovePeaksFromSeries = useCallback(
    (peakIds: string[]) => {
      const drop = new Set(peakIds);
      if (drop.size === 0) return;
      setSeries((prev) =>
        prev.map((s) => {
          if (s.supersededBy) return s;
          if (!s.members.some((m) => drop.has(m.peakId))) return s;
          return refitSeries(s, s.members.filter((m) => !drop.has(m.peakId)).map((m) => m.peakId));
        }),
      );
      toast.success(`Removed ${drop.size} ${drop.size === 1 ? "peak" : "peaks"} from its series`);
    },
    [refitSeries],
  );

  // Force several series into one ladder. Instrument calibration can drift the
  // spacing enough that the automatic assignment splits one polymer in two; this
  // says "these are the same series". The pre-merge series are kept on the result's
  // `mergedFrom` so `handleSplitSeries` can undo it.
  const handleCombineSeries = useCallback(
    (ids: string[]) => {
      const wanted = new Set(ids);
      const group = series.filter((s) => wanted.has(s.id));
      if (group.length < 2) return;
      const merged = mergeSeriesGroup(group, peaks, allAdducts);
      if (!merged) {
        toast.error("Could not combine those series");
        return;
      }
      const absorbed = new Set(group.map((s) => s.id).filter((id) => id !== merged.id));
      setSeries((prev) =>
        prev
          .filter((s) => !absorbed.has(s.id))
          .map((s) => {
            if (s.id === merged.id) return merged;
            // Re-point any hidden alternative whose superseding series was absorbed.
            if (s.supersededBy && absorbed.has(s.supersededBy)) return { ...s, supersededBy: merged.id };
            return s;
          }),
      );
      setSelectedSeriesId(null);
      setHighlightedSeriesIds(undefined);
      setHighlightedPeakIds(undefined);
      setIsolateSelection(false);
      toast.success(`Combined ${group.length} series into one ladder`);
    },
    [series, peaks, allAdducts],
  );

  // Undo a forced combine. The series that led the merge keeps the row (and the
  // naming / confirmed state the user gave it); the absorbed ones go back to the
  // pending list exactly as they were before the merge.
  const handleSplitSeries = useCallback(
    (id: string) => {
      const target = series.find((s) => s.id === id);
      if (!target) return;
      const restored = splitMergedSeries(target);
      if (!restored) return;
      const parts = restored.map((p) =>
        p.id === target.id
          ? {
              ...p,
              label: target.label,
              description: target.description,
              color: target.color,
              endGroupLabel: target.endGroupLabel,
              endGroupLocked: target.endGroupLocked,
              endGroupMass: target.endGroupLocked ? target.endGroupMass : p.endGroupMass,
            }
          : p,
      );
      setSeries((prev) => prev.flatMap((s) => (s.id === id ? parts : [s])));
      setSelectedSeriesId((cur) => (cur === id ? null : cur));
      setHighlightedSeriesIds(undefined);
      setHighlightedPeakIds(undefined);
      setIsolateSelection(false);
      toast.success(`Split back into ${parts.length} series`);
    },
    [series],
  );

  const handleHighlightAllSeries = useCallback(
    (all: boolean) => {
      setSelectedSeriesId(null);
      setSelectedCopolymerId(null);
      const active = series.filter((s) => !s.supersededBy);
      if (!all || active.length === 0) {
        setHighlightedSeriesIds(undefined);
        setHighlightedPeakIds(undefined);
        setIsolateSelection(false);
        return;
      }
      // Every visible series as its own coloured group, all shown together. The flat
      // highlight union is also set as a safety net + for the mol-weight panel.
      const ids = new Set<string>();
      for (const s of active) for (const m of s.members) ids.add(m.peakId);
      setHighlightedPeakIds(ids.size ? ids : undefined);
      setHighlightedSeriesIds(new Set(active.map((s) => s.id)));
      setIsolateSelection(false);
    },
    [series],
  );

  // --- Series annotation (label / description / colour / end group) ----------
  const handleRenameSeries = useCallback((id: string, label: string) => {
    setSeries((prev) => prev.map((s) => (s.id === id ? { ...s, label } : s)));
  }, []);

  const handleSetSeriesDescription = useCallback((id: string, description: string) => {
    setSeries((prev) => prev.map((s) => (s.id === id ? { ...s, description: description || undefined } : s)));
  }, []);

  const handleSetSeriesColor = useCallback((id: string, color: string) => {
    setSeries((prev) => prev.map((s) => (s.id === id ? { ...s, color: color || undefined } : s)));
  }, []);

  const handleSetSeriesEndGroupLabel = useCallback((id: string, endGroupLabel: string) => {
    setSeries((prev) => prev.map((s) => (s.id === id ? { ...s, endGroupLabel: endGroupLabel || undefined, endGroupLocked: true } : s)));
  }, []);

  const handleSetSeriesEndGroupMass = useCallback((id: string, mass: number) => {
    setSeries((prev) => prev.map((s) => (s.id === id ? { ...s, endGroupMass: mass, endGroupLocked: true } : s)));
  }, []);

  // Remove a confirmed series from the Series table. This un-confirms it (it returns
  // to the pending list) and restores the same-peak adduct alternatives that were
  // hidden when it was assigned — "delete puts everything back".
  const handleDeleteSeries = useCallback((id: string) => {
    setSeries((prev) =>
      prev.map((s) => {
        if (s.id === id) return { ...s, endGroupLocked: false };
        if (s.supersededBy === id) return { ...s, supersededBy: undefined };
        return s;
      }),
    );
    setSelectedSeriesId((cur) => (cur === id ? null : cur));
    const wasHighlighted = highlightedSeriesIds?.has(id) || selectedSeriesId === id;
    setHighlightedSeriesIds((cur) => {
      if (!cur || !cur.has(id)) return cur;
      const next = new Set(cur);
      next.delete(id);
      return next.size ? next : undefined;
    });
    if (wasHighlighted) {
      setHighlightedPeakIds(undefined);
      setIsolateSelection(false);
    }
  }, [highlightedSeriesIds, selectedSeriesId]);

  // Confirm a pending series into the Series table. Its same-peak adduct alternatives
  // (the other [M+H]/[M+Na]/... readings of the same ladder) are marked superseded so
  // they drop out of the pending list; deleting the confirmed series restores them.
  const handleAssignSeriesToTable = useCallback(
    (id: string) => {
      const target = series.find((s) => s.id === id);
      if (!target) return;
      const pinnedColor = target.color ?? colorForSeries(target);
      const siblingIds = new Set(sameLadderSiblings(series, target).map((s) => s.id));
      setSeries((prev) =>
        prev.map((s) => {
          if (s.id === target.id) return { ...s, endGroupLocked: true, color: s.color ?? pinnedColor };
          if (siblingIds.has(s.id)) return { ...s, supersededBy: target.id };
          return s;
        }),
      );
      setSelectedSeriesId(null);
      setHighlightedSeriesIds(undefined);
      setHighlightedPeakIds(undefined);
      setIsolateSelection(false);
      toast.success("Series moved to the Series table");
    },
    [series, colorForSeries],
  );

  const handleSelectCopolymer = useCallback((s: CopolymerSeries | null) => {
    setSelectedCopolymerId(s?.id ?? null);
    setSelectedSeriesId(null);
    highlightPeaks(s ? new Set(s.members.map((m) => m.peakId)) : undefined);
  }, [highlightPeaks]);

  const handleApplyTemplate = useCallback(
    (t: ChemistryTemplate) => {
      const mass = Number(t.repeatMass.toFixed(4));
      setRepeatMass(mass);
      handleAddRepeatMass(mass);
      if (t.endGroupMass != null) setEndGroupMass(t.endGroupMass);
      const valid = t.adductIds.filter((id) => allAdducts.some((a) => a.id === id));
      if (valid.length) setSelectedAdductIds(valid);
      toast.success(`Applied template: ${t.name}`);
    },
    [allAdducts, handleAddRepeatMass],
  );

  // --- Document trace styling (colour / visibility / offset) -------------------
  // Patch a document's session-only trace styling. Deliberately NOT a snapshot
  // op: this state is excluded from `useMaldiUndo`'s deps so hiding or recolouring
  // a trace doesn't enter the undo history (Ctrl+Z after hiding a trace would
  // otherwise undo an unrelated analysis edit). The active doc's `visible` is
  // forced true — active-but-hidden is a confusing dead state (the plot, peak
  // table and every right-hand tab would describe a spectrum the user can't see).
  const handleUpdateDocument = useCallback(
    (id: string, patch: Partial<MaldiDocument>) => {
      setDocuments((prev) =>
        prev.map((d) => {
          if (d.id !== id) return d;
          const next = { ...d, ...patch };
          if (id === activeDocId && patch.visible === false) next.visible = true;
          return next;
        }),
      );
    },
    [activeDocId],
  );

  // Peak-table write-back. In pooled (Combine documents) mode the table emits the
  // whole merged `Peak[]`; we split it by `peakOwnerMap` and route each subset to
  // its owning document. Peaks owned by the active doc (and any peak with no owner
  // — e.g. a freshly added row) go through the existing `setPeaks` path unchanged;
  // peaks owned by another VISIBLE document patch that document's snapshotted
  // `state.peaks` via `handleUpdateDocument`. Hidden documents never appear in
  // `peakOwnerMap` (pooledPeaks excludes them), so a hidden doc's peak list can't
  // be clobbered here. Deletions fall out as absence from the emitted array. When
  // the toggle is off this is a passthrough to `setPeaks` — identical to today.
  const handlePeakTableChange = useCallback(
    (next: Peak[]) => {
      if (!combineDocuments) {
        setPeaks(next);
        return;
      }
      const activeSubset: Peak[] = [];
      const byDoc = new Map<string, Peak[]>();
      for (const p of next) {
        const owner = peakOwnerMap.get(p.id);
        if (!owner || owner.docId === activeDocId) {
          activeSubset.push(p);
        } else {
          const list = byDoc.get(owner.docId);
          if (list) list.push(p);
          else byDoc.set(owner.docId, [p]);
        }
      }
      setPeaks(activeSubset);
      for (const [docId, subset] of byDoc) {
        const doc = documents.find((d) => d.id === docId);
        if (!doc) continue;
        handleUpdateDocument(docId, { state: { ...doc.state, peaks: subset } });
      }
    },
    [combineDocuments, peakOwnerMap, activeDocId, documents, handleUpdateDocument],
  );

  // Stack toggle. ON: save every document's current offset, then assign
  // `index * step` walking the VISIBLE documents in document order (active
  // included, treated no differently). OFF: restore each saved offset,
  // defaulting to 0 for any document with no saved value (e.g. imported while
  // stacked). The manual per-row offset input keeps working: typing a value
  // while stacked overrides that one row and this handler does not fight it.
  const handleStackedChange = useCallback(
    (on: boolean) => {
      if (on) {
        const saved: Record<string, number> = {};
        for (const d of documents) saved[d.id] = d.offset ?? 0;
        savedOffsetsRef.current = saved;
        const step = stackStepRef.current;
        let i = 0;
        for (const d of documents) {
          if (d.visible === false) continue;
          handleUpdateDocument(d.id, { offset: i * step });
          i += 1;
        }
      } else {
        const saved = savedOffsetsRef.current;
        for (const d of documents) {
          handleUpdateDocument(d.id, { offset: saved[d.id] ?? 0 });
        }
        savedOffsetsRef.current = {};
      }
      setStacked(on);
    },
    [documents, handleUpdateDocument],
  );

  // While stacked, re-apply evenly-spaced offsets whenever the visible set
  // changes (show/hide, import, close) or Normalize toggles, so the stack stays
  // evenly spaced with no gaps. A manual per-row offset edit does NOT change the
  // visible set, so this effect leaves it alone — the user's override stands
  // until the visible set next changes.
  useEffect(() => {
    if (!stacked) return;
    const step = stackStepRef.current;
    let i = 0;
    for (const d of documents) {
      if (d.visible === false) continue;
      handleUpdateDocument(d.id, { offset: i * step });
      i += 1;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleStackKey, stacked, normalize]);

  // --- Undo / redo (per-spectrum) ---------------------------------------------
  const getUndoSnapshot = useCallback((): UndoSnapshot => {
    const state = buildState();
    state.processedSpectrum = null; // re-derived after restore
    state.exportHistory = []; // append-only log: excluded from undo
    return { state, projectName };
  }, [buildState, projectName]);

  const restoreUndoSnapshot = useCallback(
    (snap: UndoSnapshot) => {
      loadState(snap.state);
      setProjectName(snap.projectName);
      setExportHistory(exportHistoryRef.current);
    },
    [loadState],
  );

  const { clearHistory, clearAll } = useMaldiUndo({
    activeDocId,
    deps: [
      projectName, sourceName, peaks, series, steps, customAdducts, selectedAdductIds,
      pickParams, repeatMass, repeatMasses, endGroupMass, repeatIsotopeAware,
      copolymerA, copolymerB, raw,
    ],
    getSnapshot: getUndoSnapshot,
    restore: restoreUndoSnapshot,
  });

  // --- Persistence + document switching ---------------------------------------
  const switchToDoc = useCallback(
    (id: string) => {
      if (id === activeDocId) return;
      const target = documents.find((d) => d.id === id);
      if (!target) return;
      if (target.state.rawSpectrum == null) {
        toast.error("That document has no spectrum data.");
        return;
      }
      const snap = snapshotActiveDoc();
      const unhideTarget = target.visible === false;
      if (snap || unhideTarget) {
        setDocuments((prev) =>
          prev.map((d) => {
            if (snap && d.id === snap.id) return snap;
            if (unhideTarget && d.id === id) return { ...d, visible: true };
            return d;
          }),
        );
      }
      loadState(target.state);
      setProjectName(target.name);
      setProjectId(target.projectId);
      projectCreatedAt.current = target.createdAt;
      setActiveDocId(id);
    },
    [activeDocId, documents, snapshotActiveDoc, loadState],
  );

  const closeDoc = useCallback(
    (id: string) => {
      const remaining = documents.filter((d) => d.id !== id);
      if (id === activeDocId) {
        if (remaining.length) {
          const next = remaining[0];
          loadState(next.state);
          setProjectName(next.name);
          setProjectId(next.projectId);
          projectCreatedAt.current = next.createdAt;
          setActiveDocId(next.id);
        } else {
          clearLive();
          setActiveDocId(null);
        }
      }
      // If the closed doc was the difference-mode reference, drop the reference
      // and turn Difference off — a missing reference would otherwise leave the
      // switch enabled but the plot with no reference to subtract. Active-doc
      // visibility is forced true (see `handleUpdateDocument`), so closing the
      // active doc also can't leave a hidden-active dead state.
      if (id === referenceDocId) {
        setReferenceDocId(null);
        setDifference(false);
      }
      setDocuments(remaining);
      clearHistory(id);
    },
    [documents, activeDocId, loadState, clearLive, clearHistory, referenceDocId],
  );

  const handleSave = useCallback(async () => {
    if (!raw) {
      toast.error("Import a spectrum before saving");
      return;
    }
    setSaving(true);
    try {
      const state = buildState();
      let savedId = projectId;
      if (projectId) {
        await saveProject({ id: projectId, name: projectName, createdAt: projectCreatedAt.current, updatedAt: Date.now(), state });
      } else {
        const record = await createProject(projectName, state);
        savedId = record.id;
        setProjectId(record.id);
        projectCreatedAt.current = record.createdAt;
      }
      if (activeDocId) {
        setDocuments((prev) =>
          prev.map((d) => (d.id === activeDocId ? { ...d, projectId: savedId, name: projectName, state } : d)),
        );
      }
      toast.success("Project saved");
      refreshProjects();
    } catch (error) {
      console.error(error);
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  }, [raw, buildState, projectId, projectName, refreshProjects, activeDocId]);

  const handleLoad = useCallback(
    async (id: string) => {
      try {
        const open = documents.find((d) => d.projectId === id);
        if (open) {
          switchToDoc(open.id);
          return;
        }
        const record = await loadProject(id);
        if (!record) return;
        const snap = snapshotActiveDoc();
        const docId = crypto.randomUUID();
        const color = nextDocColor(docsCreatedCountRef.current);
        docsCreatedCountRef.current += 1;
        setDocuments((prev) => {
          const saved = snap ? prev.map((d) => (d.id === snap.id ? snap : d)) : prev;
          return [...saved, { id: docId, name: record.name, projectId: record.id, createdAt: record.createdAt, state: record.state, color, visible: true, offset: 0 }];
        });
        loadState(record.state);
        setProjectName(record.name);
        setProjectId(record.id);
        projectCreatedAt.current = record.createdAt;
        setActiveDocId(docId);
        toast.success(`Opened ${record.name}`);
      } catch (error) {
        console.error(error);
        toast.error("Could not open project");
      }
    },
    [documents, snapshotActiveDoc, loadState, switchToDoc],
  );

  const handleImportProjectFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const record = deserializeProject(String(reader.result ?? ""));
          const snap = snapshotActiveDoc();
          const docId = crypto.randomUUID();
          const createdAt = record.createdAt || Date.now();
          const color = nextDocColor(docsCreatedCountRef.current);
          docsCreatedCountRef.current += 1;
          setDocuments((prev) => {
            const saved = snap ? prev.map((d) => (d.id === snap.id ? snap : d)) : prev;
            return [...saved, { id: docId, name: record.name, projectId: null, createdAt, state: record.state, color, visible: true, offset: 0 }];
          });
          loadState(record.state);
          setProjectName(record.name);
          setProjectId(null); // imported copy: Save creates a new local record
          projectCreatedAt.current = createdAt;
          setActiveDocId(docId);
          toast.success(`Imported ${record.name}`);
        } catch (error) {
          console.error(error);
          toast.error("Not a valid MALDI project file");
        }
      };
      reader.readAsText(file);
    },
    [snapshotActiveDoc, loadState],
  );

  const handleNew = useCallback(() => {
    clearLive();
    setDocuments([]);
    setActiveDocId(null);
    setReferenceDocId(null);
    setDifference(false);
    setNormalize(false);
    docsCreatedCountRef.current = 0;
    clearAll();
  }, [clearLive, clearAll]);

  const handleDelete = useCallback(
    async (id: string) => {
      const target = projects.find((p) => p.id === id);
      await deleteProject(id);
      setDocuments((prev) => prev.map((d) => (d.projectId === id ? { ...d, projectId: null } : d)));
      if (id === projectId) setProjectId(null);
      refreshProjects();
      toast.success(`Deleted "${target?.name ?? "project"}"`);
    },
    [projectId, refreshProjects, projects],
  );

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    void handleDelete(deleteTarget.id);
    setDeleteTarget(null);
  }, [deleteTarget, handleDelete]);

  // --- Interpretation + export ------------------------------------------------
  const findings = useMemo<Finding[]>(() => {
    if (peaks.length === 0) return [];
    const mw = summarizeMolWeight(peaks, series, series.length ? "series" : "all", {});
    return interpretSpectrum({
      peaks,
      series,
      adducts: allAdducts,
      repeatCandidates,
      molWeight: mw,
    });
  }, [peaks, series, allAdducts, repeatCandidates]);

  const recordExport = (kind: string, label: string) =>
    setExportHistory((prev) => [...prev, { kind, label, at: Date.now() }]);

  const buildReportPayload = useCallback((): ReportPayload => ({
    projectName,
    sourceName,
    pointCount: raw?.mz.length ?? 0,
    peaks,
    series,
    adducts: allAdducts,
    repeatMass,
    // Every repeat unit in play, so a two-polymer sample's report names both.
    repeatMasses: repeatMasses.length ? repeatMasses : repeatMass > 0 ? [repeatMass] : [],
    molWeight: summarizeMolWeight(peaks, series, series.length ? "series" : "all", {}),
    findings,
    selectedSeriesIds: highlightedSeriesIds ? [...highlightedSeriesIds] : [],
    // `primaryOnly` so a PDF/Excel report about the active document doesn't
    // silently embed the other open documents' traces now that overlays share
    // the canvas. (WP3 §9.)
    spectrumPng: plotHandleRef.current?.getPng({ primaryOnly: true }) ?? null,
  }), [projectName, sourceName, raw, peaks, series, allAdducts, repeatMass, repeatMasses, findings, highlightedSeriesIds]);


  const handleExport = useCallback(
    async (kind: ExportKind) => {
      try {
        switch (kind) {
          case "png": {
            // `primaryOnly` so the toolbar PNG exports the active document only
            // (overlays would otherwise be embedded now that they share the
            // canvas). (WP3 §9.)
            const url = plotHandleRef.current?.getPng({ primaryOnly: true });
            if (!url) return toast.error("Spectrum not ready");
            const a = document.createElement("a");
            a.href = url;
            a.download = `${sourceName || "maldi"}-spectrum.png`;
            a.click();
            recordExport(kind, "Spectrum PNG");
            break;
          }
          case "project-json":
            exportProjectJson({
              id: projectId ?? "unsaved",
              name: projectName,
              createdAt: projectCreatedAt.current,
              updatedAt: Date.now(),
              state: buildState(),
            });
            recordExport(kind, "Project JSON");
            break;
          case "report-pdf":
            exportReportPdf(buildReportPayload());
            recordExport(kind, "PDF report");
            break;
          case "report-excel":
            await exportReportExcel(buildReportPayload());
            recordExport(kind, "Excel report");
            break;
        }
      } catch (error) {
        console.error(error);
        toast.error("Export failed");
      }
    },
    [sourceName, projectName, projectId, buildState, buildReportPayload],
  );

  // --- Persisted sidebar collapse state (WP1d) -------------------------------
  // Open/closed per card is session-only UI state, not analysis state, so it
  // lives outside `useMaldiUndo`'s snapshot deps. Persisted to localStorage so a
  // freshly-loaded workspace is a tidy stack of headers the user re-opens as
  // needed; `maldi.sidebar.open` holds `{ cardId: isOpen }`. Import and Peak
  // picking default open; every other card defaults collapsed.
  //
  // The defaults are merged over the stored record at read time via
  // `isCardOpen` (falling back to `DEFAULT_CARD_OPEN[id]`), rather than inside
  // `usePersistedState`, so that a card id added in a future release still
  // resolves to its intended default for users who already have a stored
  // object without that key. The hook itself stays generic over `T`.
  const [cardOpen, setCardOpen] = usePersistedState<Record<string, boolean>>(
    "maldi.sidebar.open",
    DEFAULT_CARD_OPEN,
  );
  const isCardOpen = useCallback(
    (id: string) => cardOpen[id] ?? DEFAULT_CARD_OPEN[id] ?? false,
    [cardOpen],
  );
  const setCardOpenById = useCallback(
    (id: string, open: boolean) => setCardOpen((prev) => ({ ...prev, [id]: open })),
    [setCardOpen],
  );

  // The active document's name, shown in each right-hand tab header so with N
  // traces visible the user always knows which document the Peak table / Series
  // / Figure / Formula / Mol. weight / Report tabs are describing (the
  // architectural rule: every right-hand tab reads the ACTIVE document only).
  // Suppressed when only one document is open — the name is then already in the
  // page title and the panel, and the suffix would be pure noise.
  const activeDocLabel = useMemo(() => {
    if (documents.length < 2) return "";
    const doc = documents.find((d) => d.id === activeDocId);
    return doc?.name ? ` · ${doc.name}` : "";
  }, [documents, activeDocId]);

  return (
    <AppShell
      headerAccessory={
        <>
          <WorkerBadge status={workerStatus} onRetry={checkWorker} />
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 font-medium text-success">
            <HardDrive className="h-3 w-3" />
            Local MALDI workspace
          </span>
        </>
      }
      mainClassName="px-4 py-5 sm:px-6"
    >
      <input
        ref={projectImportRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && handleImportProjectFile(e.target.files[0])}
      />
      {pageDragActive && (
        <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
          <div className="rounded-2xl border-2 border-dashed border-primary bg-background/95 px-8 py-6 text-center shadow-xl">
            <p className="text-base font-semibold text-primary">Drop spectrum to import</p>
            <p className="mt-1 text-xs text-muted-foreground">CSV / TXT / mzML / mzXML / MGF</p>
          </div>
        </div>
      )}
      <div className="mx-auto flex max-w-[1700px] flex-col gap-4">
        {/* Hero + project toolbar */}
        <section className="rounded-3xl border border-border/70 bg-card p-5 shadow-card">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">
                MALDI interpretation
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                MALDI spectrum interpretation
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                Import a spectrum (CSV/TXT or mzML/mzXML/MGF), process it, pick peaks with local
                signal-to-noise, then detect repeat units, assign series, identify end groups, run
                formula/isotope tools and MALDI-apparent molecular weights — all in your browser.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1">
                <label className="text-[11px] text-muted-foreground">Project name</label>
                <Input className="h-9 w-56" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
              </div>
              <Button size="sm" className="h-9" onClick={handleSave} disabled={saving || !raw}>
                {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                Save
              </Button>
              <Button size="sm" variant="outline" className="h-9" onClick={handleNew}>
                New
              </Button>
              <Button size="sm" variant="outline" className="h-9" onClick={() => projectImportRef.current?.click()}>
                <Upload className="mr-1.5 h-4 w-4" /> Open JSON
              </Button>
              {projects.length > 0 && (
                <div className="flex items-end gap-2">
                  <div className="grid gap-1">
                    <label className="text-[11px] text-muted-foreground">Open project</label>
                    <Select value={projectId ?? ""} onValueChange={handleLoad}>
                      <SelectTrigger className="h-9 w-56">
                        <SelectValue placeholder="Saved projects…" />
                      </SelectTrigger>
                      <SelectContent>
                        {projects.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            <span className="flex items-center gap-2">
                              <FolderOpen className="h-3.5 w-3.5" />
                              {p.name} · {p.peakCount} peaks
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9"
                    onClick={() => setManageProjectsOpen(true)}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" /> Manage
                  </Button>
                </div>
              )}
            </div>
          </div>
        </section>

        {!raw ? (
          <section className="grid gap-4 lg:grid-cols-[1fr_360px]">
            <Card className="border-border/70 shadow-card">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Import a spectrum</CardTitle>
              </CardHeader>
              <CardContent>
                <ImportPanel onFiles={handleImportFiles} busy={parsing} meta={parseMeta} sourceName={sourceName} />
              </CardContent>
            </Card>
            <Card className="border-border/70 shadow-card">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Recent projects</CardTitle>
              </CardHeader>
              <CardContent>
                {projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No saved projects yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {projects.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5">
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => handleLoad(p.id)}>
                          <span className="block truncate text-xs font-medium text-foreground">{p.name}</span>
                          <span className="block text-[10px] text-muted-foreground">
                            {p.sourceName || "—"} · {p.peakCount} peaks
                          </span>
                        </button>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-destructive"
                          title="Delete project"
                          onClick={() => setDeleteTarget(p)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>
        ) : (
          <section className="grid gap-4 lg:grid-cols-[380px_1fr]">
            {/* Left: control panels */}
            <div className="flex max-h-[calc(100vh-220px)] flex-col gap-3 overflow-y-auto pr-1 lg:sticky lg:top-4">
              <SidebarCard id="import" title="Import" open={isCardOpen("import")} onOpenChange={(o) => setCardOpenById("import", o)}>
                <ImportPanel onFiles={handleImportFiles} busy={parsing} meta={parseMeta} sourceName={sourceName} compact />
              </SidebarCard>
              <SidebarCard id="templates" title="Templates" open={isCardOpen("templates")} onOpenChange={(o) => setCardOpenById("templates", o)}>
                <TemplatePanel onApply={handleApplyTemplate} current={{ repeatMass, endGroupMass, adductIds: selectedAdductIds }} />
              </SidebarCard>
              <SidebarCard id="processing" title={`Processing${processingBusy ? " · running…" : ""}`} open={isCardOpen("processing")} onOpenChange={(o) => setCardOpenById("processing", o)}>
                <ProcessingPanel steps={steps} onChange={setSteps} spectrumRange={spectrumRange} />
              </SidebarCard>
              <SidebarCard id="peak-picking" title="Peak picking" open={isCardOpen("peak-picking")} onOpenChange={(o) => setCardOpenById("peak-picking", o)}>
                <PeakPickingPanel params={pickParams} onChange={setPickParams} onRun={handlePick} onClear={() => setPeaks([])} busy={picking} peakCount={peaks.length} />
              </SidebarCard>
              <SidebarCard id="adducts" title="Adducts" forceMount open={isCardOpen("adducts")} onOpenChange={(o) => setCardOpenById("adducts", o)}>
                <AdductPanel
                  selectedIds={selectedAdductIds}
                  customAdducts={customAdducts}
                  onChangeSelected={setSelectedAdductIds}
                  onAddCustom={(a) => setCustomAdducts((prev) => [...prev, a])}
                  onRemoveCustom={(id) => {
                    setCustomAdducts((prev) => prev.filter((a) => a.id !== id));
                    setSelectedAdductIds((prev) => prev.filter((x) => x !== id));
                  }}
                />
              </SidebarCard>
              <SidebarCard id="series" title="Repeat units & series" open={isCardOpen("series")} onOpenChange={(o) => setCardOpenById("series", o)}>
                <SeriesPanel
                  repeatCandidates={repeatCandidates}
                  onDetectRepeats={handleDetectRepeats}
                  isotopeAware={repeatIsotopeAware}
                  onToggleIsotopeAware={handleToggleIsotopeAware}
                  repeatMass={repeatMass}
                  onRepeatMassChange={handleRepeatMassChange}
                  onSelectRepeatCandidate={handleSelectRepeatCandidate}
                  repeatMasses={repeatMasses}
                  onAddRepeatMass={handleAddRepeatMass}
                  onRemoveRepeatMass={handleRemoveRepeatMass}
                  onAssignAllRepeats={handleAssignAllRepeats}
                  repeatGroups={repeatGroupItems}
                  selectedGroupKey={selectedGroupKey}
                  onSelectGroup={handleSelectGroup}
                  series={series.filter((s) => !s.endGroupLocked && !s.supersededBy)}
                  onAssignSeries={handleAssignSeries}
                  adducts={selectedAdducts}
                  peaks={peaks}
                  detectingRepeats={detecting}
                  assigning={assigning}
                  selectedSeriesId={selectedSeriesId}
                  onSelectSeries={handleSelectSeries}
                  onHighlightAll={handleHighlightAllSeries}
                  colorForSeries={colorForSeries}
                  onAssignSeriesToTable={handleAssignSeriesToTable}
                  onCombineSeries={handleCombineSeries}
                  unexplainedCount={unexplainedPeaks(peaks, series).length}
                />
              </SidebarCard>
              <SidebarCard id="copolymer" title="Copolymer" open={isCardOpen("copolymer")} onOpenChange={(o) => setCardOpenById("copolymer", o)}>
                <CopolymerPanel
                  series={copolymerSeries}
                  onDetect={handleDetectCopolymer}
                  repeatA={copolymerA}
                  repeatB={copolymerB}
                  onRepeatAChange={setCopolymerA}
                  onRepeatBChange={setCopolymerB}
                  adducts={selectedAdducts}
                  peakCount={peaks.filter((p) => p.accepted !== false && !p.ignored).length}
                  busy={detectingCopolymer}
                  selectedId={selectedCopolymerId}
                  onSelect={handleSelectCopolymer}
                />
              </SidebarCard>
              <SidebarCard id="batch" title="Batch processing" forceMount open={isCardOpen("batch")} onOpenChange={(o) => setCardOpenById("batch", o)}>
                <BatchPanel steps={steps} pickParams={pickParams} />
              </SidebarCard>
            </div>

            {/* Right: viewer + tabs */}
            <div className="flex flex-col gap-4">
              <Card className="border-border/70 shadow-card">
                <CardContent className="p-4">
                  {/* mMass-style Documents panel sits inside the viewer card, right
                      of the plot — `grid lg:grid-cols-[1fr_240px]`. The outer
                      workspace grid stays `lg:grid-cols-[380px_1fr]`; a third
                      top-level column would squeeze the plot at `max-w-[1700px]`
                      (maldi-overhaul-plan.md → WP4). */}
                  <div className="grid gap-2 lg:grid-cols-[1fr_240px]">
                    <div className="h-[440px]">
                      <MaldiSpectrumPlot
                        ref={plotHandleRef}
                        raw={raw}
                        processed={processed}
                        peaks={peaks}
                        highlightedPeakIds={highlightedPeakIds}
                        highlightGroups={plotHighlightGroups}
                        reportSeriesColors={reportSeriesColors}
                        overlaySticks={overlay?.sticks ?? null}
                        onAddPeak={handleAddPeak}
                        onRemovePeak={handleRemovePeak}
                        onToggleSeriesMember={selectedSeriesId ? handleToggleSeriesMember : undefined}
                        isolate={isolateSelection}
                        onIsolateChange={setIsolateSelection}
                        traces={plotTraces}
                        activeTraceId={activeDocId}
                        normalize={normalize}
                        differenceWith={differenceWith}
                      />
                    </div>
                    <DocumentsPanel
                      documents={documents}
                      activeDocId={activeDocId}
                      normalize={normalize}
                      onNormalizeChange={setNormalize}
                      stacked={stacked}
                      onStackedChange={handleStackedChange}
                      difference={difference}
                      onDifferenceChange={setDifference}
                      referenceDocId={referenceDocId}
                      onReferenceDocIdChange={setReferenceDocId}
                      combineDocuments={combineDocuments}
                      onCombineDocumentsChange={setCombineDocuments}
                      visibleDocCount={visibleDocCount}
                      onSwitch={switchToDoc}
                      onClose={closeDoc}
                      onUpdate={handleUpdateDocument}
                      onImportFiles={(files) => void handleImportFiles(files, { delimiter: "auto", hasHeader: "auto" })}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border/70 shadow-card">
                <CardContent className="p-4">
                  <Tabs defaultValue="table">
                    {activeDocLabel && (
                      <div className="text-xs text-muted-foreground mb-1 truncate">Showing: {activeDocLabel}</div>
                    )}
                    {combineDocuments && (
                      <div className="text-[11px] text-muted-foreground mb-1 truncate">
                        Combine on — tables &amp; figure pool every visible document; picking &amp; processing still use the active one.
                      </div>
                    )}
                    <TabsList className="flex flex-wrap">
                      <TabsTrigger value="table">Peak table</TabsTrigger>
                      <TabsTrigger value="series">Series</TabsTrigger>
                      <TabsTrigger value="figure">Figure</TabsTrigger>
                      <TabsTrigger value="formula">Formula</TabsTrigger>
                      <TabsTrigger value="mw">Mol. weight</TabsTrigger>
                      <TabsTrigger value="report">Report</TabsTrigger>
                    </TabsList>
                    <TabsContent value="table" className="mt-3">
                      <div className="h-[420px]">
                        <PeakTable
                          peaks={analysisPeaks}
                          onChange={handlePeakTableChange}
                          highlightedPeakIds={highlightedPeakIds}
                          onSelectPeak={(id) => highlightPeaks(new Set([id]))}
                          explainedPeakIds={explainedPeakIds}
                          peakOwner={combineDocuments ? peakOwnerMap : undefined}
                          {...(combineDocuments
                            ? {}
                            : {
                                assignableSeries,
                                seriesByPeakId,
                                onAddPeaksToSeries: handleAddPeaksToSeries,
                                onRemovePeaksFromSeries: handleRemovePeaksFromSeries,
                              })}
                        />
                      </div>
                    </TabsContent>
                    <TabsContent value="series" className="mt-3">
                      {combineDocuments ? (
                        <div className="h-[420px] flex flex-col gap-1.5">
                          <p className="text-[11px] text-muted-foreground">
                            Showing confirmed series from every visible document. Assign &amp; detect still run on the active document only.
                          </p>
                          {pooledSeries.length === 0 ? (
                            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                              No confirmed series in any visible document.
                            </div>
                          ) : (
                            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60">
                              <Table>
                                <TableHeader className="sticky top-0 z-10 bg-card">
                                  <TableRow>
                                    <TableHead className="w-8 text-xs">Color</TableHead>
                                    <TableHead className="text-xs">Source</TableHead>
                                    <TableHead className="text-xs">Label</TableHead>
                                    <TableHead className="text-xs">Adduct</TableHead>
                                    <TableHead className="text-xs">Repeat</TableHead>
                                    <TableHead className="text-xs">End group (Da)</TableHead>
                                    <TableHead className="text-xs">Peaks</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {pooledSeries.map(({ series: s, owner }) => (
                                    <TableRow key={`${owner.docId}:${s.id}`}>
                                      <TableCell>
                                        <span
                                          className="block h-4 w-4 rounded-full border border-border/60"
                                          style={{ backgroundColor: s.color ?? owner.color }}
                                        />
                                      </TableCell>
                                      <TableCell className="text-xs">
                                        <span className="inline-flex items-center gap-1.5">
                                          <span
                                            className="h-2.5 w-2.5 rounded-full"
                                            style={{ backgroundColor: owner.color }}
                                          />
                                          <span className="truncate">{owner.name}</span>
                                        </span>
                                      </TableCell>
                                      <TableCell className="font-mono text-xs">{s.label || seriesAdductLabel(s, allAdducts)}</TableCell>
                                      <TableCell className="font-mono text-xs">{adductById(allAdducts, s.adductId).label}</TableCell>
                                      <TableCell className="font-mono text-xs">{s.repeatMass.toFixed(3)}</TableCell>
                                      <TableCell className="font-mono text-xs">{Number.isFinite(s.endGroupMass) ? s.endGroupMass : 0}</TableCell>
                                      <TableCell className="font-mono text-xs">{s.members.length}</TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="h-[420px]">
                          <SeriesTable
                            series={series.filter((s) => s.endGroupLocked)}
                            adducts={selectedAdducts.length ? selectedAdducts : allAdducts}
                            selectedSeriesId={selectedSeriesId}
                            onSelectSeries={handleSelectSeries}
                            onRenameSeries={handleRenameSeries}
                            onSetSeriesDescription={handleSetSeriesDescription}
                            onSetSeriesColor={handleSetSeriesColor}
                            onSetSeriesEndGroupLabel={handleSetSeriesEndGroupLabel}
                            onSetSeriesEndGroupMass={handleSetSeriesEndGroupMass}
                            onDeleteSeries={handleDeleteSeries}
                            onCombineSeries={handleCombineSeries}
                            onSplitSeries={handleSplitSeries}
                            colorFor={colorForSeries}
                          />
                        </div>
                      )}
                    </TabsContent>
                    <TabsContent value="figure" className="mt-3">
                      <MaldiFigurePanel
                        active={processed ?? raw}
                        peaks={analysisPeaks}
                        highlightedPeakIds={highlightedPeakIds}
                        otherSpectra={otherFigureSpectra.filter((d) => d.visible !== false).map((d) => ({ id: d.id, name: d.name, spectrum: d.spectrum }))}
                        showProfile={figShowProfile}
                        onShowProfileChange={setFigShowProfile}
                        showSticks={figShowSticks}
                        onShowSticksChange={setFigShowSticks}
                        selectedOnly={figSelectedOnly}
                        onSelectedOnlyChange={setFigSelectedOnly}
                        includeFlagged={figIncludeFlagged}
                        onIncludeFlaggedChange={setFigIncludeFlagged}
                        shownPeaks={figShownPeaks}
                        confirmedSeries={figConfirmedSeries}
                        adducts={allAdducts}
                        colorForSeries={colorForSeries}
                        selectedSeriesIds={figSeriesIds}
                        onToggleSeries={handleToggleFigureSeries}
                        hiddenPeakCount={figHiddenCount}
                        onRestorePeaks={handleFigureRestorePeaks}
                        onDeletePeak={handleFigureDeletePeak}
                        figureData={figureData}
                        figureOptions={figureOptions}
                        onFigureOptionsChange={setFigureOptions}
                      />
                    </TabsContent>
                    <TabsContent value="formula" className="mt-3">
                      <FormulaTools adducts={selectedAdducts.length ? selectedAdducts : allAdducts} selectedPeakMz={selectedPeakMz} onOverlay={setOverlay} />
                    </TabsContent>
                    <TabsContent value="mw" className="mt-3">
                      <MolWeightPanel peaks={analysisPeaks} series={series} adducts={selectedAdducts.length ? selectedAdducts : allAdducts} repeatMass={repeatMass} selectedPeakIds={highlightedPeakIds} />
                    </TabsContent>
                    <TabsContent value="report" className="mt-3">
                      <InterpretationPanel findings={findings} onRefresh={() => toast.success("Interpretation refreshed")} onExport={handleExport} exportHistory={exportHistory} />
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            </div>
          </section>
        )}
      </div>

      {/* Manage projects dialog — list all saved projects with delete buttons. */}
      <Dialog open={manageProjectsOpen} onOpenChange={setManageProjectsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Manage saved projects</DialogTitle>
          </DialogHeader>
          {projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">No saved projects yet.</p>
          ) : (
            <ul className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
              {projects.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      void handleLoad(p.id);
                      setManageProjectsOpen(false);
                    }}
                  >
                    <span className="block truncate text-xs font-medium text-foreground">{p.name}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {p.sourceName || "—"} · {p.peakCount} peaks
                    </span>
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    title="Delete project"
                    onClick={() => setDeleteTarget(p)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation — shared by Manage dialog and Recent projects card. */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete "{deleteTarget?.name}"? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
};

/**
 * Collapsible sidebar card backed by `CollapsibleSection`. Open/closed state is
 * controlled from the host's persisted `Record<cardId, boolean>` so it survives
 * reloads without entering the undo history.
 *
 * `forceMount` keeps the children mounted even while collapsed — required for
 * panels that hold local state mutated after an `await` (BatchPanel's run
 * results, AdductPanel's half-typed custom adduct). Radix `CollapsibleContent`
 * otherwise unmounts its children, destroying that state and orphaning the loop.
 * The content is hidden via CSS so the collapsed card still shows nothing.
 */
function SidebarCard({
  id,
  title,
  open,
  onOpenChange,
  forceMount = false,
  children,
}: {
  id: string;
  title: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  forceMount?: boolean;
  children: React.ReactNode;
}) {
  return (
    <CollapsibleSection
      title={title}
      open={open}
      onOpenChange={onOpenChange}
      forceMount={forceMount}
    >
      {children}
    </CollapsibleSection>
  );
}

function WorkerBadge({ status, onRetry }: { status: WorkerStatus; onRetry?: () => void }) {
  if (status === "checking") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Starting worker…
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive">
        <CircleSlash className="h-3.5 w-3.5" />
        Worker unavailable
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="ml-0.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 underline-offset-2 hover:underline"
          >
            <RotateCw className="h-3 w-3" />
            Retry
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-3 py-1.5 text-xs font-medium text-success">
      <CircleCheck className="h-3.5 w-3.5" />
      Worker ready
    </span>
  );
}

export default Maldi;
