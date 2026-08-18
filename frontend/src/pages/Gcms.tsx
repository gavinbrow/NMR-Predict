import {
  CircleCheck,
  CircleSlash,
  HelpCircle,
  HardDrive,
  Loader2,
  Pin,
  RotateCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { useGcmsUndo } from "@/hooks/useGcmsUndo";
import { ChromPeakTable } from "@/components/gcms/ChromPeakTable";
import { ChromatogramPanel } from "@/components/gcms/ChromatogramPanel";
import { ComparisonTray } from "@/components/gcms/ComparisonTray";
import { DocumentsPanel } from "@/components/gcms/DocumentsPanel";
import { ExportPanel, type ExportKind } from "@/components/gcms/ExportPanel";
import { GcmsFigurePanel } from "@/components/gcms/figure/GcmsFigurePanel";
import { useFigureOptions } from "@/components/ir/figure/useFigureOptions";
import { FragmentPanel } from "@/components/gcms/FragmentPanel";
import { ImportPanel } from "@/components/gcms/ImportPanel";
import { MetadataPanel } from "@/components/gcms/MetadataPanel";
import { SpectrumStack, type SpectrumStackPanel } from "@/components/gcms/SpectrumStack";
import { MsPredictPanel, type MsPredictMatchResult } from "@/components/gcms/predict/MsPredictPanel";
import { predictEiSpectrum, smilesToFormula } from "@/lib/gcms/predictMs";
import { matchPredictedSpectrumInRun } from "@/lib/gcms/predictMatch";
import { SpectrumPeakTable } from "@/components/gcms/SpectrumPeakTable";
import { TracesPanel } from "@/components/gcms/TracesPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { SERIES_COLORS } from "@/lib/maldi/seriesColor";
import {
  comparisonFingerprint,
  normalizeComparisonSpectrum,
  comparisonSpectrumLabel,
  type ComparisonLayout,
} from "@/lib/gcms/comparison";
import {
  buildBpc,
  buildDetectorTrace,
  buildTic,
  buildXic as buildXicMain,
  buildXics as buildXicsMain,
  combineScans,
  MAX_TRACE_SCALE,
  nearestScanIndex,
  scanSpectrum,
} from "@/lib/gcms/chrom";
import { applyBackgroundSubtraction, assemblePanels, resolveSlotsByRun } from "@/lib/gcms/slots";
import { subtractChromBackground } from "@/lib/gcms/chromBackground";
import { detectChromPeaks as detectChromPeaksMain } from "@/lib/gcms/peaks";
import { integratePeakRange, normalizeAreaPct, pickSpectrumPeaks, spectrumSimilarity } from "@/lib/gcms/peaks";
import type { DetectChromPeaksOpts } from "@/lib/gcms/peaks";
import { nearestIndex } from "@/lib/gcms/numerics";
import {
  chromatogramCsv,
  chromPeakCsv,
  downloadDataUrl,
  downloadText,
  metadataText,
  renderReportPng,
  renderReportSvg,
  spectrumCsv,
  spectrumMsp,
  spectrumPeakCsv,
  type ReportPanelSpec,
  type ReportTheme,
} from "@/lib/gcms/export";
import { buildGcmsFigureData, buildGcmsStackedFigureData, type GcmsFigureSpectrum, type GcmsFigureSubject } from "@/lib/gcms/figure";
import { collectDroppedFiles, loadGcmsFiles } from "@/lib/gcms/load";
import type {
  ChromPeak,
  ChromTrace,
  ComparisonSpectrumItem,
  GcmsDocument,
  MassSpectrum,
  MsRun,
  SpecPeak,
  SpectrumPeakRow,
  SpectrumSlot,
} from "@/lib/gcms/types";
import {
  buildXic as buildXicWorker,
  buildXics as buildXicsWorker,
  detectChromPeaks as detectChromPeaksWorker,
  disposeWorker,
  isCancelledError,
  ping,
  type CallOptions,
} from "@/lib/gcms/workerClient";
import type { ManualSpecPeak } from "@/lib/gcms/types";

type WorkerStatus = "checking" | "ready" | "error" | "fallback";

/** Sidebar cards that default open; every other card id defaults collapsed. */
const DEFAULT_CARD_OPEN: Record<string, boolean> = {
  import: true,
  traces: true,
};

/** The maximum number of open runs (the keep-alive memory cap). */
const MAX_OPEN_RUNS = 8;

/**
 * Default chromatographic peak-detection parameters — tuned for a real Agilent
 * GC run (3306 scans, TIC max ~889k): a wider Savitzky–Golay window, a threshold
 * of a few percent of the smoothed trace max (not a fraction of a percent) and
 * a minimum width well above one scan keep the detector off the dense baseline
 * noise. On the reference run this yields ~25 real chromatographic peaks
 * (verified in-browser) instead of the ~760 single-scan spikes the previous
 * 0.5%/3-scan defaults produced. Loosen (lower threshold / min width) in the
 * Processing card to pick up more; tighten to keep only dominant peaks.
 */
const DEFAULT_PEAK_PARAMS: DetectChromPeaksOpts = {
  smoothWindow: 11,
  thresholdPct: 5,
  minWidthScans: 13,
  baseline: "valley",
};

/**
 * Pick the trace colour for the next-opened document. Walks `SERIES_COLORS` by
 * a monotonically increasing counter (total documents ever created this
 * session) rather than the current live document count, so closing a document
 * can't cause a subsequent import to reuse a colour still held by an open
 * document. Mirrors `Maldi.tsx`'s `nextDocColor`.
 */
function nextDocColor(count: number): string {
  return SERIES_COLORS[count % SERIES_COLORS.length];
}

/** Resolve the GC/MS CSS theme tokens for the report renderer. */
function readReportTheme(): ReportTheme {
  const raw = (name: string): string => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!v) return "";
    if (v.startsWith("hsl")) return v;
    return `hsl(${v})`;
  };
  return {
    fg: raw("--foreground") || "hsl(222 47% 11%)",
    muted: raw("--muted-foreground") || "hsl(215 16% 45%)",
    border: raw("--border") || "hsl(214 25% 88%)",
    bg: raw("--card") || "hsl(0 0% 100%)",
  };
}

/** Resolve the app's --primary design token for fallback trace colours. */
function primaryToken(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  if (!raw) return "hsl(190 90% 38%)";
  return raw.startsWith("hsl") ? raw : `hsl(${raw})`;
}

/** Attach the base-peak m/z from the MS scan nearest a chromatographic apex.
 *  A chromatogram trace can have a different sample grid from the run's MS
 *  scans (notably UV/FID channels), so `peak.scanApex` is not a safe index
 *  into `run.basePeakMz`. */
function withBasePeakMz(peak: ChromPeak, run: MsRun | null): ChromPeak {
  if (!run) return { ...peak, basePeakMz: null };
  const scanIndex = nearestScanIndex(run, peak.rtApex);
  if (scanIndex < 0 || scanIndex >= run.basePeakMz.length) {
    return { ...peak, basePeakMz: null };
  }
  const mz = run.basePeakMz[scanIndex];
  return { ...peak, basePeakMz: Number.isFinite(mz) ? mz : null };
}

