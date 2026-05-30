import {
  CircleCheck,
  CircleSlash,
  FolderOpen,
  HardDrive,
  Layers,
  Loader2,
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
import { EndGroupPanel } from "@/components/maldi/EndGroupPanel";
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
import { TemplatePanel } from "@/components/maldi/TemplatePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ALL_BUILTIN_ADDUCTS } from "@/lib/maldi/adducts";
import type { EndGroupCandidate } from "@/lib/maldi/endgroups";
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
import { PEAK_PRESETS, type PeakPickParams } from "@/lib/maldi/peaks";
import { peaksForRepeat, seriesForRepeat } from "@/lib/maldi/polymers";
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
  flagBackground,
  isCancelledError,
  parse,
  parseMs,
  pickPeaks,
  ping,
  process,
  solveEndGroups,
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
  const [endGroupCandidates, setEndGroupCandidates] = useState<EndGroupCandidate[]>([]);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  const [highlightedPeakIds, setHighlightedPeakIds] = useState<Set<string> | undefined>();
  // Split-series preview: a picked repeat unit broken into its distinct ladders.
  const [splitSeries, setSplitSeries] = useState(false);
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
  const [solving, setSolving] = useState(false);
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

  // Colour-coded peak groups for the plot: all ladders at once, or just the
  // isolated one when a single ladder is selected.
  const plotHighlightGroups = useMemo(() => {
    if (!repeatGroups.length) return undefined;
    return repeatGroups
      .map((g, i) => ({ key: String(i), color: SERIES_COLORS[i % SERIES_COLORS.length], ids: new Set(g.peakIds) }))
      .filter((g) => !selectedGroupKey || g.key === selectedGroupKey)
      .map((g) => ({ color: g.color, ids: g.ids }));
  }, [repeatGroups, selectedGroupKey]);

  // Every open document's display spectrum, for the overlay / stacked view modes.
  const docSpectra = useMemo<StackSpectrum[]>(() => {
    return documents
      .map((d) => {
        const spectrum = d.id === activeDocId ? processed ?? raw : d.state.processedSpectrum ?? d.state.rawSpectrum;
        return spectrum ? { id: d.id, name: d.name, spectrum } : null;
      })
      .filter((x): x is StackSpectrum => x !== null);
  }, [documents, activeDocId, processed, raw]);

  // Verify the compute worker on first mount and load the project list.
  useEffect(() => {
    let active = true;
    ping("maldi")
      .then(() => active && setWorkerStatus("ready"))
      .catch(() => active && setWorkerStatus("error"));
    refreshProjects();
    return () => {
      active = false;
    };
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
    setHighlightedPeakIds(ids);
  }, []);

  const resetDownstream = useCallback(() => {
    setPeaks([]);
    setSeries([]);
    setRepeatCandidates([]);
    setEndGroupCandidates([]);
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
    state.exportHistory = exportHistory;
    return state;
  }, [sourceName, raw, processed, steps, peaks, customAdducts, series, selectedAdductIds, pickParams, repeatMass, baseRepeat, exportHistory]);

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
    setExportHistory(s.exportHistory ?? []);
    setRepeatCandidates([]);
    setEndGroupCandidates([]);
    setLosses([]);
    setCopolymerSeries([]);
    setOverlay(null);
    setHighlightedPeakIds(undefined);
    setRepeatGroups([]);
    setSelectedGroupKey(null);
    setSelectedSeriesId(null);
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

  // --- Peak picking -----------------------------------------------------------
  const handlePick = useCallback(async () => {
    const target = processed ?? raw;
    if (!target) return;
    setPicking(true);
    try {
      const result = await pickPeaks(target, pickParams);
      const flagged = await flagBackground(result.peaks, { preserveExisting: true });
      setPeaks(flagged.peaks);
      setSeries([]);
      setLosses([]);
      setCopolymerSeries([]);
      highlightPeaks(undefined);
      const bg = Object.values(flagged.counts).reduce((a, b) => a + b, 0);
      toast.success(`Picked ${result.peaks.length} peaks${bg ? ` · flagged ${bg} background` : ""}`);
    } catch (error) {
      if (!isCancelledError(error)) {
        console.error(error);
        toast.error("Peak picking failed");
      }
    } finally {
      setPicking(false);
    }
  }, [processed, raw, pickParams, highlightPeaks]);

  // --- Repeat / series / end-groups ------------------------------------------
  const handleDetectRepeats = useCallback(async () => {
    setDetecting(true);
    try {
      const result = await detectRepeatUnits(peaks);
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
  }, [peaks]);

  // Preview the peaks that fit a repeat unit: either one lumped highlight, or —
  // when "split" is on — the distinct interleaved ladders, each its own colour.
  const previewRepeat = useCallback(
    (mass: number, split: boolean) => {
      setSelectedSeriesId(null);
      setSelectedGroupKey(null);
      if (split) {
        const groups = seriesForRepeat(peaks, mass);
        setRepeatGroups(groups);
        if (groups.length) {
          setHighlightedPeakIds(undefined); // colours come from the groups instead
          return;
        }
        // No clean ladders → fall back to the lumped preview.
      } else {
        setRepeatGroups([]);
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
      previewRepeat(mass, splitSeries);
    },
    [previewRepeat, splitSeries],
  );

  // Toggle split mode and re-preview the current repeat in the new mode.
  const handleToggleSplitSeries = useCallback(
    (on: boolean) => {
      setSplitSeries(on);
      if (repeatMass > 0) previewRepeat(repeatMass, on);
    },
    [repeatMass, previewRepeat],
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

  const handleSolveEndGroups = useCallback(async () => {
    setSolving(true);
    try {
      const result = await solveEndGroups(peaks, repeatMass, selectedAdducts);
      setEndGroupCandidates(result.candidates);
      if (result.candidates[0]) setEndGroupMass((cur) => (cur > 0 ? cur : Number(result.candidates[0].residualMass.toFixed(4))));
      toast.success(`${result.candidates.length} end-group candidates`);
    } catch (error) {
      console.error(error);
      toast.error("End-group solve failed");
    } finally {
      setSolving(false);
    }
  }, [peaks, repeatMass, selectedAdducts]);

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
    highlightPeaks(s ? new Set(s.members.map((m) => m.peakId)) : undefined);
  }, [highlightPeaks]);

  const handleHighlightAllSeries = useCallback(
    (all: boolean) => {
      setSelectedSeriesId(null);
      if (!all) {
        highlightPeaks(undefined);
        return;
      }
      const ids = new Set<string>();
      for (const s of series) for (const m of s.members) ids.add(m.peakId);
      highlightPeaks(ids.size ? ids : undefined);
    },
    [series, highlightPeaks],
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
    },
    [documents, activeDocId, loadState, clearLive],
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
  }, [clearLive]);

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
      endGroupCandidates,
      losses,
      molWeight: mw,
    });
  }, [peaks, series, allAdducts, repeatCandidates, endGroupCandidates, losses]);

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
    endGroupCandidates,
    losses,
    findings,
    spectrumPng: plotHandleRef.current?.getPng() ?? null,
  }), [projectName, sourceName, raw, peaks, series, allAdducts, repeatMass, endGroupCandidates, losses, findings]);

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
          <WorkerBadge status={workerStatus} />
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
              <SidebarCard title="Templates">
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
                  repeatMass={repeatMass}
                  onRepeatMassChange={setRepeatMass}
                  onSelectRepeatCandidate={handleSelectRepeatCandidate}
                  splitSeries={splitSeries}
                  onToggleSplitSeries={handleToggleSplitSeries}
                  repeatGroups={repeatGroupItems}
                  selectedGroupKey={selectedGroupKey}
                  onSelectGroup={handleSelectGroup}
                  series={series}
                  onAssignSeries={handleAssignSeries}
                  adducts={selectedAdducts}
                  peaks={peaks}
                  detectingRepeats={detecting}
                  assigning={assigning}
                  selectedSeriesId={selectedSeriesId}
                  onSelectSeries={handleSelectSeries}
                  onHighlightAll={handleHighlightAllSeries}
                />
              </SidebarCard>
              <SidebarCard title="End groups">
                <EndGroupPanel repeatMass={repeatMass} candidates={endGroupCandidates} onSolve={handleSolveEndGroups} adducts={selectedAdducts} busy={solving} />
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
                        />
                      </div>
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
                        <CompareView current={processed ?? raw} currentName={sourceName || "current"} comparisons={comparisons} onAddFiles={handleAddComparisons} onRemove={(id) => setComparisons((prev) => prev.filter((c) => c.id !== id))} busy={addingComparison} />
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

function SidebarCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="border-border/70 shadow-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function WorkerBadge({ status }: { status: WorkerStatus }) {
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
