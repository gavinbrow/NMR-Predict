import {
  ChevronDown,
  CircleCheck,
  CircleSlash,
  FolderOpen,
  HardDrive,
  Layers,
  Loader2,
  RotateCw,
  Rows3,
  Save,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { AdductPanel } from "@/components/maldi/AdductPanel";
import { BatchPanel } from "@/components/maldi/BatchPanel";
import { CompareView, type ComparisonSpectrum } from "@/components/maldi/CompareView";
import { CopolymerPanel } from "@/components/maldi/CopolymerPanel";
import { MaldiFigurePanel } from "@/components/maldi/figure/MaldiFigurePanel";
import { FormulaTools, type IsotopeOverlay } from "@/components/maldi/FormulaTools";
import { ImportPanel } from "@/components/maldi/ImportPanel";
import { InterpretationPanel, type ExportKind } from "@/components/maldi/InterpretationPanel";
import { KendrickPlot } from "@/components/maldi/KendrickPlot";
import {
  MaldiSpectrumPlot,
  type MaldiSpectrumPlotHandle,
} from "@/components/maldi/MaldiSpectrumPlot";
import { StackedSpectraPlot, type StackSpectrum } from "@/components/maldi/StackedSpectraPlot";
import { LossPanel } from "@/components/maldi/LossPanel";
import { MolWeightPanel } from "@/components/maldi/MolWeightPanel";
import { PeakPickingPanel } from "@/components/maldi/PeakPickingPanel";
import { PeakTable } from "@/components/maldi/PeakTable";
import { ProcessingPanel } from "@/components/maldi/ProcessingPanel";
import { SeriesPanel, type RepeatGroupItem } from "@/components/maldi/SeriesPanel";
import { SeriesTable } from "@/components/maldi/SeriesTable";
import { TemplatePanel } from "@/components/maldi/TemplatePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMaldiUndo, type UndoSnapshot } from "@/hooks/useMaldiUndo";
import { adductById, ALL_BUILTIN_ADDUCTS } from "@/lib/maldi/adducts";
import {
  exportPeaksCsv,
  exportProjectJson,
  exportReportExcel,
  exportReportPdf,
  exportSeriesCsv,
  exportSpectrumCsv,
  deserializeProject,
  type ReportPayload,
} from "@/lib/maldi/export";
import { interpretSpectrum, type Finding } from "@/lib/maldi/interpret";
import type { LossEvent } from "@/lib/maldi/losses";
import { summarizeMolWeight } from "@/lib/maldi/molweight";
import type { ParseMeta } from "@/lib/maldi/parse";
import { manualPeak, PEAK_PRESETS, type PeakPickParams } from "@/lib/maldi/peaks";
import { fitLadder, peaksForRepeat, seriesForRepeat } from "@/lib/maldi/polymers";
import { explainedPeakIds as explainedPeakIdsHelper, sameLadderSiblings, unexplainedPeaks } from "@/lib/maldi/seriesMatch";
import { buildLadderColorMap } from "@/lib/maldi/seriesColor";
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
} from "@/lib/maldi/types";
import {
  assignSeries,
  detectCopolymer,
  detectLosses,
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
type ViewMode = "single" | "overlay" | "stacked";

/** One open spectrum in the session, carrying its own full analysis state. */
interface MaldiDocument {
  id: string;
  name: string;
  /** Saved-project id once persisted, else null. */
  projectId: string | null;
  createdAt: number;
  state: ProjectState;
}

let comparisonCounter = 0;

/**
 * Distinct colours for the per-ladder view when a repeat unit is split into its
 * interleaved series. Shared by the plot (stems) and the series list (swatches),
 * indexed positionally so the two always agree.
 */
const SERIES_COLORS = [
  "#d946ef", "#0ea5e9", "#22c55e", "#f59e0b", "#ef4444",
  "#8b5cf6", "#14b8a6", "#ec4899", "#65a30d", "#f97316",
];

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
  const [pickParams, setPickParams] = useState<PeakPickParams>({ ...PEAK_PRESETS.balanced });
  const [selectedAdductIds, setSelectedAdductIds] = useState<string[]>(["H", "Na", "K"]);
  const [customAdducts, setCustomAdducts] = useState<Adduct[]>([]);
  const [repeatCandidates, setRepeatCandidates] = useState<RepeatCandidate[]>([]);
  const [repeatMass, setRepeatMass] = useState(0);
  const [baseRepeat, setBaseRepeat] = useState(0);
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
  const [losses, setLosses] = useState<LossEvent[]>([]);
  const [copolymerSeries, setCopolymerSeries] = useState<CopolymerSeries[]>([]);
  const [copolymerA, setCopolymerA] = useState(0);
  const [copolymerB, setCopolymerB] = useState(0);
  const [selectedCopolymerId, setSelectedCopolymerId] = useState<string | null>(null);
  const [comparisons, setComparisons] = useState<ComparisonSpectrum[]>([]);
  const [exportHistory, setExportHistory] = useState<ExportRecord[]>([]);
  // Mirror of exportHistory read by the undo restore (the log is append-only and
  // excluded from snapshots, so a restore must preserve the current log).
  const exportHistoryRef = useRef<ExportRecord[]>(exportHistory);
  useEffect(() => {
    exportHistoryRef.current = exportHistory;
  }, [exportHistory]);
  const [documents, setDocuments] = useState<MaldiDocument[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("single");
  const plotHandleRef = useRef<MaldiSpectrumPlotHandle>(null);
  const projectImportRef = useRef<HTMLInputElement>(null);

  // --- Busy flags -------------------------------------------------------------
  const [parsing, setParsing] = useState(false);
  const [processingBusy, setProcessingBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [detectingLosses, setDetectingLosses] = useState(false);
  const [detectingCopolymer, setDetectingCopolymer] = useState(false);
  const [addingComparison, setAddingComparison] = useState(false);
  const [saving, setSaving] = useState(false);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);

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


  // Every open document's display spectrum, for the overlay / stacked view modes.
  const docSpectra = useMemo<StackSpectrum[]>(() => {
    return documents
      .map((d) => {
        const spectrum = d.id === activeDocId ? processed ?? raw : d.state.processedSpectrum ?? d.state.rawSpectrum;
        return spectrum ? { id: d.id, name: d.name, spectrum } : null;
      })
      .filter((x): x is StackSpectrum => x !== null);
  }, [documents, activeDocId, processed, raw]);

  // Other open spectra (excluding the active one) — overlayable in the figure maker.
  const otherFigureSpectra = useMemo(
    () => docSpectra.filter((d) => d.id !== activeDocId),
    [docSpectra, activeDocId],
  );

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
    setLosses([]);
    setCopolymerSeries([]);
    setRepeatMass(0);
    setBaseRepeat(0);
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
    state.baseRepeat = baseRepeat;
    state.endGroupMass = endGroupMass;
    state.repeatIsotopeAware = repeatIsotopeAware;
    state.copolymerA = copolymerA;
    state.copolymerB = copolymerB;
    state.exportHistory = exportHistory;
    return state;
  }, [sourceName, raw, processed, steps, peaks, customAdducts, series, selectedAdductIds, pickParams, repeatMass, baseRepeat, endGroupMass, repeatIsotopeAware, copolymerA, copolymerB, exportHistory]);

  const loadState = useCallback((s: ProjectState) => {
    setSourceName(s.sourceName);
    setRaw(s.rawSpectrum);
    setProcessed(s.processedSpectrum);
    setSteps(s.processing);
    setPeaks(s.peaks);
    setCustomAdducts(s.adducts ?? []);
    setSeries(s.series ?? []);
    setSelectedAdductIds(s.selectedAdductIds ?? ["H", "Na", "K"]);
    setPickParams(s.pickParams ?? { ...PEAK_PRESETS.balanced });
    setRepeatMass(s.repeatMass ?? 0);
    setBaseRepeat(s.baseRepeat ?? s.repeatMass ?? 0);
    setEndGroupMass(s.endGroupMass ?? 0);
    setRepeatIsotopeAware(s.repeatIsotopeAware ?? true);
    setCopolymerA(s.copolymerA ?? 0);
    setCopolymerB(s.copolymerB ?? 0);
    setExportHistory(s.exportHistory ?? []);
    setRepeatCandidates([]);
    setLosses([]);
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
  }, []);

  const snapshotActiveDoc = useCallback((): MaldiDocument | null => {
    if (!activeDocId) return null;
    return { id: activeDocId, name: projectName, projectId, createdAt: projectCreatedAt.current, state: buildState() };
  }, [activeDocId, projectName, projectId, buildState]);

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

  // Open an imported spectrum as a brand-new document (carrying over the current
  // processing pipeline + adduct selection as a sensible starting point).
  const applySpectrum = useCallback(
    (spectrum: SpectrumData, fileName: string, meta: ParseMeta | null) => {
      const name = fileName.replace(/\.[^.]+$/, "");
      const snap = snapshotActiveDoc();
      const docId = crypto.randomUUID();
      const createdAt = Date.now();
      setDocuments((prev) => {
        const saved = snap ? prev.map((d) => (d.id === snap.id ? snap : d)) : prev;
        return [...saved, { id: docId, name, projectId: null, createdAt, state: emptyProjectState(fileName) }];
      });
      resetDownstream();
      setRaw(spectrum);
      setProcessed(null);
      // Auto-baseline every newly imported spectrum (reversible in Processing).
      setSteps([defaultBaselineStep()]);
      setParseMeta(meta);
      setSourceName(fileName);
      setProjectId(null);
      projectCreatedAt.current = createdAt;
      setProjectName(name);
      setActiveDocId(docId);
      setViewMode("single");
    },
    [snapshotActiveDoc, resetDownstream],
  );

  // --- Import -----------------------------------------------------------------
  const handleImport = useCallback(
    async (text: string, fileName: string, options: Parameters<typeof parse>[1]) => {
      setParsing(true);
      try {
        const result = await parse(text, options);
        applySpectrum(result.spectrum, fileName, result.meta);
        toast.success(`Imported ${result.meta.rowCount.toLocaleString()} points`);
      } catch (error) {
        console.error(error);
        toast.error(error instanceof Error ? error.message : "Import failed");
      } finally {
        setParsing(false);
      }
    },
    [applySpectrum],
  );

  const handleMsImport = useCallback(
    async (buffer: ArrayBuffer, fileName: string) => {
      setParsing(true);
      try {
        const result = await parseMs(buffer, fileName);
        applySpectrum(result.spectrum, fileName, null);
        toast.success(`Imported ${result.meta.pointCount.toLocaleString()} points (${result.meta.format})`);
      } catch (error) {
        console.error(error);
        toast.error(error instanceof Error ? error.message : "Import failed");
      } finally {
        setParsing(false);
      }
    },
    [applySpectrum],
  );

  // --- Global drag-and-drop import ------------------------------------------
  // Drop a spectrum file ANYWHERE on the page (not just the import box). A window
  // listener handles drops that a dedicated drop zone (the import box or the
  // Compare panel) did not already handle — those call preventDefault, so we skip
  // them here via `defaultPrevented` to avoid a double import.
  const [pageDragActive, setPageDragActive] = useState(false);
  const dragDepth = useRef(0);

  const importDroppedFile = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      const reader = new FileReader();
      if (/\.(mzml|mzxml|mgf)$/i.test(file.name)) {
        reader.onload = () => handleMsImport(reader.result as ArrayBuffer, file.name);
        reader.readAsArrayBuffer(file);
      } else {
        reader.onload = () =>
          handleImport(String(reader.result ?? ""), file.name, { delimiter: "auto", hasHeader: "auto" });
        reader.readAsText(file);
      }
    },
    [handleImport, handleMsImport],
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
      setLosses([]);
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
          setBaseRepeat((current) => (current > 0 ? current : top));
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
      setBaseRepeat(mass);
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
      setBaseRepeat(mass);
      if (mass > 0) previewRepeat(mass);
      else highlightPeaks(undefined);
    },
    [previewRepeat, highlightPeaks],
  );

  // Click a ladder: isolate it (click again to show all ladders together).
  const handleSelectGroup = useCallback((key: string) => {
    setSelectedGroupKey((cur) => (cur === key ? null : key));
  }, []);

  const handleAssignSeries = useCallback(async () => {
    setAssigning(true);
    try {
      const result = await assignSeries(peaks, repeatMass, selectedAdducts);
      setSeries(result.series);
      if (baseRepeat <= 0) setBaseRepeat(repeatMass);
      toast.success(`Assigned ${result.series.length} series`);
    } catch (error) {
      console.error(error);
      toast.error("Series assignment failed");
    } finally {
      setAssigning(false);
    }
  }, [peaks, repeatMass, selectedAdducts, baseRepeat]);



  const handleDetectLosses = useCallback(async () => {
    setDetectingLosses(true);
    try {
      const result = await detectLosses(peaks);
      setLosses(result.events);
      toast.success(`${result.events.length} neutral-loss relationships`);
    } catch (error) {
      console.error(error);
      toast.error("Loss detection failed");
    } finally {
      setDetectingLosses(false);
    }
  }, [peaks]);

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

  const handleKendrickCluster = useCallback((peakIds: string[]) => {
    highlightPeaks(peakIds.length ? new Set(peakIds) : undefined);
    setSelectedSeriesId(null);
  }, [highlightPeaks]);

  const handleApplyTemplate = useCallback(
    (t: ChemistryTemplate) => {
      setRepeatMass(Number(t.repeatMass.toFixed(4)));
      setBaseRepeat(Number(t.repeatMass.toFixed(4)));
      if (t.endGroupMass != null) setEndGroupMass(t.endGroupMass);
      const valid = t.adductIds.filter((id) => allAdducts.some((a) => a.id === id));
      if (valid.length) setSelectedAdductIds(valid);
      toast.success(`Applied template: ${t.name}`);
    },
    [allAdducts],
  );

  // --- Compare ----------------------------------------------------------------
  const handleAddComparisons = useCallback(async (files: FileList) => {
    setAddingComparison(true);
    try {
      for (const file of Array.from(files)) {
        let spectrum: SpectrumData;
        if (/\.(mzml|mzxml|mgf)$/i.test(file.name)) {
          const buffer = await file.arrayBuffer();
          spectrum = (await parseMs(buffer, file.name)).spectrum;
        } else {
          spectrum = (await parse(await file.text())).spectrum;
        }
        comparisonCounter += 1;
        setComparisons((prev) => [...prev, { id: `cmp-${Date.now()}-${comparisonCounter}`, name: file.name, spectrum }]);
      }
    } catch (error) {
      console.error(error);
      toast.error("Could not load comparison spectrum");
    } finally {
      setAddingComparison(false);
    }
  }, []);

  // Add an already-open spectrum (another document in this session) to the
  // comparison list, mirroring how docSpectra resolves each doc's display trace.
  const handleAddComparisonFromOpen = useCallback(
    (docId: string) => {
      if (docId === activeDocId) return;
      const target = documents.find((d) => d.id === docId);
      const spectrum = target?.state.processedSpectrum ?? target?.state.rawSpectrum;
      if (!target || !spectrum) return;
      comparisonCounter += 1;
      setComparisons((prev) => [
        ...prev,
        { id: `cmp-${Date.now()}-${comparisonCounter}`, name: target.name, spectrum, visible: true, sourceDocId: docId },
      ]);
    },
    [activeDocId, documents],
  );

  const handleUpdateComparison = useCallback((id: string, patch: Partial<ComparisonSpectrum>) => {
    setComparisons((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

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
      pickParams, repeatMass, baseRepeat, endGroupMass, repeatIsotopeAware,
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
      const snap = snapshotActiveDoc();
      if (snap) setDocuments((prev) => prev.map((d) => (d.id === snap.id ? snap : d)));
      loadState(target.state);
      setProjectName(target.name);
      setProjectId(target.projectId);
      projectCreatedAt.current = target.createdAt;
      setActiveDocId(id);
      setViewMode("single");
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
      setDocuments(remaining);
      clearHistory(id);
    },
    [documents, activeDocId, loadState, clearLive, clearHistory],
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
        setDocuments((prev) => {
          const saved = snap ? prev.map((d) => (d.id === snap.id ? snap : d)) : prev;
          return [...saved, { id: docId, name: record.name, projectId: record.id, createdAt: record.createdAt, state: record.state }];
        });
        loadState(record.state);
        setProjectName(record.name);
        setProjectId(record.id);
        projectCreatedAt.current = record.createdAt;
        setActiveDocId(docId);
        setViewMode("single");
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
          setDocuments((prev) => {
            const saved = snap ? prev.map((d) => (d.id === snap.id ? snap : d)) : prev;
            return [...saved, { id: docId, name: record.name, projectId: null, createdAt, state: record.state }];
          });
          loadState(record.state);
          setProjectName(record.name);
          setProjectId(null); // imported copy: Save creates a new local record
          projectCreatedAt.current = createdAt;
          setActiveDocId(docId);
          setViewMode("single");
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
    setComparisons([]);
    setViewMode("single");
    clearAll();
  }, [clearLive, clearAll]);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteProject(id);
      setDocuments((prev) => prev.map((d) => (d.projectId === id ? { ...d, projectId: null } : d)));
      if (id === projectId) setProjectId(null);
      refreshProjects();
    },
    [projectId, refreshProjects],
  );

  // --- Interpretation + export ------------------------------------------------
  const findings = useMemo<Finding[]>(() => {
    if (peaks.length === 0) return [];
    const mw = summarizeMolWeight(peaks, series, series.length ? "series" : "all", {});
    return interpretSpectrum({
      peaks,
      series,
      adducts: allAdducts,
      repeatCandidates,
      losses,
      molWeight: mw,
    });
  }, [peaks, series, allAdducts, repeatCandidates, losses]);

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
    molWeight: summarizeMolWeight(peaks, series, series.length ? "series" : "all", {}),
    losses,
    findings,
    spectrumPng: plotHandleRef.current?.getPng() ?? null,
  }), [projectName, sourceName, raw, peaks, series, allAdducts, repeatMass, losses, findings]);

  const handleExport = useCallback(
    async (kind: ExportKind) => {
      try {
        switch (kind) {
          case "png": {
            const url = plotHandleRef.current?.getPng();
            if (!url) return toast.error("Spectrum not ready");
            const a = document.createElement("a");
            a.href = url;
            a.download = `${sourceName || "maldi"}-spectrum.png`;
            a.click();
            recordExport(kind, "Spectrum PNG");
            break;
          }
          case "peaks-csv":
            exportPeaksCsv(peaks, projectName);
            recordExport(kind, "Peaks CSV");
            break;
          case "processed-csv":
            if (!processed) return toast.error("No processed spectrum");
            exportSpectrumCsv(processed, projectName, "processed");
            recordExport(kind, "Processed CSV");
            break;
          case "series-csv":
            exportSeriesCsv(series, allAdducts, projectName);
            recordExport(kind, "Series CSV");
            break;
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
    [sourceName, peaks, projectName, processed, series, allAdducts, projectId, buildState, buildReportPayload],
  );

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
                <ImportPanel onFile={handleImport} onMsFile={handleMsImport} busy={parsing} meta={parseMeta} sourceName={sourceName} />
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
                        <button type="button" className="text-[11px] text-muted-foreground hover:text-destructive" onClick={() => handleDelete(p.id)}>
                          Delete
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
              <SidebarCard title="Import">
                <ImportPanel onFile={handleImport} onMsFile={handleMsImport} busy={parsing} meta={parseMeta} sourceName={sourceName} compact />
              </SidebarCard>
              <SidebarCard title="Templates" collapsible defaultCollapsed>
                <TemplatePanel onApply={handleApplyTemplate} current={{ repeatMass, endGroupMass, adductIds: selectedAdductIds }} />
              </SidebarCard>
              <SidebarCard title={`Processing${processingBusy ? " · running…" : ""}`}>
                <ProcessingPanel steps={steps} onChange={setSteps} spectrumRange={spectrumRange} />
              </SidebarCard>
              <SidebarCard title="Peak picking">
                <PeakPickingPanel params={pickParams} onChange={setPickParams} onRun={handlePick} onClear={() => setPeaks([])} busy={picking} peakCount={peaks.length} />
              </SidebarCard>
              <SidebarCard title="Adducts">
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
              <SidebarCard title="Repeat units & series">
                <SeriesPanel
                  repeatCandidates={repeatCandidates}
                  onDetectRepeats={handleDetectRepeats}
                  isotopeAware={repeatIsotopeAware}
                  onToggleIsotopeAware={handleToggleIsotopeAware}
                  repeatMass={repeatMass}
                  onRepeatMassChange={handleRepeatMassChange}
                  onSelectRepeatCandidate={handleSelectRepeatCandidate}
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
                  unexplainedCount={unexplainedPeaks(peaks, series).length}
                />
              </SidebarCard>
              <SidebarCard title="Copolymer">
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
              <SidebarCard title="Neutral losses">
                <LossPanel
                  events={losses}
                  onDetect={handleDetectLosses}
                  busy={detectingLosses}
                  peakCount={peaks.length}
                  onSelect={(parent, frag) => highlightPeaks(new Set([parent, frag]))}
                />
              </SidebarCard>
              <SidebarCard title="Batch processing">
                <BatchPanel steps={steps} pickParams={pickParams} />
              </SidebarCard>
            </div>

            {/* Right: viewer + tabs */}
            <div className="flex flex-col gap-4">
              <Card className="border-border/70 shadow-card">
                <CardContent className="p-4">
                  <SpectraTray
                    documents={documents}
                    activeDocId={activeDocId}
                    viewMode={viewMode}
                    onSwitch={switchToDoc}
                    onClose={closeDoc}
                    onViewMode={setViewMode}
                  />
                  <div className="mt-2 h-[440px]">
                    {viewMode === "single" ? (
                      <MaldiSpectrumPlot
                        ref={plotHandleRef}
                        raw={raw}
                        processed={processed}
                        peaks={peaks}
                        highlightedPeakIds={highlightedPeakIds}
                        highlightGroups={plotHighlightGroups}
                        overlaySticks={overlay?.sticks ?? null}
                        onAddPeak={handleAddPeak}
                        onRemovePeak={handleRemovePeak}
                        onToggleSeriesMember={selectedSeriesId ? handleToggleSeriesMember : undefined}
                        isolate={isolateSelection}
                        onIsolateChange={setIsolateSelection}
                      />
                    ) : (
                      <StackedSpectraPlot spectra={docSpectra} mode={viewMode} />
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border/70 shadow-card">
                <CardContent className="p-4">
                  <Tabs defaultValue="table">
                    <TabsList className="flex flex-wrap">
                      <TabsTrigger value="table">Peak table</TabsTrigger>
                      <TabsTrigger value="series">Series</TabsTrigger>
                      <TabsTrigger value="figure">Figure</TabsTrigger>
                      <TabsTrigger value="kendrick">Kendrick</TabsTrigger>
                      <TabsTrigger value="formula">Formula</TabsTrigger>
                      <TabsTrigger value="mw">Mol. weight</TabsTrigger>
                      <TabsTrigger value="compare">Compare</TabsTrigger>
                      <TabsTrigger value="report">Report</TabsTrigger>
                    </TabsList>
                    <TabsContent value="table" className="mt-3">
                      <div className="h-[420px]">
                        <PeakTable
                          peaks={peaks}
                          onChange={setPeaks}
                          highlightedPeakIds={highlightedPeakIds}
                          onSelectPeak={(id) => highlightPeaks(new Set([id]))}
                          explainedPeakIds={explainedPeakIds}
                        />
                      </div>
                    </TabsContent>
                    <TabsContent value="series" className="mt-3">
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
                          colorFor={colorForSeries}
                        />
                      </div>
                    </TabsContent>
                    <TabsContent value="figure" className="mt-3">
                      <MaldiFigurePanel
                        active={processed ?? raw}
                        activeName={sourceName || projectName}
                        peaks={peaks}
                        highlightedPeakIds={highlightedPeakIds}
                        otherSpectra={otherFigureSpectra}
                      />
                    </TabsContent>
                    <TabsContent value="kendrick" className="mt-3">
                      <div className="h-[420px]">
                        <KendrickPlot peaks={peaks} baseRepeat={baseRepeat} onBaseRepeatChange={setBaseRepeat} onSelectCluster={handleKendrickCluster} />
                      </div>
                    </TabsContent>
                    <TabsContent value="formula" className="mt-3">
                      <FormulaTools adducts={selectedAdducts.length ? selectedAdducts : allAdducts} selectedPeakMz={selectedPeakMz} onOverlay={setOverlay} />
                    </TabsContent>
                    <TabsContent value="mw" className="mt-3">
                      <MolWeightPanel peaks={peaks} series={series} adducts={selectedAdducts.length ? selectedAdducts : allAdducts} repeatMass={repeatMass} selectedPeakIds={highlightedPeakIds} />
                    </TabsContent>
                    <TabsContent value="compare" className="mt-3">
                      <div className="h-[440px]">
                        <CompareView
                          current={processed ?? raw}
                          currentName={sourceName || "current"}
                          comparisons={comparisons}
                          onAddFiles={handleAddComparisons}
                          onAddFromOpen={handleAddComparisonFromOpen}
                          onUpdate={handleUpdateComparison}
                          onRemove={(id) => setComparisons((prev) => prev.filter((c) => c.id !== id))}
                          openDocuments={documents.filter((d) => d.id !== activeDocId).map((d) => ({ id: d.id, name: d.name }))}
                          busy={addingComparison}
                        />
                      </div>
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
    </AppShell>
  );
};

/** Tabs of open spectra with a single / overlay / stacked view-mode switch. */
function SpectraTray({
  documents,
  activeDocId,
  viewMode,
  onSwitch,
  onClose,
  onViewMode,
}: {
  documents: MaldiDocument[];
  activeDocId: string | null;
  viewMode: ViewMode;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onViewMode: (mode: ViewMode) => void;
}) {
  if (documents.length === 0) return null;
  const modes: { key: ViewMode; label: string; icon: React.ReactNode }[] = [
    { key: "single", label: "Single", icon: null },
    { key: "overlay", label: "Overlay", icon: <Layers className="h-3 w-3" /> },
    { key: "stacked", label: "Stacked", icon: <Rows3 className="h-3 w-3" /> },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {documents.map((d) => {
          const isActive = d.id === activeDocId && viewMode === "single";
          return (
            <span
              key={d.id}
              className={[
                "inline-flex max-w-[180px] items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-smooth",
                isActive
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/70 bg-background/60 text-muted-foreground hover:border-primary/40",
              ].join(" ")}
            >
              <button type="button" className="truncate" title={d.name} onClick={() => onSwitch(d.id)}>
                {d.name}
              </button>
              <button type="button" className="shrink-0 opacity-60 hover:opacity-100" onClick={() => onClose(d.id)}>
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
      </div>
      <div className="flex shrink-0 overflow-hidden rounded-md border border-border/70">
        {modes.map((m) => (
          <button
            key={m.key}
            type="button"
            disabled={m.key !== "single" && documents.length < 2}
            onClick={() => onViewMode(m.key)}
            className={[
              "flex items-center gap-1 px-2.5 py-1 text-[11px] transition-smooth disabled:opacity-40",
              viewMode === m.key ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted",
            ].join(" ")}
          >
            {m.icon}
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SidebarCard({
  title,
  children,
  collapsible = false,
  defaultCollapsed = false,
}: {
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}) {
  if (!collapsible) {
    return (
      <Card className="border-border/70 shadow-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    );
  }
  return (
    <Collapsible defaultOpen={!defaultCollapsed}>
      <Card className="border-border/70 shadow-card">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer pb-2 hover:bg-muted/30">
            <CardTitle className="flex items-center justify-between text-sm font-semibold">
              {title}
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 [[data-state=closed]_&]:-rotate-90" />
            </CardTitle>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent>{children}</CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
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