function chromatogramPeakSourceLabel(peak: ChromPeak, index: number): string {
  const identity = peak.name?.trim() || `Peak ${index + 1}`;
  return `${identity} · RT ${peak.rtApex.toFixed(3)} (${peak.rtStart.toFixed(3)}–${peak.rtEnd.toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// Phase 5 task D — manual (hand-added) peaks vs. the DERIVED peak lists.
//
// `chromPeaks`/`specPeaks` are DERIVED state: an effect overwrites them
// wholesale on every re-detect ("Detect peaks") or re-pick (the spectrum
// changing under the live cursor — which happens on every hover step). A
// manual peak appended directly into one of those arrays would vanish on the
// very next recompute. So manual peaks live in their OWN arrays, keyed by
// their OWNER:
//  - a chrom peak's owner is the TRACE it was integrated on (`traceId`,
//    already a `ChromPeak` field);
//  - a spec peak's owner is the RUN + SLOT it was picked against. `SpecPeak`
//    has no such key — widening the shared `types.ts` contract (other
//    packages are written against those exact field names) for one local
//    bookkeeping need isn't worth it, so it's extended here instead.
// Manual peaks are pruned only when their OWNER goes away (a trace deleted,
// a document closed) — never on an ordinary re-detect/re-pick — so a
// hand-added peak survives ten "Detect peaks" clicks or an afternoon of
// scrubbing the RT cursor, and is filtered back in the moment its trace/run
// is active again.
//
// Deleting a peak that turns out to be one of the DERIVED ones can't remove
// it from `chromPeaks`/`specPeaks` directly — that array gets clobbered by
// the next detection/pick regardless — so its id is added to a "dismissed"
// set instead and filtered out at merge time. Because every peak id is
// freshly minted per detection/pick (`peakId()` in lib/gcms/peaks.ts /
// `crypto.randomUUID()`), a stale dismissed id can never accidentally hide an
// unrelated future peak, so the dismissed sets don't strictly need clearing —
// they're cleared alongside their derived list anyway, purely for hygiene.


const Gcms = () => {
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>("checking");

  // --- Core page state -------------------------------------------------------
  const [documents, setDocuments] = useState<GcmsDocument[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [traces, setTraces] = useState<ChromTrace[]>([]);
  const [activeTraceId, setActiveTraceId] = useState<string | null>(null);
  const [hoverRt, setHoverRt] = useState<number | null>(null);
  const [pinnedRt, setPinnedRt] = useState<number | null>(null);
  // Zero or more highlighted RT windows (Phase 4 task D: shift-drag appends).
  // "Split regions" off -> all of them resolve into ONE summed range slot;
  // on -> each becomes its own stacked slot. Kept as its own piece of state
  // (rather than folded directly into `slots`) because it's the raw DRAG
  // state; the sync effect below (see "sel-*" slots) is what turns it into
  // slot(s), so a slot's user-chosen mode (e.g. flipped to "background")
  // survives a region being added/removed instead of resetting every drag.
  const [selections, setSelections] = useState<[number, number][]>([]);
  // The run whose visible chromatogram received the selection drag. This is
  // deliberately independent of the active document: a hidden active file
  // must never supply spectra for a visible file's RT selection.
  const [selectionRunId, setSelectionRunId] = useState<string | null>(null);
  const [splitRegions, setSplitRegions] = useState(false);
  const [mode, setMode] = useState<"zoom" | "select" | "background">("select");
  // Explicit spectrum slots for the bottom panel (Phase 4 task A). Slot 0
  // ("live") always follows the cursor (pin/hover/highest-TIC) and is never
  // removable. Every other slot is either synced from `selections` ("sel"/
  // "sel-N", see the effect below), the Ctrl-drag background window ("bg",
  // see `handleSelectRange`), or a frozen scan appended by "Add spectrum".
  const [slots, setSlots] = useState<SpectrumSlot[]>([
    { id: "live", source: { kind: "cursor" }, label: "Live", color: "", mode: "stack" },
  ]);
  // Palette cursor for slot swatches, walked forward only (never reused),
  // mirroring `docsCreatedCountRef` below.
  const slotColorCounterRef = useRef(0);
  const nextSlotColor = useCallback(() => {
    const c = SERIES_COLORS[slotColorCounterRef.current % SERIES_COLORS.length];
    slotColorCounterRef.current += 1;
    return c;
  }, []);
  const [normalize, setNormalize] = useState(false);
  const [stacked, setStacked] = useState(false);
  const [logY, setLogY] = useState(false);
  const [lockSpectraToCursor, setLockSpectraToCursor] = useState(false);
  const [comparisonItems, setComparisonItems] = useState<ComparisonSpectrumItem[]>([]);
  const [comparisonLayout, setComparisonLayout] = useState<ComparisonLayout>("overlay");
  const [comparisonNormalize, setComparisonNormalize] = useState(true);
  const [comparisonTolerance, setComparisonTolerance] = useState(0.1);
  const [bottomTab, setBottomTab] = useState("chrom-peaks");
  // Background-subtract the chromatogram with a blank sample (RT-domain).
  // Map of docId → blankDocId (or null). The derived `${activeDocId}-bg`
  // trace is built from the active doc's TIC minus the blank's TIC. "None"
  // (null) removes it. Closing either run drops the entry (see handleCloseDoc).
  const [backgroundBlankByDoc, setBackgroundBlankByDoc] = useState<Record<string, string | null>>({});
  const [chromPeaks, setChromPeaks] = useState<ChromPeak[]>([]);
  // Highlighted row in the chromatographic peak table. Derived from the peak
  // list, so it is cleared alongside it (peak ids are regenerated per run).
  const [selectedChromPeakId, setSelectedChromPeakId] = useState<string | null>(null);
  const [specPeaks, setSpecPeaks] = useState<SpecPeak[]>([]);
  const [spectrumPeakSourceId, setSpectrumPeakSourceId] = useState("live");
  // Manual peaks + "dismissed derived peak" sets (Phase 5 task D — see the
  // big comment above the component for why these are separate from
  // chromPeaks/specPeaks rather than appended into them).
  const [manualChromPeaks, setManualChromPeaks] = useState<ChromPeak[]>([]);
  const [manualSpecPeaks, setManualSpecPeaks] = useState<ManualSpecPeak[]>([]);
  const [dismissedChromPeakIds, setDismissedChromPeakIds] = useState<Set<string>>(new Set());
  const [dismissedSpecPeakIds, setDismissedSpecPeakIds] = useState<Set<string>>(new Set());
  const undo = useGcmsUndo();
  // "Add peak" toolbar toggle: while armed, a chromatogram DRAG defines the
  // exact peak integration range. Single clicks deliberately do nothing.
  const [addPeakArmed, setAddPeakArmed] = useState(false);
  const [fragmentHits, setFragmentHits] = useState<
    { rtMin: number; relPct: number; basePeakMz: number | null; abundance: number }[] | null
  >(null);
  const [similarity, setSimilarity] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ msg: string; frac: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [exportScale, setExportScale] = useState(2);
  const [peakParams, setPeakParams] = useState<DetectChromPeaksOpts>(DEFAULT_PEAK_PARAMS);

  interface DocViewState {
    pinnedRt: number | null;
    selections: [number, number][];
    selectionRunId: string | null;
    slots: SpectrumSlot[];
    chromPeaks: ChromPeak[];
    manualChromPeaks: ChromPeak[];
    dismissedChromPeakIds: Set<string>;
    selectedChromPeakId: string | null;
    peakParams: DetectChromPeaksOpts;
    splitRegions: boolean;
  }

  // Monotonically increasing palette cursor: advanced by 2 per document ever
  // created this session (TIC + BPC), never decremented on close, so closing a
  // document cannot make a later import reuse a live colour. Drives
  // `nextDocColor`.
  const docsCreatedCountRef = useRef(0);
  const prevActiveDocIdRef = useRef<string | null>(null);
  const docViewStateCacheRef = useRef<Map<string, DocViewState>>(new Map());

  // PNG-capture functions assigned by the plot components (chromatogram +
  // spectrum) so the export handlers can grab the rendered canvas.
  const chromCaptureRef = useRef<((scale?: number) => string | null) | null>(null);
  const spectrumCaptureRef = useRef<((scale?: number) => string | null) | null>(null);

  // --- Persisted sidebar collapse state ------------------------------------
  const [cardOpen, setCardOpen] = usePersistedState<Record<string, boolean>>(
    "gcms.sidebar.open",
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

  // --- Worker readiness check (with retries) --------------------------------
  const workerCheck = useRef(0);
  const checkWorker = useCallback(async () => {
    const token = (workerCheck.current += 1);
    setWorkerStatus("checking");
    const attempts = 4;
    for (let i = 0; i < attempts; i += 1) {
      try {
        await ping();
        if (workerCheck.current === token) setWorkerStatus("ready");
        return;
      } catch {
        if (workerCheck.current !== token) return;
        disposeWorker();
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        }
      }
    }
    // Worker failed to start — fall back to main thread. Show a warning badge
    // but never leave the user with a dead page.
    if (workerCheck.current === token) setWorkerStatus("fallback");
  }, []);

  useEffect(() => {
    void checkWorker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Global undo: Ctrl/Cmd+Z reverts the last peak action -----------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const isUndo = event.key.toLowerCase() === "z" && !event.shiftKey;
      if (!isUndo) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      const snapshot = undo.popSnapshot();
      if (!snapshot) {
        toast.message("Nothing to undo");
        return;
      }
      setChromPeaks(snapshot.chromPeaks);
      setManualChromPeaks(snapshot.manualChromPeaks);
      setDismissedChromPeakIds(snapshot.dismissedChromPeakIds);
      setSpecPeaks(snapshot.specPeaks);
      setManualSpecPeaks(snapshot.manualSpecPeaks);
      setDismissedSpecPeakIds(snapshot.dismissedSpecPeakIds);
      toast.success(`Undo: ${snapshot.label}`);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo]);

  // --- Derived: active document + run ---------------------------------------
  const activeDoc = useMemo(
    () => documents.find((d) => d.id === activeDocId) ?? null,
    [documents, activeDocId],
  );
  const activeRun = activeDoc?.run ?? null;

  // Map runId -> run name (for the traces panel group headings).
  const runNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of documents) m[d.run.id] = d.name;
    return m;
  }, [documents]);

  // The active trace: the visible curve the cursor/peaks follow. A trace can
  // be hidden either directly or through its owning document; never retain a
  // hidden id here because drag-to-add must integrate the curve the user can
  // actually see. Prefer a visible trace from the active run, then any visible
  // trace, and leave peak actions disabled when none remain.
  const effectiveActiveTraceId = useMemo(() => {
    const docVisibleByRun = new Map(documents.map((doc) => [doc.run.id, doc.visible]));
    const visible = traces.filter(
      (trace) => trace.visible && docVisibleByRun.get(trace.runId) !== false,
    );
    return (
      visible.find((trace) => trace.id === activeTraceId)?.id ??
      visible.find((trace) => (activeRun ? trace.runId === activeRun.id : true))?.id ??
      visible[0]?.id ??
      null
    );
  }, [activeTraceId, activeRun, documents, traces]);
  const activeTrace = useMemo(
    () => traces.find((t) => t.id === effectiveActiveTraceId) ?? null,
    [traces, effectiveActiveTraceId],
  );
  const activeTraceRun = useMemo(
    () => (activeTrace ? documents.find((d) => d.run.id === activeTrace.runId)?.run ?? null : null),
    [activeTrace, documents],
  );

  // Suggested XIC tolerance: 0.3 Da on a coarse m/z grid (>0.1 Da spacing),
  // 0.01 Da otherwise.
  const suggestedTol = useMemo(() => {
    if (!activeRun || activeRun.scanCount === 0) return 0.3;
    const span = activeRun.mzRange[1] - activeRun.mzRange[0];
    const pts = activeRun.pointCount;
    if (pts === 0) return 0.3;
    const spacing = span / pts;
    return spacing > 0.1 ? 0.3 : 0.01;
  }, [activeRun]);

  // Merge derived + manual peaks for display/table/export (task D). Manual
  // chrom peaks are filtered to the ACTIVE TRACE (their owner); manual spec
  // peaks to the active RUN's "live" slot (spec peaks have no slot of their
  // own beyond that — see the ManualSpecPeak comment above the component).
  // Dismissed ids drop derived peaks the user deleted (manual deletes just
  // remove the element outright — see handleChromPeakDelete/
  // handleSpecPeakDelete below). areaPct is recomputed HERE, not baked in at
  // add-time, so the percentages always reflect the currently-merged set,
  // whether that's a fresh detection alone or a detection plus hand-added
  // peaks. Declared early (ahead of `spectrumPanels` below, which reads
  // `displayedSpecPeaks`) since these are consumed well before the effects
  // that populate the underlying `chromPeaks`/`specPeaks` are declared.
  const displayedChromPeaks = useMemo(() => {
    const derived = chromPeaks.filter((p) => !dismissedChromPeakIds.has(p.id));
    const manual = manualChromPeaks.filter(
      (p) => p.traceId === effectiveActiveTraceId && !dismissedChromPeakIds.has(p.id),
    );
    return normalizeAreaPct([...derived, ...manual]).sort((a, b) => a.rtApex - b.rtApex);
  }, [chromPeaks, manualChromPeaks, effectiveActiveTraceId, dismissedChromPeakIds]);

  const displayedSpecPeaks = useMemo(() => {
    const derived = specPeaks.filter((p) => !dismissedSpecPeakIds.has(p.id));
    const manual = activeRun
      ? manualSpecPeaks.filter(
          (p) => p.runId === activeRun.id && p.slotId === "live" && !dismissedSpecPeakIds.has(p.id),
        )
      : [];
    return [...derived, ...manual].sort((a, b) => a.mz - b.mz);
  }, [specPeaks, manualSpecPeaks, activeRun, dismissedSpecPeakIds]);

  // --- The spectrum shown in the bottom panel — the core interaction ---------
  // The chromatogram's cursor line simply follows pin/hover now — item 8
  // means a selection no longer suppresses or replaces it: selections are
  // separate stacked "range" slots (below), not a takeover of the live view.
  const cursorRt = useMemo(() => pinnedRt ?? hoverRt, [pinnedRt, hoverRt]);

  // The RT slot 0 ("live") resolves to: pinned > hover > highest-TIC scan.
  // Factored out of the old `spectra` memo so "Add spectrum" (which freezes
  // exactly this RT into a new slot) and the peak-table/export code (which
  // need "the live spectrum" specifically) share one definition.
  const liveRt = useMemo(() => {
    if (!activeRun || activeRun.scanCount === 0) return null;
    if (pinnedRt != null) return pinnedRt;
    if (hoverRt != null) return hoverRt;
    let max = -Infinity;
    let idx = 0;
    for (let i = 0; i < activeRun.scanCount; i += 1) {
      if (activeRun.tic[i] > max) {
        max = activeRun.tic[i];
        idx = i;
      }
    }
    return activeRun.rtMin[idx];
  }, [activeRun, pinnedRt, hoverRt]);

  // --- Slot resolution (Phase 4 task A) --------------------------------------
  // 1. resolveSlots: every slot's SOURCE -> its own spectrum, regardless of
  //    mode (reuses scanSpectrum/nearestScanIndex/combineScans exactly as the
  //    pre-Phase-4 memo above did).
  // 2. applyBackgroundSubtraction: THEN subtract every background-mode slot's
  //    spectrum from every other slot's. Order matters — see the doc comment
  //    on that function for why background slots must resolve first and are
  //    never themselves subtracted from.
  const resolvedSlots = useMemo(
    () => resolveSlotsByRun(slots, activeRun, liveRt, documents.map((document) => document.run)),
    [slots, activeRun, liveRt, documents],
  );
  const subtractedSlots = useMemo(
    () => applyBackgroundSubtraction(resolvedSlots),
    [resolvedSlots],
  );
  const liveSpectrum = useMemo<MassSpectrum | null>(
    () => subtractedSlots.find((r) => r.slot.id === "live")?.spectrum ?? null,
    [subtractedSlots],
  );

  const spectrumPeakSources = useMemo(
    () => [
      { id: "live", label: "Live peak view" },
      ...(displayedChromPeaks.length > 0
        ? [
            {
              id: "chrom:all",
              label: `All chromatogram peaks (${displayedChromPeaks.length})`,
            },
          ]
        : []),
      ...displayedChromPeaks.map((peak, index) => ({
        id: `chrom:${peak.id}`,
        label: chromatogramPeakSourceLabel(peak, index),
      })),
    ],
    [displayedChromPeaks],
  );

  // Keep the source selector valid when peak detection, deletion, or a trace
  // switch removes the chromatographic peak it previously referenced.
  useEffect(() => {
    if (!spectrumPeakSources.some((source) => source.id === spectrumPeakSourceId)) {
      setSpectrumPeakSourceId("live");
    }
  }, [spectrumPeakSourceId, spectrumPeakSources]);

  const displayedSpectrumPeakRows = useMemo<SpectrumPeakRow[]>(() => {
    if (spectrumPeakSourceId === "live") {
      return displayedSpecPeaks.map((peak) => ({ ...peak, sourceLabel: "Live view" }));
    }

    const wanted =
      spectrumPeakSourceId === "chrom:all"
        ? displayedChromPeaks
        : displayedChromPeaks.filter(
            (peak) => `chrom:${peak.id}` === spectrumPeakSourceId,
          );
    const sourceIndex = new Map(
      displayedChromPeaks.map((peak, index) => [peak.id, index] as const),
    );

    return wanted.flatMap((chromPeak) => {
      const run = documents.find((document) => document.run.id === chromPeak.runId)?.run;
      if (!run) return [];
      const spectrum = combineScans(run, chromPeak.rtStart, chromPeak.rtEnd, "sum");
      const label = chromatogramPeakSourceLabel(
        chromPeak,
        sourceIndex.get(chromPeak.id) ?? 0,
      );
      return pickSpectrumPeaks(spectrum, {
        thresholdPct: 1,
        maxPeaks: 200,
        minSeparationMz: 0.3,
      }).map((peak) => ({
        ...peak,
        id: `${chromPeak.id}:${peak.id}`,
        sourcePeakId: chromPeak.id,
        sourceLabel: label,
        sourceRtStart: chromPeak.rtStart,
        sourceRtEnd: chromPeak.rtEnd,
      }));
    });
  }, [displayedChromPeaks, displayedSpecPeaks, documents, spectrumPeakSourceId]);

  const spectrumPeakRun = useMemo(() => {
    if (spectrumPeakSourceId === "live") return activeRun;
    const sourcePeak =
      spectrumPeakSourceId === "chrom:all"
        ? displayedChromPeaks[0]
        : displayedChromPeaks.find(
            (peak) => `chrom:${peak.id}` === spectrumPeakSourceId,
          );
    return sourcePeak
      ? documents.find((document) => document.run.id === sourcePeak.runId)?.run ?? null
      : null;
  }, [activeRun, displayedChromPeaks, documents, spectrumPeakSourceId]);

  // Effective trace visibility = doc.visible AND trace.visible. The
  // chromatogram filters on both so unchecking a file in the Documents panel
  // drops its TIC/BPC/XIC traces from the plot (the spectrum panel still
  // follows the active doc regardless of chromatogram visibility).
  const docVisibleByRunId = useMemo<Map<string, boolean>>(() => {
    const m = new Map<string, boolean>();
    for (const d of documents) m.set(d.run.id, d.visible);
    return m;
  }, [documents]);

  // Derived background-subtracted chromatogram trace(s): one per entry in
  // `backgroundBlankByDoc`. Built from the SAMPLE doc's TIC minus the BLANK
  // doc's TIC, aligned by RT, clamped ≥0. Pure: recomputed whenever either
  // run's traces or the blank map changes.
  const bgTraces = useMemo<ChromTrace[]>(() => {
    const out: ChromTrace[] = [];
    for (const [docId, blankDocId] of Object.entries(backgroundBlankByDoc)) {
      if (!blankDocId) continue;
      const sampleDoc = documents.find((d) => d.id === docId);
      const blankDoc = documents.find((d) => d.id === blankDocId);
      if (!sampleDoc || !blankDoc) continue;
      const sampleTic = traces.find((t) => t.runId === sampleDoc.run.id && t.kind === "TIC");
      const blankTic = traces.find((t) => t.runId === blankDoc.run.id && t.kind === "TIC");
      if (!sampleTic || !blankTic) continue;
      out.push(subtractChromBackground(sampleTic, blankTic));
    }
    return out;
  }, [backgroundBlankByDoc, documents, traces]);

  /** The exact trace set drawn in the chromatogram. Reused for every
   * chromatogram export so separated XICs, document visibility, and derived
   * background traces are consistently WYSIWYG. */
  const visibleChromTraces = useMemo(
    () =>
      [...traces, ...bgTraces].filter(
        (trace) => trace.visible && (trace.kind === "TIC-bg" || docVisibleByRunId.get(trace.runId) !== false),
      ),
    [bgTraces, docVisibleByRunId, traces],
  );

  /**
   * Whether there is a chromatogram worth drawing at all.
   *
   * Direct-infusion and single-scan acquisitions (a Waters `.raw` shot into the
   * source, an imported single spectrum) have a time axis one point wide: a
   * chromatogram of one dot, a zero-width RT scale, and nothing to integrate.
   * Rather than draw that degenerate panel and offer controls that can only
   * fail, the workspace gives the whole plot card to the spectrum and gates the
   * chromatogram-only affordances off this flag.
   */
  const hasChromatogram = useMemo(
    () => visibleChromTraces.some((trace) => trace.rtMin.length >= 2),
    [visibleChromTraces],
  );

  // "Lock spectra to cursor RT" (pre-existing, cross-DOCUMENT feature — every
  // visible OTHER document's own scan at the live RT) is orthogonal to the
  // single-run slot model above, so it's bolted onto the "live" panel as
  // extra overlay entries rather than folded into `resolveSlots`.
  const liveOverlaySpectra = useMemo<{ spectrum: MassSpectrum; id: string; color: string }[]>(() => {
    if (!lockSpectraToCursor || liveRt == null) return [];
    const out: { spectrum: MassSpectrum; id: string; color: string }[] = [];
    for (const d of documents) {
      if (!d.visible || d.id === activeDocId) continue;
      if (d.run.scanCount === 0) continue;
      const idx = nearestScanIndex(d.run, liveRt);
      if (idx < 0) continue;
      // Normalise each overlay to its OWN base peak so a minor component
      // isn't dwarfed by a dominant one on the shared intensity axis. The
      // primary (live) spectrum stays true-intensity; only overlays scale.
      const raw = scanSpectrum(d.run, idx);
      let base = 0;
      for (let i = 0; i < raw.intensity.length; i += 1) {
        if (raw.intensity[i] > base) base = raw.intensity[i];
      }
      let spectrum = raw;
      if (base > 0) {
        const normI = new Float64Array(raw.intensity.length);
        for (let i = 0; i < raw.intensity.length; i += 1) {
          normI[i] = (raw.intensity[i] / base) * 100;
        }
        spectrum = { ...raw, intensity: normI };
      }
      out.push({ spectrum, id: d.id, color: d.color });
    }
    return out;
  }, [lockSpectraToCursor, liveRt, documents, activeDocId]);

  // Assemble resolved+subtracted slots into rendered panels ("overlay" slots
  // fold into the preceding stack/background panel), then attach display
  // colour/peaks/title. The live panel's colour tracks the ACTIVE DOCUMENT's
  // colour dynamically (so re-colouring a document in the Documents panel
  // re-colours its live spectrum too) rather than a colour stored on the slot.
  const spectrumPanels = useMemo<SpectrumStackPanel[]>(() => {
    const assembled = assemblePanels(subtractedSlots);
    return assembled.map((p) => {
      const isLive = p.slot.id === "live";
      const spectra = p.entries.map((e) => e.spectrum);
      const ids = p.entries.map((e) => e.slot.id);
      const colors = p.entries.map((e) =>
        e.slot.id === "live" ? activeDoc?.color ?? primaryToken() : e.slot.color,
      );
      // entries[0] IS this panel's own (anchor) slot; anything after it is an
      // "overlay"-mode slot folded in by assemblePanels — those need their
      // OWN header row (see SpectrumStack) even though they share this
      // panel's plot, or a user could never un-overlay/remove one again.
      const overlaySlots = p.entries.slice(1).map((e) => e.slot);
      const overlayPeaks: { peaks: SpecPeak[]; color: string }[] = [];
      if (isLive) {
        for (const extra of liveOverlaySpectra) {
          spectra.push(extra.spectrum);
          ids.push(extra.id);
          colors.push(extra.color);
          overlayPeaks.push({
            peaks: pickSpectrumPeaks(extra.spectrum, { thresholdPct: 10, maxPeaks: 8, minSeparationMz: 0.3 }),
            color: extra.color,
          });
        }
      }
      // The live plot uses the host-level `displayedSpecPeaks`, which the user
      // can dismiss/edit. Non-live panels (selections, frozen "Add spectrum"
      // slots) pick their OWN peaks from their anchor spectrum so the user
      // sees m/z labels on every panel, not just the live one — bug 3.
      const anchorSpec = p.entries[0]?.spectrum;
      const peaks = isLive
        ? displayedSpecPeaks
        : anchorSpec
          ? pickSpectrumPeaks(anchorSpec, { thresholdPct: 1, maxPeaks: 200, minSeparationMz: 0.3 })
          : [];
      return {
        slot: p.slot,
        overlaySlots,
        spectra,
        ids,
        colors,
        peaks,
        overlayPeaks: isLive ? overlayPeaks : [],
        title: p.entries[0]?.spectrum.label ?? p.slot.label,
      };
    });
  }, [subtractedSlots, activeDoc, liveOverlaySpectra, displayedSpecPeaks]);

  // Which slot governs each entry in `selections` (aligned by index): "sel-N"
  // when regions are split into separate panels, otherwise the single shared
  // "sel" slot governs every entry. Drives both bug 1 (colour each
  // chromatogram band like its spectrum panel) and bug 2 (below).
  const selectionDisplay = useMemo(
    () =>
      selections.map((region, i) => {
        const id = splitRegions ? `sel-${i}` : "sel";
        const slot = slots.find((s) => s.id === id);
        return { region, color: slot?.color, mode: slot?.mode ?? "stack" };
      }),
    [selections, splitRegions, slots],
  );

  // Bug 2 fix: a region whose owning slot has been switched to "background"
  // mode is a SUBTRACTION source, not something to sample — it should not
  // ALSO show up as an ordinary highlighted selection band (it's already
  // visible in its own spectrum-stack panel via the colour swatch). The old
  // dashed "background band" (fed by a special "bg"-id slot) is dropped for
  // the same reason: it duplicated whatever the sample selection already
  // shows, which is exactly "it has both" from the bug report.
  const visibleSelections = useMemo<[number, number][]>(
    () => selectionDisplay.filter((d) => d.mode !== "background").map((d) => d.region),
    [selectionDisplay],
  );
  const visibleSelectionColors = useMemo<string[]>(
    () => selectionDisplay.filter((d) => d.mode !== "background").map((d) => d.color ?? ""),
    [selectionDisplay],
  );

  // Sync `selections`/`splitRegions` into `slots` as "sel" (merged) or
  // "sel-N" (split) entries. A positional merge (replace existing ids in
  // place, append only brand-new ones, drop stale ones) so a slot's
  // user-chosen mode (e.g. flipped to "overlay") SURVIVES a region being
  // added/removed rather than resetting to "stack" every drag.
  useEffect(() => {
    setSlots((prev) => {
      const desired = new Map<string, SpectrumSlot>();
      if (splitRegions) {
        selections.forEach((region, i) => {
          const id = `sel-${i}`;
          const ex = prev.find((s) => s.id === id);
          desired.set(id, {
            id,
            source: { kind: "range", regions: [region] },
            runId: selectionRunId ?? undefined,
            label: `Selection ${i + 1}`,
            color: ex?.color ?? nextSlotColor(),
            mode: ex?.mode ?? "stack",
          });
        });
      } else if (selections.length > 0) {
        const ex = prev.find((s) => s.id === "sel");
        desired.set("sel", {
          id: "sel",
          source: { kind: "range", regions: selections },
          runId: selectionRunId ?? undefined,
          label: "Selection",
          color: ex?.color ?? nextSlotColor(),
          mode: ex?.mode ?? "stack",
        });
      }
      const isSelId = (id: string) => id === "sel" || /^sel-\d+$/.test(id);
      const kept = prev.filter((s) => !isSelId(s.id) || desired.has(s.id));
      const merged = kept.map((s) => (isSelId(s.id) ? desired.get(s.id)! : s));
      const existingIds = new Set(prev.map((s) => s.id));
      const toAppend = [...desired.values()].filter((d) => !existingIds.has(d.id));
      if (toAppend.length === 0 && merged.length === prev.length) {
        // Nothing changed (common steady state: no selections, no sel-*
        // slots) — bail out so this effect doesn't cause an extra render.
        let same = true;
        for (let i = 0; i < merged.length; i += 1) {
          if (merged[i] !== prev[i]) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return [...merged, ...toAppend];
    });
  }, [selections, selectionRunId, splitRegions, nextSlotColor]);

  // Re-pick spectrum peaks whenever the LIVE spectrum changes (not every
  // panel — peak-table/XIC actions are tied to the live scan specifically).
  useEffect(() => {
    if (!liveSpectrum) {
      setSpecPeaks([]);
      setDismissedSpecPeakIds(new Set());
      return;
    }
    const picked = pickSpectrumPeaks(liveSpectrum, {
      thresholdPct: 1,
      maxPeaks: 200,
      minSeparationMz: 0.3,
    });
    setSpecPeaks(picked);
    // Fresh ids every recompute (peakId() in lib/gcms/peaks.ts) — a stale
    // dismissed id could never match anyway, this just bounds the set's size.
    setDismissedSpecPeakIds(new Set());
  }, [liveSpectrum]);

  // Clear chromatographic peaks (and dependent selection state) whenever the
  // effective active trace changes — peaks belong to a specific trace and
  // would otherwise linger on the wrong chromatogram after a switch.
  const prevActiveTraceIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevActiveTraceIdRef.current !== effectiveActiveTraceId) {
      prevActiveTraceIdRef.current = effectiveActiveTraceId;
      setChromPeaks([]);
      setDismissedChromPeakIds(new Set());
      // Disarm "Add peak" on a trace switch — arming is a per-trace mode, and
      // leaving it armed across a switch risks a click landing on the wrong
      // trace's data without the user re-confirming the mode.
      setAddPeakArmed(false);
      setFragmentHits(null);
      setSimilarity(null);
    }
  }, [effectiveActiveTraceId]);

  // Per-document view state: capture the prev doc's state and restore the
  // new doc's state on every active-doc change.
  useEffect(() => {
    const prevId = prevActiveDocIdRef.current;
    const newId = activeDocId;
    prevActiveDocIdRef.current = newId;
    // Capture prev (if it still has a cache entry — close handler deletes
    // the entry, so a closed doc skips capture).
    if (prevId && prevId !== newId && docViewStateCacheRef.current.has(prevId)) {
      docViewStateCacheRef.current.set(prevId, {
        pinnedRt,
        selections,
        selectionRunId,
        slots: slots.filter((s) => s.id !== "live"),
        chromPeaks,
        manualChromPeaks,
        dismissedChromPeakIds,
        selectedChromPeakId,
        peakParams,
        splitRegions,
      });
    }
    // Undo history is tied to the current document's peak ids.
    undo.clear();
    // Restore new (if any).
    if (newId && prevId !== newId) {
      const cached = docViewStateCacheRef.current.get(newId);
      if (cached) {
        setPinnedRt(cached.pinnedRt);
        setSelections(cached.selections);
        setSelectionRunId(cached.selectionRunId);
        // Merge cached non-live slots back in front of the always-present
        // "live" slot. "live" is never cached (it's re-derived from the
        // cursor) so it stays as the initializer created it.
        setSlots((prev) => {
          const live = prev.find((s) => s.id === "live");
          return live ? [live, ...cached.slots] : cached.slots;
        });
        setChromPeaks(cached.chromPeaks);
        setManualChromPeaks(cached.manualChromPeaks);
        setDismissedChromPeakIds(cached.dismissedChromPeakIds);
        setSelectedChromPeakId(cached.selectedChromPeakId);
        setPeakParams(cached.peakParams);
        setSplitRegions(cached.splitRegions);
        setFragmentHits(null);
        setSimilarity(null);
      } else {
        // Fresh doc — reset to defaults.
        setPinnedRt(null);
        setSelections([]);
        setSelectionRunId(null);
        setSlots((prev) => prev.filter((s) => s.id === "live"));
        setChromPeaks([]);
        setDismissedChromPeakIds(new Set());
        setSelectedChromPeakId(null);
        setFragmentHits(null);
        setSimilarity(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocId]);

  // --- Figure tab state, hoisted to the always-mounted host -----------------
  // The Figure tab's TabsContent has no forceMount, so keeping this state
  // inside GcmsFigurePanel would mean every tab switch tore it down and
  // discarded the user's in-progress figure. Mirrors Maldi.tsx's "Figure tab
  // state hoisted to the always-mounted host" block exactly.
  // "Predict MS" tab state: SMILES + last match result, hoisted to the page
  // so a tab switch never discards the user's drawing or result. The panel
  // itself is presentational; this state is what survives the round-trip.
  const [predictSmiles, setPredictSmiles] = useState("");
  const [figSubject, setFigSubject] = useState<GcmsFigureSubject>("chromatogram");
  /** Import setting: centroid vendor continuum data (Waters .raw) on load. */
  const [centroidOnImport, setCentroidOnImport] = useState(true);
  // Empty set = "include everything currently available" (every visible
  // trace / every resolved spectrum slot); ticking one or more narrows to
  // just those ids. Mirrors MALDI's Figure "Series" picker (`figSeriesIds`).
  const [figIncludedTraceIds, setFigIncludedTraceIds] = useState<Set<string>>(() => new Set());
  const [figIncludedSlotIds, setFigIncludedSlotIds] = useState<Set<string>>(() => new Set());
  const [figLabelPeaks, setFigLabelPeaks] = useState(true);
  const [figStackSpectra, setFigStackSpectra] = useState(false);
  // Figure-only peak hides: the peak stays in the Chrom./Spectrum peak tables
  // and every export — only its stick/line label is dropped from THIS
  // figure. Peak ids are freshly minted on every detect/pick (see the
  // ManualSpecPeak comment above the component), so a re-detect can never
  // strand a stale id onto an unrelated new peak; this set is never pruned.
  const [figExcludedPeakIds, setFigExcludedPeakIds] = useState<Set<string>>(() => new Set());

  const figCandidateTraces = useMemo(
    () => visibleChromTraces,
    [visibleChromTraces],
  );
  const figIncludedTraces = useMemo(
    () =>
      figIncludedTraceIds.size === 0
        ? figCandidateTraces
        : figCandidateTraces.filter((t) => figIncludedTraceIds.has(t.id)),
    [figCandidateTraces, figIncludedTraceIds],
  );

  // Every resolved (and background-subtracted) spectrum slot, wrapped with
  // the colour it's already drawn with on screen — the "live" slot's colour
  // tracks the active document's colour dynamically, exactly like
  // `spectrumPanels` above. `subtractedSlots[0]` is always the "live" slot
  // when it resolves (slot 0 is always "live" per the `slots` state's
  // initializer), so it lands first here too, matching the adapter's
  // "spectra[0] is primary" convention used for spec-peak labels.
  const figCandidateSpectra = useMemo<GcmsFigureSpectrum[]>(
    () => {
      const activeCandidates = subtractedSlots.map((r) => ({
        id: r.slot.id,
        label: r.slot.id === "live" ? r.spectrum.label : r.slot.label,
        color: r.slot.id === "live" ? activeDoc?.color ?? primaryToken() : r.slot.color,
        spectrum: r.spectrum,
        peaks:
          r.slot.id === "live"
            ? displayedSpecPeaks.filter((peak) => !figExcludedPeakIds.has(peak.id))
            : pickSpectrumPeaks(r.spectrum, {
                thresholdPct: 1,
                maxPeaks: 200,
                minSeparationMz: 0.3,
              }).filter((peak) => !figExcludedPeakIds.has(peak.id)),
      }));
      let comparisonBaseline = 0;
      const comparisonCandidates = comparisonItems.map((item) => {
        const displaySpectrum = comparisonNormalize
          ? normalizeComparisonSpectrum(item.spectrum)
          : item.spectrum;
        let max = 0;
        for (const value of displaySpectrum.intensity) {
          if (Number.isFinite(value) && value > max) max = value;
        }
        let originalMax = 0;
        for (const value of item.spectrum.intensity) {
          if (Number.isFinite(value) && value > originalMax) originalMax = value;
        }
        const peakScale =
          comparisonNormalize && originalMax > 0 ? 100 / originalMax : 1;
        const rawPeaks = item.peaks
          .filter((peak) => !figExcludedPeakIds.has(peak.id))
          .map((peak) => ({
            ...peak,
            intensity: peak.intensity * peakScale,
          }));
        const baseline = comparisonLayout === "stacked" ? comparisonBaseline : undefined;
        const spectrum =
          baseline == null || baseline === 0
            ? displaySpectrum
            : {
                ...displaySpectrum,
                intensity: Float64Array.from(
                  displaySpectrum.intensity,
                  (value) => value + baseline,
                ),
              };
        const peaks =
          baseline == null || baseline === 0
            ? rawPeaks
            : rawPeaks.map((peak) => ({
                ...peak,
                intensity: peak.intensity + baseline,
              }));
        if (comparisonLayout === "stacked") comparisonBaseline += max * 1.15;
        return {
          id: `comparison:${item.id}`,
          label: item.label,
          color: item.color,
          spectrum,
          peaks,
          baseline,
        };
      });
      return [...activeCandidates, ...comparisonCandidates];
    },
    [
      subtractedSlots,
      activeDoc,
      displayedSpecPeaks,
      comparisonItems,
      comparisonNormalize,
      comparisonLayout,
      figExcludedPeakIds,
    ],
  );
  const figIncludedSpectra = useMemo(
    () =>
      figIncludedSlotIds.size === 0
        ? figCandidateSpectra
        : figCandidateSpectra.filter((s) => figIncludedSlotIds.has(s.id)),
    [figCandidateSpectra, figIncludedSlotIds],
  );
  const figSpectrumSourceName = useMemo(
    () =>
      figIncludedSpectra.some((entry) => entry.id.startsWith("comparison:"))
        ? "gcms_comparison"
        : activeDoc?.name,
    [figIncludedSpectra, activeDoc],
  );

  const figShownChromPeaks = useMemo(
    () => displayedChromPeaks.filter((p) => !figExcludedPeakIds.has(p.id)),
    [displayedChromPeaks, figExcludedPeakIds],
  );
  const figShownSpecPeaks = useMemo(
    () => displayedSpecPeaks.filter((p) => !figExcludedPeakIds.has(p.id)),
    [displayedSpecPeaks, figExcludedPeakIds],
  );
  const figHiddenPeakCount = useMemo(
    () =>
      displayedChromPeaks.filter((p) => figExcludedPeakIds.has(p.id)).length +
      displayedSpecPeaks.filter((p) => figExcludedPeakIds.has(p.id)).length +
      comparisonItems.reduce(
        (count, item) =>
          count + item.peaks.filter((peak) => figExcludedPeakIds.has(peak.id)).length,
        0,
      ),
    [displayedChromPeaks, displayedSpecPeaks, comparisonItems, figExcludedPeakIds],
  );

  // The figure-engine data: recomputed whenever the include selections or
  // merged peak lists change; `useFigureOptions` below carries the user's
  // styling across those updates (`reconcileFigureOptions`).
  // Chromatogram figure data (always built; the subject only controls which
  // FigureMaker(s) render, so switching subject preserves the other figure's
  // styling). "both" renders this on top of the spectrum figure below.
  const chromFigureData = useMemo(
    () =>
      buildGcmsFigureData({
        subject: "chromatogram",
        traces: figIncludedTraces,
        spectra: [],
        chromPeaks: figShownChromPeaks,
        specPeaks: [],
        labelPeaks: figLabelPeaks,
        sourceName: activeDoc?.name,
      }),
    [figIncludedTraces, figShownChromPeaks, figLabelPeaks, activeDoc],
  );
  const specFigureData = useMemo(
    () =>
      buildGcmsFigureData({
        subject: "spectrum",
        traces: [],
        spectra: figIncludedSpectra,
        chromPeaks: [],
        specPeaks: figShownSpecPeaks,
        labelPeaks: figLabelPeaks,
        stackSpectra: figStackSpectra,
        sourceName: figSpectrumSourceName,
      }),
    [figIncludedSpectra, figShownSpecPeaks, figLabelPeaks, figStackSpectra, figSpectrumSourceName],
  );
  const [chromFigureOptions, setChromFigureOptions] = useFigureOptions(chromFigureData);
  const [specFigureOptions, setSpecFigureOptions] = useFigureOptions(specFigureData);
  // The "both" subject builds ONE stacked figure (chromatogram above the
  // spectrum, sharing a single normalized x-axis) so the user gets a single
  // FigureMaker UI and a single exported image — what the bug report asked
  // for instead of two side-by-side figure makers. Built from the same
  // included traces + spectra + shown peaks as the two single-subject figures.
  const bothFigureData = useMemo(
    () =>
      buildGcmsStackedFigureData({
        traces: figIncludedTraces,
        spectra: figIncludedSpectra,
        chromPeaks: figShownChromPeaks,
        specPeaks: figShownSpecPeaks,
        labelPeaks: figLabelPeaks,
        sourceName: figSpectrumSourceName,
      }),
    [
      figIncludedTraces,
      figIncludedSpectra,
      figShownChromPeaks,
      figShownSpecPeaks,
      figLabelPeaks,
      figSpectrumSourceName,
    ],
  );
  const [bothFigureOptions, setBothFigureOptions] = useFigureOptions(bothFigureData);

  const handleToggleFigTrace = useCallback((id: string) => {
    setFigIncludedTraceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const handleToggleFigSlot = useCallback((id: string) => {
    setFigIncludedSlotIds((prev) => {
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

  // --- Import ----------------------------------------------------------------
  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setBusy(true);
      setErrors([]);
      try {
        const { runs, errors: loadErrors } = await loadGcmsFiles(
          files,
          (msg, frac) => setProgress({ msg, frac }),
          { centroid: centroidOnImport },
        );
        setProgress(null);
        setErrors(loadErrors);
        if (runs.length > 0) {
          // CAP the number of open runs at 8 (refuse the 9th with a toast).
          const remainingSlots = MAX_OPEN_RUNS - documents.length;
          if (remainingSlots <= 0) {
            toast.error(`Maximum of ${MAX_OPEN_RUNS} open runs — close one first.`);
            setBusy(false);
            return;
          }
          const accepted = runs.slice(0, remainingSlots);
          const rejected = runs.length - accepted.length;
          if (rejected > 0) {
            toast.warning(
              `Opened ${accepted.length} run${accepted.length === 1 ? "" : "s"}; ${rejected} not opened (max ${MAX_OPEN_RUNS}).`,
            );
          }

          const newDocs: GcmsDocument[] = [];
          const newTraces: ChromTrace[] = [];
          for (const run of accepted) {
            const colorStart = docsCreatedCountRef.current;
            const color = nextDocColor(colorStart);
            const detectorChannels = run.chromatograms ?? [];
            docsCreatedCountRef.current += 2 + detectorChannels.length;
            const docId = crypto.randomUUID();
            newDocs.push({ id: docId, name: run.name, run, color, visible: true, offset: 0 });
            // Seed a default cache entry so the very FIRST switch away from
            // this doc captures its state (the capture path's `has(prevId)`
            // guard requires an entry to already exist — bug 6). Without this,
            // a doc's first switch-away silently drops its selection/peaks.
            docViewStateCacheRef.current.set(docId, {
              pinnedRt: null,
              selections: [],
              selectionRunId: null,
              slots: [],
              chromPeaks: [],
              manualChromPeaks: [],
              dismissedChromPeakIds: new Set(),
              selectedChromPeakId: null,
              peakParams: DEFAULT_PEAK_PARAMS,
              splitRegions: false,
            });
            // TIC + BPC per run. The BPC gets the NEXT palette entry, not the
            // document colour — drawn in the same colour the two traces are
            // indistinguishable where they overlap. It also starts hidden, so
            // the first view is the plain TIC (what the instrument software
            // shows); the Traces panel toggles it on.
            const tic = buildTic(run);
            tic.color = color;
            const bpc = buildBpc(run);
            bpc.color = nextDocColor(colorStart + 1);
            bpc.visible = false;
            // Tag trace ids so they're unique.
            tic.id = `${docId}-tic`;
            bpc.id = `${docId}-bpc`;
            newTraces.push(tic, bpc);
            detectorChannels.forEach((channel, index) => {
              const trace = buildDetectorTrace(run, channel);
              trace.id = `${docId}-detector-${index}`;
              trace.color = nextDocColor(colorStart + 2 + index);
              trace.visible = false;
              const channelMax = channel.intensityRange[1];
              const primaryMax = run.ticRange[1];
              if (channelMax > 0 && primaryMax > 0) {
                trace.scale = Math.min(
                  MAX_TRACE_SCALE,
                  Math.max(0.01, primaryMax / channelMax),
                );
              }
              newTraces.push(trace);
            });
          }
          setDocuments((prev) => [...prev, ...newDocs]);
          setTraces((prev) => [...prev, ...newTraces]);
          // Activate the FIRST run of the batch, which is also the first row of
          // the Documents list. One import can now yield several runs — a
          // Waters `.raw` folder returns one per acquisition function — and
          // there the primary measurement is function 1 while the last function
          // is typically the lockspray REFERENCE channel. Landing on the
          // reference would show the user a lock-mass trace instead of their
          // sample.
          const firstDoc = newDocs[0];
          if (firstDoc) {
            setActiveDocId(firstDoc.id);
            setActiveTraceId(`${firstDoc.id}-tic`);
            // Per-document view state is reset by the activeDocId effect
            // (fresh cache entry = defaults).
          }
          const totalPoints = accepted.reduce((s, r) => s + r.pointCount, 0);
          toast.success(
            `Imported ${accepted.length} run${accepted.length === 1 ? "" : "s"} · ${totalPoints.toLocaleString()} points`,
          );
        }
        // Surface load errors as toasts (one per error, capped).
        for (const e of loadErrors.slice(0, 3)) {
          toast.error(e);
        }
        if (loadErrors.length > 3) {
          toast.error(`${loadErrors.length - 3} more error(s) — see Import panel.`);
        }
      } catch (error) {
        console.error(error);
        toast.error("Import failed");
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [documents, centroidOnImport],
  );

  // --- Global drag-and-drop import ------------------------------------------
  const [pageDragActive, setPageDragActive] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current += 1;
      setPageDragActive(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setPageDragActive(false);
    };
    const onDrop = async (e: DragEvent) => {
      dragDepth.current = 0;
      setPageDragActive(false);
      if (e.defaultPrevented) return; // a dedicated drop zone already handled it
      if (!e.dataTransfer?.files?.length && !e.dataTransfer?.items?.length) return;
      e.preventDefault();
      const files = await collectDroppedFiles(e.dataTransfer);
      if (files.length > 0) void handleFiles(files);
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
  }, [handleFiles]);

  // --- Document panel callbacks ---------------------------------------------
  const handleSwitchDoc = useCallback(
    (id: string) => {
      if (id === activeDocId) return;
      const doc = documents.find((d) => d.id === id);
      if (!doc) return;
      setActiveDocId(id);
      // Active trace = this doc's TIC.
      const tic = traces.find((t) => t.runId === doc.run.id && t.kind === "TIC");
      setActiveTraceId(tic?.id ?? null);
      // Per-document view state (selections/pin/slots/peaks/params) is
      // captured+restored by the activeDocId effect — no teardown here.
    },
    [activeDocId, documents, traces],
  );

  const handleCloseDoc = useCallback(
    (id: string) => {
      const doc = documents.find((d) => d.id === id);
      if (!doc) return;
      // Drop this doc's cached view state so a re-imported same-name doc
      // starts fresh.
      docViewStateCacheRef.current.delete(id);
      // Peak ids in the undo stack reference the closed document; clear it.
      undo.clear();
      // Drop every reference to that run's typed arrays: remove its traces,
      // peaks and spectra from state so the buffers can be collected.
      setTraces((prev) => prev.filter((t) => t.runId !== doc.run.id));
      setChromPeaks((prev) => prev.filter((p) => p.runId !== doc.run.id));
      // Drop chromatogram-background entries that reference the closed doc
      // (as either the sample or the blank) so the derived `-bg` trace
      // disappears and isn't left pointing at freed typed arrays.
      setBackgroundBlankByDoc((prev) => {
        const next: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (k === id || v === id) continue;
          next[k] = v;
        }
        return next;
      });
      // Manual peaks are owned by this run too (chrom: via traceId's run;
      // spec: directly) — drop them so a re-imported run of the same name
      // can't inherit a closed run's hand-added peaks.
      setManualChromPeaks((prev) => prev.filter((p) => p.runId !== doc.run.id));
      setManualSpecPeaks((prev) => prev.filter((p) => p.runId !== doc.run.id));
      const remaining = documents.filter((d) => d.id !== id);
      setDocuments(remaining);
      if (id === activeDocId) {
        if (remaining.length > 0) {
          const next = remaining[0];
          setActiveDocId(next.id);
          const tic = traces.find((t) => t.runId === next.run.id && t.kind === "TIC");
          setActiveTraceId(tic?.id ?? null);
        } else {
          setActiveDocId(null);
          setActiveTraceId(null);
        }
        setPinnedRt(null);
        setSelections([]);
        setSelectionRunId(null);
        setSlots((prev) => prev.filter((s) => s.id === "live"));
        setChromPeaks([]);
        setFragmentHits(null);
        setSimilarity(null);
      }
    },
    [documents, activeDocId, traces, undo],
  );

  const handlePatchDoc = useCallback(
    (id: string, patch: Partial<Pick<GcmsDocument, "color" | "visible" | "offset">>) => {
      setDocuments((prev) =>
        prev.map((d) => {
          if (d.id !== id) return d;
          return { ...d, ...patch };
        }),
      );
      // Keep the trace colours in sync with the document colours.
      if (patch.color) {
        const doc = documents.find((d) => d.id === id);
        if (doc) {
          setTraces((prev) =>
            prev.map((t) =>
              t.runId === doc.run.id && (t.kind === "TIC" || t.kind === "BPC")
                ? { ...t, color: patch.color! }
                : t,
            ),
          );
        }
      }
    },
    [documents],
  );

  // Pick a blank document for the active doc's chromatogram background
  // subtraction. null clears it. Only the ACTIVE doc gets a blank (the UI
  // picker is in the Traces panel and keys off the active doc).
  const handlePickBlank = useCallback(
    (blankDocId: string | null) => {
      if (!activeDocId) return;
      setBackgroundBlankByDoc((prev) => {
        const next = { ...prev };
        if (blankDocId === null) delete next[activeDocId];
        else next[activeDocId] = blankDocId;
        return next;
      });
    },
    [activeDocId],
  );

  // --- Trace panel callbacks -------------------------------------------------
  const handlePatchTrace = useCallback(
    (id: string, patch: Partial<Pick<ChromTrace, "color" | "visible" | "offset" | "scale">>) => {
      setTraces((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    },
    [],
  );

  // --- Per-trace intensity gain (Phase 3 task D): Shift+wheel on the
  // chromatogram multiplies ONE trace's `scale` in place, leaving the shared
  // y-axis and every other trace untouched. Clamped so a long
  // scroll can't zero a trace out or blow it up to where it swamps the float
  // range `buildData` reads back a max from.
  const handleScaleTrace = useCallback((id: string, factor: number) => {
    setTraces((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const cur = Number.isFinite(t.scale) && t.scale !== 0 ? t.scale : 1;
        const next = Math.min(MAX_TRACE_SCALE, Math.max(0.01, cur * factor));
        return { ...t, scale: next };
      }),
    );
  }, []);

  const handleDeleteTrace = useCallback(
    (id: string) => {
      setTraces((prev) => {
        const t = prev.find((x) => x.id === id);
        // TIC/BPC are not deletable.
        if (!t || t.kind === "TIC" || t.kind === "BPC") return prev;
        return prev.filter((x) => x.id !== id);
      });
      // Drop that trace's manual peaks too — its owner is gone.
      setManualChromPeaks((prev) => prev.filter((p) => p.traceId !== id));
    },
    [],
  );

  /** Append one or more XICs as individually coloured, exportable traces. */
  const appendXicTraces = useCallback((built: ChromTrace[]) => {
    if (built.length === 0) return;
    setTraces((prev) => {
      const used = new Set(prev.map((trace) => trace.color));
      const colored = built.map((trace, index) => {
        const free = SERIES_COLORS.find((color) => !used.has(color));
        let color = free;
        if (!color) {
          // Continue beyond the fixed palette with deterministic golden-angle
          // hues so a large "Separate XICs" batch never silently reuses a live
          // trace's exact colour.
          let attempt = 0;
          do {
            const hue = Math.round(((prev.length + index + attempt) * 137.508) % 360);
            color = `hsl(${hue} 72% 46%)`;
            attempt += 1;
          } while (used.has(color));
        }
        used.add(color);
        return { ...trace, color };
      });
      return [...prev, ...colored];
    });
    // Every separated ion remains visible; emphasize the first selected ion.
    setActiveTraceId(built[0].id);
  }, []);

  const handleAddXic = useCallback(
    async (
      mzList: number[],
      tol: number,
      mode: "sum" | "max",
      sourceRun: MsRun | null = activeRun,
    ) => {
      if (!sourceRun) return;
      setBusy(true);
      try {
        const trace = await runBuildXic(sourceRun, mzList, tol, mode, workerStatus);
        appendXicTraces([trace]);
        toast.success(`Added XIC ${trace.label}`);
      } catch (error) {
        if (!isCancelledError(error)) {
          console.error(error);
          toast.error("XIC build failed");
        }
      } finally {
        setBusy(false);
      }
    },
    [activeRun, appendXicTraces, workerStatus],
  );

  // --- Gestures: hover, click, select ---------------------------------------
  const handleHoverRt = useCallback((rt: number | null) => {
    setHoverRt(rt);
  }, []);

  // --- "Add peak": the drag supplies the authoritative integration limits.
  // The helper may choose the apex *inside* that region, but never expands the
  // user's start/end to automatically discovered valleys.
  const handleAddPeakRange = useCallback(
    (lo: number, hi: number) => {
      if (!activeTrace) return;
      const peak = integratePeakRange(activeTrace, lo, hi, {
        smoothWindow: peakParams.smoothWindow,
        minWidthScans: peakParams.minWidthScans,
        baseline: peakParams.baseline,
      });
      if (!peak) {
        toast.error("Drag across at least two chromatogram data points to add a peak.");
        return;
      }
      const tagged = withBasePeakMz(peak, activeTraceRun);
      undo.pushSnapshot({
        chromPeaks: chromPeaks.map((p) => ({ ...p })),
        manualChromPeaks: manualChromPeaks.map((p) => ({ ...p })),
        dismissedChromPeakIds: new Set(dismissedChromPeakIds),
        specPeaks: specPeaks.map((p) => ({ ...p })),
        manualSpecPeaks: manualSpecPeaks.map((p) => ({ ...p })),
        dismissedSpecPeakIds: new Set(dismissedSpecPeakIds),
        label: "Add peak",
      });
      setManualChromPeaks((prev) => [...prev, tagged]);
      setSelectedChromPeakId(tagged.id);
      setPinnedRt(tagged.rtApex);
      toast.success(
        `Added peak from RT ${tagged.rtStart.toFixed(3)} to ${tagged.rtEnd.toFixed(3)}`,
      );
    },
    [
      activeTrace,
      activeTraceRun,
      peakParams,
      undo,
      chromPeaks,
      manualChromPeaks,
      dismissedChromPeakIds,
      specPeaks,
      manualSpecPeaks,
      dismissedSpecPeakIds,
    ],
  );

  const handlePinRt = useCallback(
    (rt: number) => {
      // Add-peak mode is drag-only. Never fall back to the old click-to-detect
      // path when the pointer does not travel far enough to form a selection.
      if (addPeakArmed) return;
      setPinnedRt(rt);
    },
    [addPeakArmed],
  );

  const handleSelectRange = useCallback(
    (lo: number, hi: number, mode: "zoom" | "select" | "background", additive: boolean) => {
      if (addPeakArmed) {
        handleAddPeakRange(lo, hi);
        return;
      }
      setMode(mode);
      if (mode === "select") {
        if (!activeTrace) return;
        // Task D: Shift-drag (additive) APPENDS a region; a plain drag
        // REPLACES the whole selection set. Pinning is cleared on a fresh
        // (non-additive) select drag only — an additive one is refining an
        // existing multi-region comparison the user is mid-way through.
        const sameRun = selectionRunId === activeTrace.runId;
        setSelections((prev) =>
          additive && sameRun ? [...prev, [lo, hi]] : [[lo, hi]],
        );
        setSelectionRunId(activeTrace.runId);
        if (!additive) setPinnedRt(null);
      } else if (mode === "background") {
        if (!activeTrace) return;
        // Ctrl-drag seeds/updates the implicit "bg" slot — this REPLACES the
        // old global `background` + `subtractBg` state pair (task A). A
        // fresh drag is an explicit "subtract this" gesture, so it always
        // resets the slot's mode back to "background" even if the user had
        // previously flipped it to "stack" to preview without subtracting.
        setSlots((prev) => {
          const existing = prev.find((s) => s.id === "bg");
          const next: SpectrumSlot = {
            id: "bg",
            source: { kind: "range", regions: [[lo, hi]] },
            runId: activeTrace.runId,
            label: "Background",
            color: existing?.color ?? nextSlotColor(),
            mode: "background",
          };
          return existing ? prev.map((s) => (s.id === "bg" ? next : s)) : [...prev, next];
        });
      }
      // zoom mode is handled entirely inside GcmsPlot.
    },
    [activeTrace, addPeakArmed, handleAddPeakRange, nextSlotColor, selectionRunId],
  );

  // --- "Add spectrum" (task A): freeze the CURRENT live view (whatever RT
  // slot 0 is showing) into a new frozen "scan" slot appended below the
  // existing ones — "insert a new graph under the current MS". -------------
  const handleAddSpectrum = useCallback(() => {
    if (!activeRun || liveRt == null) return;
    const idx = nearestScanIndex(activeRun, liveRt);
    if (idx < 0) return;
    const rt = activeRun.rtMin[idx];
    setSlots((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        source: { kind: "scan", rt },
        label: `Scan · RT ${rt.toFixed(3)}`,
        color: nextSlotColor(),
        mode: "stack",
      },
    ]);
  }, [activeRun, liveRt, nextSlotColor]);

  // --- Spectrum stack callbacks (task B) -------------------------------------
  const handleSlotModeChange = useCallback((id: string, newMode: SpectrumSlot["mode"]) => {
    if (id === "live") return; // guarded in the UI too; double-guard here.
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, mode: newMode } : s)));
  }, []);

  const handleSlotRemove = useCallback((id: string) => {
    if (id === "live") return;
    // "sel"/"sel-N" slots are DERIVED from `selections` (see the sync effect
    // above) — removing the panel must remove the underlying region(s) too,
    // or the effect would simply recreate the slot on the next render.
    if (id === "sel") {
      setSelections([]);
      setSelectionRunId(null);
      return;
    }
    const splitMatch = /^sel-(\d+)$/.exec(id);
    if (splitMatch) {
      const idx = Number(splitMatch[1]);
      setSelections((prev) => prev.filter((_, i) => i !== idx));
      return;
    }
    setSlots((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handleAddToComparison = useCallback(
    (slotId: string) => {
      if (!activeDoc) return;
      const resolved = subtractedSlots.find((entry) => entry.slot.id === slotId);
      if (!resolved) {
        toast.error("That spectrum is not available yet.");
        return;
      }
      const fingerprint = comparisonFingerprint(activeDoc.id, resolved.spectrum);
      const duplicate = comparisonItems.some(
        (item) => comparisonFingerprint(item.documentId, item.spectrum) === fingerprint,
      );
      if (duplicate) {
        toast.info("That document and RT window are already in the comparison.");
        setBottomTab("compare");
        return;
      }
      const id = crypto.randomUUID();
      const item: ComparisonSpectrumItem = {
        id,
        documentId: activeDoc.id,
        documentName: activeDoc.name,
        sourceSlotId: slotId,
        label: comparisonSpectrumLabel(activeDoc.name, resolved.spectrum),
        color: slotId === "live" ? activeDoc.color : resolved.slot.color,
        spectrum: resolved.spectrum,
        peaks: pickSpectrumPeaks(resolved.spectrum, {
          thresholdPct: 1,
          maxPeaks: 200,
          minSeparationMz: 0.3,
        }),
      };
      setComparisonItems((prev) => [...prev, item]);
      setFigIncludedSlotIds((prev) => {
        const next = prev.size === 0 ? new Set<string>() : new Set(prev);
        next.add(`comparison:${id}`);
        return next;
      });
      setBottomTab("compare");
      toast.success(`Added ${item.label} to comparison`);
    },
    [activeDoc, subtractedSlots, comparisonItems],
  );

  const handlePatchComparison = useCallback(
    (id: string, patch: Partial<Pick<ComparisonSpectrumItem, "label" | "color">>) => {
      setComparisonItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
    },
    [],
  );

  const handleRemoveComparison = useCallback((id: string) => {
    setComparisonItems((prev) => prev.filter((item) => item.id !== id));
    setFigIncludedSlotIds((prev) => {
      if (!prev.has(`comparison:${id}`)) return prev;
      const next = new Set(prev);
      next.delete(`comparison:${id}`);
      return next;
    });
  }, []);

  const handleClearComparison = useCallback(() => {
    setComparisonItems([]);
    setFigIncludedSlotIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => !id.startsWith("comparison:")));
      return next;
    });
  }, []);

  // Bug 9: numeric RT start/end edit for a range-derived slot's panel header.
  // Mirrors handleSlotRemove's id-matching: "bg" is stored directly on the
  // slot (Ctrl-drag background window); "sel" is the single shared region set
  // (split off) — editing it updates the FIRST region; "sel-N" is a specific
  // split region.
  const handleEditSlotRange = useCallback((id: string, region: [number, number]) => {
    if (id === "bg") {
      setSlots((prev) =>
        prev.map((s) =>
          s.id === "bg" && s.source.kind === "range" ? { ...s, source: { kind: "range", regions: [region] } } : s,
        ),
      );
      return;
    }
    if (id === "sel") {
      setSelections((prev) => (prev.length > 0 ? [region, ...prev.slice(1)] : [region]));
      return;
    }
    const splitMatch = /^sel-(\d+)$/.exec(id);
    if (splitMatch) {
      const idx = Number(splitMatch[1]);
      setSelections((prev) => prev.map((r, i) => (i === idx ? region : r)));
    }
  }, []);

  // --- Spectrum peak table -> XIC. Selected ions can stay combined in one
  // trace or be extracted separately so their chromatographic origins are
  // visible (and exported) one m/z per trace.
  const handleXicSelected = useCallback(
    (mzList: number[], layout: "combined" | "separate") => {
      const uniqueMz = [...new Set(mzList)];
      if (uniqueMz.length === 0) return;
      if (layout === "combined") {
        void handleAddXic(uniqueMz, suggestedTol, "sum", spectrumPeakRun);
        return;
      }
      if (!spectrumPeakRun) return;
      void (async () => {
        setBusy(true);
        try {
          const built = await runBuildXics(
            spectrumPeakRun,
            uniqueMz,
            suggestedTol,
            workerStatus,
          );
          appendXicTraces(built);
          toast.success(
            `Added ${built.length} separate XIC trace${built.length === 1 ? "" : "s"}`,
          );
        } catch (error) {
          if (!isCancelledError(error)) {
            console.error(error);
            toast.error("Separate XIC build failed");
          }
        } finally {
          setBusy(false);
        }
      })();
    },
    [appendXicTraces, handleAddXic, spectrumPeakRun, suggestedTol, workerStatus],
  );

  // --- Spectrum peak table: add-by-m/z (task C) ------------------------------
  // Snaps to the nearest stick in the LIVE spectrum (this table has no
  // spectrum of its own to search) and computes relPct against that
  // spectrum's precomputed `basePeak`, matching pickSpectrumPeaks's own
  // relPct formula. `suggestedTol` (0.3 Da on a coarse grid, 0.01 Da on a
  // fine one — see above) doubles as "how close counts as a hit", the same
  // resolution estimate the XIC builder already uses. Returns an error
  // string instead of appending a bogus row, same convention as the Traces
  // panel's XIC builder.
  const handleAddSpecPeak = useCallback(
    (mz: number): string | null => {
      if (!liveSpectrum || liveSpectrum.mz.length === 0) {
        return "No spectrum shown — hover or pin a scan first.";
      }
      const idx = nearestIndex(liveSpectrum.mz, mz);
      if (idx < 0 || Math.abs(liveSpectrum.mz[idx] - mz) > suggestedTol) {
        return `No stick within ${suggestedTol.toFixed(2)} Da of m/z ${mz.toFixed(3)}.`;
      }
      const stickMz = liveSpectrum.mz[idx];
      const stickIntensity = liveSpectrum.intensity[idx];
      const baseIntensity = liveSpectrum.basePeak?.intensity ?? 0;
      const peak: ManualSpecPeak = {
        id: crypto.randomUUID(),
        mz: stickMz,
        intensity: stickIntensity,
        relPct: baseIntensity > 0 ? (stickIntensity / baseIntensity) * 100 : 0,
        runId: liveSpectrum.runId,
        slotId: "live",
      };
      undo.pushSnapshot({
        chromPeaks: chromPeaks.map((p) => ({ ...p })),
        manualChromPeaks: manualChromPeaks.map((p) => ({ ...p })),
        dismissedChromPeakIds: new Set(dismissedChromPeakIds),
        specPeaks: specPeaks.map((p) => ({ ...p })),
        manualSpecPeaks: manualSpecPeaks.map((p) => ({ ...p })),
        dismissedSpecPeakIds: new Set(dismissedSpecPeakIds),
        label: "Add spectrum peak",
      });
      setManualSpecPeaks((prev) => [...prev, peak]);
      return null;
    },
    [
      liveSpectrum,
      suggestedTol,
      undo,
      chromPeaks,
      manualChromPeaks,
      dismissedChromPeakIds,
      specPeaks,
      manualSpecPeaks,
      dismissedSpecPeakIds,
    ],
  );

  // Same dismiss-or-remove contract as handleChromPeakDelete.
  const handleSpecPeakDelete = useCallback((id: string) => {
    undo.pushSnapshot({
      chromPeaks: chromPeaks.map((p) => ({ ...p })),
      manualChromPeaks: manualChromPeaks.map((p) => ({ ...p })),
      dismissedChromPeakIds: new Set(dismissedChromPeakIds),
      specPeaks: specPeaks.map((p) => ({ ...p })),
      manualSpecPeaks: manualSpecPeaks.map((p) => ({ ...p })),
      dismissedSpecPeakIds: new Set(dismissedSpecPeakIds),
      label: "Delete spectrum peak",
    });
    setManualSpecPeaks((prev) => prev.filter((p) => p.id !== id));
    setDismissedSpecPeakIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, [undo, chromPeaks, manualChromPeaks, dismissedChromPeakIds, specPeaks, manualSpecPeaks, dismissedSpecPeakIds]);

  // --- Chromatographic peak detection ---------------------------------------
  const handleDetectPeaks = useCallback(async () => {
    if (!activeTrace) return;
    // Peak detection needs a time axis. Saying so beats silently reporting
    // "0 peaks" on a run that never had a chromatogram to integrate.
    if (!hasChromatogram) {
      toast.error(
        "This run is a single scan — there is no chromatogram to integrate. Use the spectrum peak table instead.",
      );
      return;
    }
    setBusy(true);
    try {
      const peaks = await runDetectChromPeaks(activeTrace, peakParams, workerStatus);
      // Tag from the nearest MS scan by RT. The trace's sample index is not
      // necessarily the run's scan index (UV/FID grids can differ).
      const tagged = peaks.map((peak) => withBasePeakMz(peak, activeTraceRun));
      undo.pushSnapshot({
        chromPeaks: chromPeaks.map((p) => ({ ...p })),
        manualChromPeaks: manualChromPeaks.map((p) => ({ ...p })),
        dismissedChromPeakIds: new Set(dismissedChromPeakIds),
        specPeaks: specPeaks.map((p) => ({ ...p })),
        manualSpecPeaks: manualSpecPeaks.map((p) => ({ ...p })),
        dismissedSpecPeakIds: new Set(dismissedSpecPeakIds),
        label: "Detect peaks",
      });
      setChromPeaks(tagged);
      // Fresh ids every run (peakId() in lib/gcms/peaks.ts) — bound the
      // dismissed set's size rather than let it grow across repeated detects.
      setDismissedChromPeakIds(new Set());
      toast.success(`Detected ${tagged.length} chromatographic peak${tagged.length === 1 ? "" : "s"}`);
    } catch (error) {
      if (!isCancelledError(error)) {
        console.error(error);
        toast.error("Peak detection failed");
      }
    } finally {
      setBusy(false);
    }
  }, [
    activeTrace,
    activeTraceRun,
    hasChromatogram,
    peakParams,
    workerStatus,
    undo,
    chromPeaks,
    manualChromPeaks,
    dismissedChromPeakIds,
    specPeaks,
    manualSpecPeaks,
    dismissedSpecPeakIds,
  ]);

  // --- Chrom peak table row click: move the cursor --------------------------
  // Item 8: this no longer clears `selections` — moving the pin updates the
  // LIVE panel only, and any stacked region panels stay put for comparison
  // rather than being torn down every time the user jumps between peaks.
  const handleChromPeakRowClick = useCallback((peak: ChromPeak) => {
    setPinnedRt(peak.rtApex);
    setSelectedChromPeakId(peak.id);
  }, []);

  const handleChromPeakRename = useCallback((id: string, name: string) => {
    setChromPeaks((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
    setManualChromPeaks((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
  }, []);

  /** Re-integrate a peak after the user edits its explicit RT start/end. The
   *  same fixed-bound helper used by drag-to-add keeps table edits, plot
   *  markers, area percentages, and exports on one canonical definition. */
  const handleChromPeakRangeChange = useCallback(
    (id: string, rtStart: number, rtEnd: number): string | null => {
      const current = displayedChromPeaks.find((peak) => peak.id === id);
      if (!current) return "That peak is no longer available.";
      const trace = traces.find((candidate) => candidate.id === current.traceId);
      if (!trace) return "The chromatogram trace for this peak is no longer available.";
      const reintegrated = integratePeakRange(trace, rtStart, rtEnd, {
        smoothWindow: peakParams.smoothWindow,
        minWidthScans: peakParams.minWidthScans,
        baseline: peakParams.baseline,
      });
      if (!reintegrated) return "Start and end must include at least two chromatogram data points.";

      const run = documents.find((doc) => doc.run.id === current.runId)?.run ?? null;
      const next = withBasePeakMz(
        { ...reintegrated, id: current.id, name: current.name },
        run,
      );
      setChromPeaks((prev) => prev.map((peak) => (peak.id === id ? next : peak)));
      setManualChromPeaks((prev) => prev.map((peak) => (peak.id === id ? next : peak)));
      setSelectedChromPeakId(id);
      setPinnedRt(next.rtApex);
      return null;
    },
    [displayedChromPeaks, documents, peakParams, traces],
  );

  // Delete works whether `id` belongs to a manual peak (removed outright) or
  // a derived one (dismissed — see the task-D comment above the component).
  // Both branches run unconditionally: a manual id never matches anything in
  // `chromPeaks`, so adding it to the dismissed set too is a harmless no-op.
  const handleChromPeakDelete = useCallback((id: string) => {
    undo.pushSnapshot({
      chromPeaks: chromPeaks.map((p) => ({ ...p })),
      manualChromPeaks: manualChromPeaks.map((p) => ({ ...p })),
      dismissedChromPeakIds: new Set(dismissedChromPeakIds),
      specPeaks: specPeaks.map((p) => ({ ...p })),
      manualSpecPeaks: manualSpecPeaks.map((p) => ({ ...p })),
      dismissedSpecPeakIds: new Set(dismissedSpecPeakIds),
      label: "Delete chrom peak",
    });
    setManualChromPeaks((prev) => prev.filter((p) => p.id !== id));
    setDismissedChromPeakIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, [undo, chromPeaks, manualChromPeaks, dismissedChromPeakIds, specPeaks, manualSpecPeaks, dismissedSpecPeakIds]);

  // Peak ids are minted fresh on every detection run, so drop the highlight
  // whenever the peak it pointed at is gone (re-detect, trace or run switch,
  // or a delete). Checked against the MERGED list (not the raw derived
  // `chromPeaks`) so selecting a manual peak survives a subsequent re-detect.
  useEffect(() => {
    setSelectedChromPeakId((prev) =>
      prev && displayedChromPeaks.some((p) => p.id === prev) ? prev : null,
    );
  }, [displayedChromPeaks]);

  // --- Fragment finder -------------------------------------------------------
  const handleFindFragment = useCallback(
    (mz: number, tol: number, minRelPct: number) => {
      if (!activeRun) return;
      setBusy(true);
      try {
        const hits: { rtMin: number; relPct: number; basePeakMz: number | null; abundance: number }[] = [];
        const n = activeRun.scanCount;
        for (let s = 0; s < n; s += 1) {
          const lo = activeRun.scanOffset[s];
          const hi = activeRun.scanOffset[s + 1];
          if (hi <= lo) continue;
          // Find points within tol of mz.
          let maxI = 0;
          for (let i = lo; i < hi; i += 1) {
            if (Math.abs(activeRun.mz[i] - mz) <= tol && activeRun.intensity[i] > maxI) {
              maxI = activeRun.intensity[i];
            }
          }
          if (maxI <= 0) continue;
          // Rel % = this ion's intensity / the scan's base-peak intensity.
          const baseInt = activeRun.basePeakIntensity[s];
          const relPct = baseInt > 0 ? (maxI / baseInt) * 100 : 0;
          if (relPct < minRelPct) continue;
          const bpm = activeRun.basePeakMz[s];
          hits.push({
            rtMin: activeRun.rtMin[s],
            relPct,
            basePeakMz: Number.isFinite(bpm) ? bpm : null,
            // Bug 5: the ion's own ABSOLUTE intensity at this scan — kept (was
            // computed as `maxI` above but previously discarded) so "most
            // abundant" can be reported alongside "most pure" (highest rel %,
            // i.e. least co-elution — the scan where this ion dominates most).
            abundance: maxI,
          });
        }
        setFragmentHits(hits);
        if (hits.length === 0) {
          toast.success("0 hits");
        } else {
          const mostAbundant = hits.reduce((a, b) => (b.abundance > a.abundance ? b : a));
          const mostPure = hits.reduce((a, b) => (b.relPct > a.relPct ? b : a));
          toast.success(
            `${hits.length} hit${hits.length === 1 ? "" : "s"} — most abundant at RT ${mostAbundant.rtMin.toFixed(3)} min, most pure (${mostPure.relPct.toFixed(1)}%) at RT ${mostPure.rtMin.toFixed(3)} min`,
          );
        }
      } catch (error) {
        console.error(error);
        toast.error("Fragment search failed");
      } finally {
        setBusy(false);
      }
    },
    [activeRun],
  );

  const handleFragmentRowClick = useCallback((rtMin: number) => {
    setPinnedRt(rtMin);
  }, []);

  // Search the active run using full-spectrum similarity plus independent
  // diagnostic-ion count and coverage gates. This deliberately reports weak
  // evidence as "no confident match" instead of turning one common fragment
  // into a compound identification.
  const handleMatchPredictedSpectrum = useCallback(
    (predicted: MassSpectrum): MsPredictMatchResult | null => {
      if (!activeRun) return null;
      return matchPredictedSpectrumInRun(activeRun, predicted, 0.5);
    },
    [activeRun],
  );

  // --- Library match (compare two visible runs' spectra) -------------------
  const handleCompareSpectra = useCallback(() => {
    const all = [liveSpectrum, ...liveOverlaySpectra.map((o) => o.spectrum)].filter(
      (s): s is MassSpectrum => s != null,
    );
    if (all.length < 2) {
      toast.error("Open at least two runs and lock spectra to cursor to compare.");
      return;
    }
    const sim = spectrumSimilarity(all[0], all[1], 0.02);
    setSimilarity(sim);
    toast.success(`Similarity: ${(sim * 100).toFixed(1)}%`);
  }, [liveSpectrum, liveOverlaySpectra]);

  // --- Unpin -----------------------------------------------------------------
  const handleUnpin = useCallback(() => {
    setPinnedRt(null);
  }, []);

  // --- Keyboard: arrow keys step the pinned scan ------------------------------
  // Attached to the plot card with tabIndex={0}; preventDefault so the page
  // does not scroll.
  const handlePlotKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!activeRun) return;
      if (activeRun.scanCount === 0) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dir = e.key === "ArrowLeft" ? -step : step;
        if (pinnedRt != null) {
          const idx = nearestScanIndex(activeRun, pinnedRt);
          if (idx < 0) return;
          const nextIdx = Math.max(0, Math.min(activeRun.scanCount - 1, idx + dir));
          setPinnedRt(activeRun.rtMin[nextIdx]);
        } else if (hoverRt != null) {
          const idx = nearestScanIndex(activeRun, hoverRt);
          if (idx < 0) return;
          const nextIdx = Math.max(0, Math.min(activeRun.scanCount - 1, idx + dir));
          setPinnedRt(activeRun.rtMin[nextIdx]);
        } else {
          // Pin at the highest-TIC scan.
          let max = -Infinity;
          let idx = 0;
          for (let i = 0; i < activeRun.scanCount; i += 1) {
            if (activeRun.tic[i] > max) {
              max = activeRun.tic[i];
              idx = i;
            }
          }
          setPinnedRt(activeRun.rtMin[idx]);
        }
      }
    },
    [activeRun, pinnedRt, hoverRt],
  );

  // --- Export ----------------------------------------------------------------
  const handleExport = useCallback(
    (kind: ExportKind) => {
      if (!activeRun) {
        toast.error("Import a run before exporting");
        return;
      }
      const baseName = activeDoc?.name ?? "gcms";
      // Every chromatogram export would write an empty or one-row file for a
      // single-scan run; refuse with a reason rather than hand over a stub.
      if (!hasChromatogram && (kind === "chromCsv" || kind === "chromPng" || kind === "chromPeakCsv")) {
        toast.error("This run is a single scan — there is no chromatogram to export.");
        return;
      }
      try {
        switch (kind) {
          case "chromCsv": {
            downloadText(
              `${baseName}-chromatogram.csv`,
              chromatogramCsv(visibleChromTraces),
              "text/csv",
            );
            break;
          }
          case "spectrumCsv": {
            if (!liveSpectrum) return;
            downloadText(`${baseName}-spectrum.csv`, spectrumCsv(liveSpectrum), "text/csv");
            break;
          }
          case "chromPeakCsv": {
            downloadText(`${baseName}-chrom-peaks.csv`, chromPeakCsv(displayedChromPeaks), "text/csv");
            break;
          }
          case "spectrumPeakCsv": {
            downloadText(
              `${baseName}-spectrum-peaks.csv`,
              spectrumPeakCsv(displayedSpectrumPeakRows),
              "text/csv",
            );
            break;
          }
          case "msp": {
            if (!liveSpectrum) return;
            downloadText(
              `${baseName}.msp`,
              spectrumMsp(liveSpectrum, displayedSpecPeaks, activeRun.meta, baseName),
              "text/plain",
            );
            break;
          }
          case "metadata": {
            downloadText(`${baseName}-metadata.txt`, metadataText(activeRun), "text/plain");
            break;
          }
          case "reportPng": {
            const { top, bottom } = buildReportPanels();
            const dataUrl = renderReportPng(top, bottom, {
              width: 1200,
              height: 800,
              scale: exportScale,
              theme: readReportTheme(),
            });
            if (dataUrl) {
              const a = document.createElement("a");
              a.href = dataUrl;
              a.download = `${baseName}-report.png`;
              document.body.appendChild(a);
              a.click();
              a.remove();
            }
            break;
          }
          case "reportSvg": {
            const { top, bottom } = buildReportPanels();
            const svg = renderReportSvg(top, bottom, {
              width: 1200,
              height: 800,
              theme: readReportTheme(),
            });
            downloadText(`${baseName}-report.svg`, svg, "image/svg+xml");
            break;
          }
          case "chromPng": {
            const url = chromCaptureRef.current?.(exportScale) ?? null;
            if (url) downloadDataUrl(`${baseName}-chromatogram.png`, url);
            else toast.error("Chromatogram is empty — nothing to export.");
            break;
          }
          case "spectrumPng": {
            const url = spectrumCaptureRef.current?.(exportScale) ?? null;
            if (url) downloadDataUrl(`${baseName}-spectrum.png`, url);
            else toast.error("Spectrum is empty — nothing to export.");
            break;
          }
        }
      } catch (error) {
        console.error(error);
        toast.error("Export failed");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRun, activeDoc, hasChromatogram, visibleChromTraces, displayedChromPeaks, displayedSpecPeaks, displayedSpectrumPeakRows, liveSpectrum, exportScale],
  );

  /** Build the report spec. `top` is null when the run has no chromatogram, and
   *  the spectrum then gets the whole report canvas. */
  function buildReportPanels(): { top: ReportPanelSpec | null; bottom: ReportPanelSpec } {
    const top: ReportPanelSpec | null = !hasChromatogram ? null : {
      title: "Chromatogram",
      xLabel: "Retention time (min)",
      traces: visibleChromTraces.map((t) => ({
        x: t.rtMin,
        y: t.intensity,
        color: t.color,
        width: 1,
        label: t.label,
      })),
      drawMode: "line",
      labels: displayedChromPeaks.map((p) => ({
        x: p.rtApex,
        y: p.height,
        lines: [p.rtApex.toFixed(3)],
        priority: p.height,
      })),
    };
    const spec = liveSpectrum;
    const bottom: ReportPanelSpec = {
      title: spec?.label || "Mass spectrum",
      xLabel: "m/z",
      traces: spec
        ? [{ x: spec.mz, y: spec.intensity, color: activeDoc?.color ?? primaryToken(), width: 1 }]
        : [],
      drawMode: "stick",
      labels: displayedSpecPeaks.map((p) => ({
        x: p.mz,
        y: p.intensity,
        lines: [p.mz.toFixed(3), `${p.relPct.toFixed(2)}%`],
        priority: p.intensity,
      })),
    };
    return { top, bottom };
  }

  // --- The hero + toolbar header section ------------------------------------
  const hasRun = documents.length > 0 && activeRun != null;
  const roomyBottomTab =
    bottomTab === "compare" || bottomTab === "figure" || bottomTab === "predict-ms";

  return (
    <AppShell
      headerAccessory={
        <>
          <WorkerBadge status={workerStatus} onRetry={checkWorker} />
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 font-medium text-success">
            <HardDrive className="h-3 w-3" />
            Local GC/MS workspace
          </span>
        </>
      }
      mainClassName="container py-6"
    >
      {pageDragActive && (
        <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
          <div className="rounded-2xl border-2 border-dashed border-primary bg-background/95 px-8 py-6 text-center shadow-xl">
            <p className="text-base font-semibold text-primary">Drop GC/MS files to import</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Agilent .D · mzML · mzXML · MGF · netCDF · CSV · JCAMP
            </p>
          </div>
        </div>
      )}
      <div className="mx-auto flex w-full max-w-[1700px] flex-col gap-4">
        {/* Hero + toolbar section */}
        <section className="rounded-2xl border border-border/70 bg-card px-4 py-2.5 shadow-card">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
              title="Read Agilent .D folders, mzML/mzXML/MGF/netCDF, CSV and JCAMP. Scrub a chromatogram with the spectrum linked below it, extract ion chromatograms, integrate peaks and export — all locally in your browser."
            >
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">
                GC/MS
              </p>
              <h1 className="text-base font-semibold tracking-tight text-foreground">
                GC-MS / LC-MS chromatogram &amp; spectrum viewer
              </h1>
            </div>
            {hasRun && (
              <div className="flex flex-wrap items-end gap-1.5">
                {pinnedRt != null && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={handleUnpin}
                    title="Unpin the cursor (follow the hover)"
                  >
                    <Pin className="mr-1.5 h-4 w-4" />
                    Unpin
                  </Button>
                )}
                {/* Drag-mode segmented control: makes the modifier gestures
                    discoverable and lets the user pre-select a mode so a plain
                    drag always acts as that mode (no Shift/Ctrl needed). */}
                <div
                  className="flex overflow-hidden rounded-md border border-border/60"
                  title="Chromatogram drag mode (Shift/Cmd drag also overrides)"
                >
                  {(["zoom", "select", "background"] as const).map((m) => (
                    <Button
                      key={m}
                      type="button"
                      size="sm"
                      variant={mode === m ? "default" : "ghost"}
                      className="h-8 rounded-none px-2 text-xs capitalize"
                      onClick={() => setMode(m)}
                    >
                      {m}
                    </Button>
                  ))}
                </div>
                {/* Split regions (task D): off -> every selected region sums
                    into ONE range slot; on -> each becomes its own stacked
                    panel. Placed right beside the drag-mode control since it
                    only affects "select"-mode drags. */}
                <Button
                  type="button"
                  size="sm"
                  variant={splitRegions ? "default" : "outline"}
                  className="h-8"
                  onClick={() => setSplitRegions((v) => !v)}
                  title="Split multi-region selections into separate stacked spectra instead of summing them into one"
                >
                  Split regions
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => void handleDetectPeaks()}
                  disabled={busy || !activeTrace}
                  title="Detect chromatographic peaks on the active trace"
                >
                  Detect peaks
                </Button>
                {/* Add peak is intentionally drag-only: the user supplies the
                    integration start/end instead of a click asking the system
                    to discover an apex and valleys. */}
                <Button
                  type="button"
                  size="sm"
                  variant={addPeakArmed ? "default" : "outline"}
                  className="h-8"
                  onClick={() => setAddPeakArmed((v) => !v)}
                  disabled={!activeTrace}
                  aria-pressed={addPeakArmed}
                  title="Drag across the full chromatographic peak to set its integration range"
                >
                  {addPeakArmed ? "Drag peak region" : "Add peak"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={handleAddSpectrum}
                  disabled={liveRt == null}
                  title="Freeze the current spectrum into a new panel below"
                >
                  Add spectrum
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => {
                    setSelections([]);
                    setSelectionRunId(null);
                    setSlots((prev) => prev.filter((s) => s.id !== "bg"));
                    setPinnedRt(null);
                  }}
                  title="Clear the selection(s) / background / pin"
                >
                  <X className="mr-1.5 h-4 w-4" />
                  Clear
                </Button>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="ghost" className="h-8" title="Keyboard &amp; mouse shortcuts">
                      <HelpCircle className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 text-xs" align="end">
                    <div className="flex flex-col gap-1">
                      <p className="font-semibold text-foreground">Shortcuts</p>
                      <p><span className="font-mono">Hover</span> — RT cursor follows; readout + spectrum live-update</p>
                      <p><span className="font-mono">Click</span> — pin the scan (disabled while Add peak is armed)</p>
                      <p><span className="font-mono">Add peak + drag</span> — set the peak's exact RT start/end</p>
                      <p><span className="font-mono">← / →</span> — step the pinned scan by ±1 (±10 with Shift)</p>
                      <p><span className="font-mono">Drag</span> — x zoom</p>
                      <p><span className="font-mono">Shift + drag</span> — set the summed-spectrum window</p>
                      <p><span className="font-mono">Ctrl/Cmd + drag</span> — set the background window</p>
                      <p><span className="font-mono">Wheel</span> — y scaling (minimum pinned at 0)</p>
                      <p><span className="font-mono">Shift + scroll</span> — scale the active trace</p>
                      <p><span className="font-mono">Double-click</span> — pop one level of zoom, else full range</p>
                      <p><span className="font-mono">Ctrl/Cmd + Z</span> — Undo last peak action</p>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            )}
          </div>
        </section>

        {!hasRun ? (
          <EmptyWorkspace
            onFiles={(files) => void handleFiles(files)}
            busy={busy}
            progress={progress}
            errors={errors}
            centroid={centroidOnImport}
            onCentroidChange={setCentroidOnImport}
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
            {/* Left: sidebar */}
            <aside className="flex max-h-[calc(100vh-160px)] flex-col gap-3 overflow-y-auto pr-1 lg:sticky lg:top-4">
              <SidebarCard id="import" title="Import" open={isCardOpen("import")} onOpenChange={(o) => setCardOpenById("import", o)}>
                <ImportPanel
                  onFiles={(files) => void handleFiles(files)}
                  busy={busy}
                  progress={progress}
                  errors={errors}
                  centroid={centroidOnImport}
                  onCentroidChange={setCentroidOnImport}
                />
              </SidebarCard>
              <SidebarCard id="documents" title="Documents" open={isCardOpen("documents")} onOpenChange={(o) => setCardOpenById("documents", o)}>
                <DocumentsPanel
                  documents={documents}
                  activeDocId={activeDocId}
                  normalize={normalize}
                  onNormalizeChange={setNormalize}
                  stacked={stacked}
                  onStackedChange={setStacked}
                  lockSpectraToCursor={lockSpectraToCursor}
                  onLockSpectraToCursorChange={setLockSpectraToCursor}
                  onSwitch={handleSwitchDoc}
                  onClose={handleCloseDoc}
                  onPatch={handlePatchDoc}
                  onFiles={(files) => void handleFiles(files)}
                />
              </SidebarCard>
              <SidebarCard id="traces" title="Traces & XIC" open={isCardOpen("traces")} onOpenChange={(o) => setCardOpenById("traces", o)}>
                <TracesPanel
                  traces={traces}
                  runNames={runNames}
                  activeTraceId={effectiveActiveTraceId}
                  suggestedTol={suggestedTol}
                  busy={busy}
                  onSelect={setActiveTraceId}
                  onPatch={handlePatchTrace}
                  onDelete={handleDeleteTrace}
                  onAddXic={handleAddXic}
                  activeDocBlank={(activeDocId && backgroundBlankByDoc[activeDocId]) ?? null}
                  blankCandidates={documents
                    .filter((d) => d.id !== activeDocId)
                    .map((d) => ({ id: d.id, name: d.name }))}
                  onPickBlank={handlePickBlank}
                />
              </SidebarCard>
              <SidebarCard id="fragment" title="Fragment tools" open={isCardOpen("fragment")} onOpenChange={(o) => setCardOpenById("fragment", o)}>
                <FragmentPanel
                  suggestedTol={suggestedTol}
                  busy={busy}
                  specPeaks={displayedSpecPeaks}
                  fragmentHits={fragmentHits}
                  similarity={similarity}
                  onAddXic={handleAddXic}
                  onFindFragment={handleFindFragment}
                  onRowClick={handleFragmentRowClick}
                  onCompareSpectra={handleCompareSpectra}
                />
              </SidebarCard>
              <SidebarCard id="processing" title="Processing" open={isCardOpen("processing")} onOpenChange={(o) => setCardOpenById("processing", o)}>
                <ProcessingCard
                  peakParams={peakParams}
                  onPeakParamsChange={setPeakParams}
                  logY={logY}
                  onLogYChange={setLogY}
                  normalize={normalize}
                  onNormalizeChange={setNormalize}
                  stacked={stacked}
                  onStackedChange={setStacked}
                  lockSpectraToCursor={lockSpectraToCursor}
                  onLockSpectraToCursorChange={setLockSpectraToCursor}
                  onDetectPeaks={() => void handleDetectPeaks()}
                  busy={busy}
                  peakCount={displayedChromPeaks.length}
                />
              </SidebarCard>
              <SidebarCard id="metadata" title="Metadata" open={isCardOpen("metadata")} onOpenChange={(o) => setCardOpenById("metadata", o)}>
                {activeRun ? (
                  <MetadataPanel meta={activeRun.meta} warnings={activeRun.warnings} runName={activeRun.name} />
                ) : (
                  <p className="text-xs text-muted-foreground">No run loaded.</p>
                )}
              </SidebarCard>
              <SidebarCard id="export" title="Export" open={isCardOpen("export")} onOpenChange={(o) => setCardOpenById("export", o)}>
                <ExportPanel
                  disabled={!hasRun}
                  scale={exportScale}
                  onScaleChange={setExportScale}
                  onExport={handleExport}
                />
              </SidebarCard>
            </aside>

            {/* Right: viewer + tabs. The whole right column is a vertical
                ResizablePanelGroup so the user can drag the handle below the
                plot card to make the graph area taller (and the tabs card
                shorter), or drag the handle inside the plot card to rebalance
                the chromatogram vs spectrum split. The plot card's own
                ResizablePanelGroup is sized 30% taller than before so the graph
                area dominates the right column by default. */}
            <ResizablePanelGroup
              key={roomyBottomTab ? "roomy-bottom" : "compact-bottom"}
              direction="vertical"
              className={
                roomyBottomTab
                  ? "h-[2300px] min-h-[2300px]"
                  : "h-[calc(100vh-5rem)] min-h-[1180px]"
              }
            >
              <ResizablePanel
                defaultSize={roomyBottomTab ? 50 : 78}
                minSize={roomyBottomTab ? 38 : 50}
              >
                <Card className="h-full border-border/70 shadow-card" onKeyDown={handlePlotKeyDown} tabIndex={0}>
                  <CardContent className="h-full p-4">
                    {/* A single-scan / infusion run has no chromatogram to
                        draw, so the spectrum takes the whole card instead of
                        sharing it with a one-point plot. `key` forces a fresh
                        panel group when the split appears or disappears —
                        ResizablePanelGroup caches its layout by child count. */}
                    <ResizablePanelGroup
                      key={hasChromatogram ? "with-chrom" : "spectrum-only"}
                      direction="vertical"
                      className="h-full min-h-[832px]"
                    >
                      {hasChromatogram && (
                      <ResizablePanel defaultSize={38} minSize={20}>
                        <div className="h-full min-h-0">
                          <ChromatogramPanel
                            traces={visibleChromTraces}
                            peaks={displayedChromPeaks}
                            cursorRt={cursorRt}
                            selections={visibleSelections}
                            selectionColors={visibleSelectionColors}
                            background={null}
                            activeTraceId={effectiveActiveTraceId}
                            title={activeTrace?.label ?? "Chromatogram"}
                            normalize={normalize}
                            stacked={stacked}
                            logY={logY}
                            dragMode={addPeakArmed ? "select" : mode}
                            captureRef={chromCaptureRef}
                            onHoverRt={handleHoverRt}
                            onPinRt={handlePinRt}
                            onSelectRange={handleSelectRange}
                            // Disabled while "Add peak" is armed: the selected
                            // region is always integrated on the visibly active
                            // trace, never whichever overlaid line was clicked.
                            onPickTrace={addPeakArmed ? undefined : setActiveTraceId}
                            onScaleTrace={handleScaleTrace}
                          />
                        </div>
                      </ResizablePanel>
                      )}
                      {hasChromatogram && <ResizableHandle withHandle />}
                      <ResizablePanel defaultSize={hasChromatogram ? 62 : 100} minSize={20}>
                        <div className="h-full min-h-0">
                          <SpectrumStack
                            panels={spectrumPanels}
                            xDomain={activeRun?.mzRange}
                            normalize={normalize}
                            stacked={stacked}
                            logY={logY}
                            captureRef={spectrumCaptureRef}
                            onModeChange={handleSlotModeChange}
                            onRemove={handleSlotRemove}
                            onAddToComparison={handleAddToComparison}
                            rtRange={activeRun?.rtRange}
                            onEditRange={handleEditSlotRange}
                          />
                        </div>
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  </CardContent>
                </Card>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel
                defaultSize={roomyBottomTab ? 50 : 22}
                minSize={roomyBottomTab ? 38 : 14}
              >
                <Card className="h-full border-border/70 shadow-card">
                  <CardContent className="h-full overflow-y-auto p-4">
                    <Tabs value={bottomTab} onValueChange={setBottomTab}>
                      <TabsList className="flex flex-wrap">
                        <TabsTrigger value="chrom-peaks">Chrom. peaks</TabsTrigger>
                        <TabsTrigger value="spectrum-peaks">Spectrum peaks</TabsTrigger>
                        <TabsTrigger value="compare">
                          Compare{comparisonItems.length > 0 ? ` (${comparisonItems.length})` : ""}
                        </TabsTrigger>
                        <TabsTrigger value="figure">Figure</TabsTrigger>
                        <TabsTrigger value="predict-ms">Predict MS</TabsTrigger>
                        <TabsTrigger value="export">Export</TabsTrigger>
                      </TabsList>
                      <TabsContent value="chrom-peaks" className="mt-3">
                        <div className="h-[420px]">
                          <ChromPeakTable
                            peaks={displayedChromPeaks}
                            selectedPeakId={selectedChromPeakId}
                            onRowClick={handleChromPeakRowClick}
                            onRename={handleChromPeakRename}
                            onRangeChange={handleChromPeakRangeChange}
                            onDelete={handleChromPeakDelete}
                          />
                        </div>
                      </TabsContent>
                      <TabsContent value="spectrum-peaks" className="mt-3">
                        <div className="h-[420px]">
                          <SpectrumPeakTable
                            peaks={displayedSpectrumPeakRows}
                            sources={spectrumPeakSources}
                            sourceId={spectrumPeakSourceId}
                            onSourceChange={setSpectrumPeakSourceId}
                            onXicSelected={handleXicSelected}
                            onAddPeak={spectrumPeakSourceId === "live" ? handleAddSpecPeak : undefined}
                            onDeletePeak={spectrumPeakSourceId === "live" ? handleSpecPeakDelete : undefined}
                          />
                        </div>
                      </TabsContent>
                      <TabsContent value="compare" className="mt-3">
                        <ComparisonTray
                          items={comparisonItems}
                          layout={comparisonLayout}
                          normalize={comparisonNormalize}
                          tolerance={comparisonTolerance}
                          onLayoutChange={setComparisonLayout}
                          onNormalizeChange={setComparisonNormalize}
                          onToleranceChange={setComparisonTolerance}
                          onPatch={handlePatchComparison}
                          onRemove={handleRemoveComparison}
                          onClear={handleClearComparison}
                        />
                      </TabsContent>
                      <TabsContent value="figure" className="mt-3">
                        <GcmsFigurePanel
                          hasRun={hasRun}
                          hasChromatogram={hasChromatogram}
                          subject={hasChromatogram ? figSubject : "spectrum"}
                          onSubjectChange={setFigSubject}
                          candidateTraces={figCandidateTraces}
                          includedTraceIds={figIncludedTraceIds}
                          onToggleTrace={handleToggleFigTrace}
                          candidateSpectra={figCandidateSpectra}
                          includedSpectrumIds={figIncludedSlotIds}
                          onToggleSpectrum={handleToggleFigSlot}
                          labelPeaks={figLabelPeaks}
                          onLabelPeaksChange={setFigLabelPeaks}
                          stackSpectra={figStackSpectra}
                          onStackSpectraChange={setFigStackSpectra}
                          hiddenPeakCount={figHiddenPeakCount}
                          onRestorePeaks={handleFigureRestorePeaks}
                          onDeletePeak={handleFigureDeletePeak}
                          chromFigureData={chromFigureData}
                          chromFigureOptions={chromFigureOptions}
                          onChromFigureOptionsChange={setChromFigureOptions}
                          specFigureData={specFigureData}
                          specFigureOptions={specFigureOptions}
                          onSpecFigureOptionsChange={setSpecFigureOptions}
                          bothFigureData={bothFigureData}
                          bothFigureOptions={bothFigureOptions}
                          onBothFigureOptionsChange={setBothFigureOptions}
                        />
                      </TabsContent>
                      <TabsContent value="predict-ms" className="mt-3">
                        <MsPredictPanel
                          activeRun={activeRun}
                          smiles={predictSmiles}
                          onSmilesChange={setPredictSmiles}
                          onFindFragment={handleFindFragment}
                          onMatchSpectrum={handleMatchPredictedSpectrum}
                          onSelectRt={setPinnedRt}
                        />
                      </TabsContent>
                      <TabsContent value="export" className="mt-3">
                        <ExportPanel
                          disabled={!hasRun}
                          scale={exportScale}
                          onScaleChange={setExportScale}
                          onExport={handleExport}
                        />
                      </TabsContent>
                    </Tabs>
                  </CardContent>
                </Card>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        )}
      </div>
    </AppShell>
  );
};

export default Gcms;

// ---------------------------------------------------------------------------
// Worker / main-thread dispatch helpers
// ---------------------------------------------------------------------------

/**
 * Run `buildXic` in the worker when ready, else on the main thread. Never
 * leaves the user with a dead page — the fallback is automatic.
 */
async function runBuildXic(
  run: MsRun,
  mzList: number[],
  tol: number,
  mode: "sum" | "max",
  status: WorkerStatus,
  options?: CallOptions,
): Promise<ChromTrace> {
  if (status === "ready") {
    const { trace } = await buildXicWorker(run, mzList, tol, mode, options);
    return trace;
  }
  return buildXicMain(run, mzList, tol, mode);
}

/** Build one independent XIC per m/z in one worker request (or synchronously
 *  through the identical main-thread helper when the worker is unavailable). */
async function runBuildXics(
  run: MsRun,
  mzList: number[],
  tol: number,
  status: WorkerStatus,
  options?: CallOptions,
): Promise<ChromTrace[]> {
  if (status === "ready") {
    const { traces } = await buildXicsWorker(run, mzList, tol, options);
    return traces;
  }
  return buildXicsMain(run, mzList, tol);
}

/**
 * Run `detectChromPeaks` in the worker when ready, else on the main thread.
 */
async function runDetectChromPeaks(
  trace: ChromTrace,
  opts: DetectChromPeaksOpts,
  status: WorkerStatus,
  options?: CallOptions,
): Promise<ChromPeak[]> {
  if (status === "ready") {
    const { peaks } = await detectChromPeaksWorker(trace, opts, options);
    return peaks;
  }
  return detectChromPeaksMain(trace, opts);
}

// ---------------------------------------------------------------------------
// Processing card — a compact inline panel for peak-detection parameters and
// the view toggles. Defined here rather than as a separate component file
// because it's the only place these controls live together.
// ---------------------------------------------------------------------------

function ProcessingCard({
  peakParams,
  onPeakParamsChange,
  logY,
  onLogYChange,
  normalize,
  onNormalizeChange,
  stacked,
  onStackedChange,
  lockSpectraToCursor,
  onLockSpectraToCursorChange,
  onDetectPeaks,
  busy,
  peakCount,
}: {
  peakParams: DetectChromPeaksOpts;
  onPeakParamsChange(p: DetectChromPeaksOpts): void;
  logY: boolean;
  onLogYChange(v: boolean): void;
  normalize: boolean;
  onNormalizeChange(v: boolean): void;
  stacked: boolean;
  onStackedChange(v: boolean): void;
  lockSpectraToCursor: boolean;
  onLockSpectraToCursorChange(v: boolean): void;
  onDetectPeaks(): void;
  busy: boolean;
  peakCount: number;
}) {
  return (
    <div className="flex flex-col gap-3">
      {/* Peak detection parameters */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Peak detection
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>Smooth</span>
            <Input
              type="number"
              min={1}
              className="h-7 w-14 px-1 text-xs"
              value={peakParams.smoothWindow}
              onChange={(e) =>
                onPeakParamsChange({ ...peakParams, smoothWindow: Number(e.target.value) || 1 })
              }
              title="Savitzky-Golay smoothing window (scans)"
            />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>Thr %</span>
            <Input
              type="number"
              step="any"
              min={0}
              className="h-7 w-14 px-1 text-xs"
              value={peakParams.thresholdPct}
              onChange={(e) =>
                onPeakParamsChange({ ...peakParams, thresholdPct: Number(e.target.value) || 0 })
              }
              title="Height threshold (% of trace max)"
            />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>Min w</span>
            <Input
              type="number"
              min={1}
              className="h-7 w-14 px-1 text-xs"
              value={peakParams.minWidthScans}
              onChange={(e) =>
                onPeakParamsChange({ ...peakParams, minWidthScans: Number(e.target.value) || 1 })
              }
              title="Minimum peak width (scans)"
            />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>Baseline</span>
            <select
              className="h-7 w-20 rounded border border-border/60 bg-background px-1 text-xs"
              value={peakParams.baseline}
              onChange={(e) =>
                onPeakParamsChange({
                  ...peakParams,
                  baseline: e.target.value as DetectChromPeaksOpts["baseline"],
                })
              }
              title="Baseline correction mode"
            >
              <option value="none">none</option>
              <option value="valley">valley</option>
              <option value="rolling">rolling</option>
            </select>
          </label>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-7 mt-1 text-[11px]"
          onClick={onDetectPeaks}
          disabled={busy}
        >
          Detect peaks ({peakCount})
        </Button>
      </div>

      <div className="h-px w-full bg-border/60" />

      {/* View toggles */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          View
        </div>
        <ToggleRow label="Normalize" value={normalize} onChange={onNormalizeChange} />
        <ToggleRow label="Stack" value={stacked} onChange={onStackedChange} />
        <ToggleRow label="Log Y" value={logY} onChange={onLogYChange} />
        <ToggleRow
          label="Lock spectra to cursor"
          value={lockSpectraToCursor}
          onChange={onLockSpectraToCursorChange}
        />
        {/* Background subtraction is now per-slot (task A): Ctrl-drag the
            chromatogram to seed a "Background" slot, then use its mode
            select in the spectrum stack to toggle subtraction on/off. */}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange(v: boolean): void;
}) {
  return (
    <label className="flex items-center justify-between gap-1.5 text-[11px] text-muted-foreground">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5"
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Empty workspace — the dashed drop target shown when no run is loaded.
// ---------------------------------------------------------------------------

function EmptyWorkspace({
  onFiles,
  busy,
  progress,
  errors,
  centroid,
  onCentroidChange,
}: {
  onFiles(files: File[]): void;
  busy: boolean;
  progress: { msg: string; frac: number } | null;
  errors: string[];
  centroid: boolean;
  onCentroidChange(v: boolean): void;
}) {
  return (
    <section className="rounded-3xl border-2 border-dashed border-border/70 bg-card/40 p-10 text-center shadow-card">
      <div className="mx-auto flex max-w-xl flex-col gap-3">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <HardDrive className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">Drop a GC/MS run to begin</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Drop an Agilent <span className="font-mono">.D</span> folder, a Waters{" "}
          <span className="font-mono">.raw</span> folder, or mzML / mzXML / MGF / netCDF / CSV /
          JCAMP files, anywhere on this page. Files are read locally in your browser — never
          uploaded, never modified.
        </p>
        <p className="text-xs text-muted-foreground">
          The reference sample folder is{" "}
          <span className="font-mono">ACSDCPD_50_1.D</span> (Agilent 6890/5973
          ChemStation).
        </p>
        <div className="mx-auto mt-3 w-full max-w-sm text-left">
          <ImportPanel
            onFiles={onFiles}
            busy={busy}
            progress={progress}
            errors={errors}
            centroid={centroid}
            onCentroidChange={onCentroidChange}
          />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// SidebarCard — mirrors Maldi.tsx's helper exactly.
// ---------------------------------------------------------------------------

function SidebarCard({
  id: _id,
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

// ---------------------------------------------------------------------------
// WorkerBadge — mirrors Maldi.tsx's badge, with the fallback state added.
// ---------------------------------------------------------------------------

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
  if (status === "fallback") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-600 dark:text-amber-500">
        <CircleSlash className="h-3.5 w-3.5" />
        Running on main thread
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
