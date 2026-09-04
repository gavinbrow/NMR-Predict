// DSC analysis workspace. Reads differential scanning calorimetry files from
// a TA DSC25 driven by TRIOS (.tri / .xls), TA Q-series text/binary exports,
// or a generic CSV/XLSX with a column-mapping dialog. Computes Tg + Δcp,
// melting/crystallization ΔH, % crystallinity, and cure exotherm/OIT,
// overlays multiple runs, and builds a publication figure — the same shape
// as `pages/Tga.tsx`, which this file is a close adaptation of.
//
// This is WP6: the final wiring step. Every other work package (parsers,
// store, compute engine, plot adapter, figure adapter, compare, export) has
// already landed under `lib/dsc/` and `components/dsc/`; this file's only
// job is to hoist the shared view state and plug the finished components
// into the layout WP0 built.
//
// The provider lives at the page root so the whole store survives tab
// switches via the app's keep-alive routing (App.tsx). Every piece of view
// state that a tab could destroy is hoisted to the always-mounted
// `DscWorkspace`, because `TabsContent` has no `forceMount` in this codebase
// and panel-local state would be torn down on every tab switch — the exact
// bug `components/maldi/figure/MaldiFigurePanel.tsx`'s doc comment calls out
// (see "WP0a" there).

import {
  Activity,
  FileSpreadsheet,
  Flame,
  Layers,
  Sliders,
  Snowflake,
  Thermometer,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ColumnMapDialog } from "@/components/dsc/ColumnMapDialog";
import { ComparePanel, type CompareGrouping } from "@/components/dsc/ComparePanel";
import { CrystallinityPanel } from "@/components/dsc/CrystallinityPanel";
import { CurePanel } from "@/components/dsc/CurePanel";
import { DscPlot } from "@/components/dsc/DscPlot";
import { ExportMenu } from "@/components/dsc/ExportMenu";
import { FeaturePanel } from "@/components/dsc/FeaturePanel";
import { FileDropzone } from "@/components/dsc/FileDropzone";
import { MarkersPanel } from "@/components/dsc/MarkersPanel";
import { MaterialsPanel } from "@/components/dsc/MaterialsPanel";
import { MetadataPanel } from "@/components/dsc/MetadataPanel";
import { ParamControls } from "@/components/dsc/ParamControls";
import { RunCard } from "@/components/dsc/RunCard";
import { SegmentPicker } from "@/components/dsc/SegmentPicker";
import { SummaryTable } from "@/components/dsc/SummaryTable";
import { TransitionTable } from "@/components/dsc/TransitionTable";
import { DscFigurePanel } from "@/components/dsc/figure/DscFigurePanel";
import { useFigureOptions } from "@/components/ir/figure/useFigureOptions";
import {
  defaultFigureOptions,
  mergeSavedFigureOptions,
  type FigureOptionSeed,
  type FigureOptions,
} from "@/lib/ir/figure";
import { loadRememberedMaps } from "@/lib/dsc/columnMaps";
import { buildMaterialBars, buildRunBars, dscMetrics, metricValue } from "@/lib/dsc/compare";
import { deserializeDscProject } from "@/lib/dsc/export";
import {
  buildDscFigureData,
  type DscMarkerToggles as DscFigureMarkerToggles,
  type DscY2,
} from "@/lib/dsc/figure";
import { headerSignature } from "@/lib/dsc/parse/genericTable";
import { parseDscFiles, parseMappedGrid, type PendingDscColumnMap } from "@/lib/dsc/parse";
import {
  buildDscPlotMarkers,
  buildDscPlotTraces,
  dscPlotXLabel,
  dscPlotY2Label,
  dscPlotYLabel,
  type DscMarkerToggles as DscPlotMarkerToggles,
  type DscPlotSegmentMode,
  type DscPlotXAxis,
  type DscPlotY2Mode,
  type DscPlotYAxis,
} from "@/lib/dsc/plot";
import { DscProvider, useDscStore, type DscRunAnalyzed } from "@/lib/dsc/store";
import type { DscColumnMap, ParsedDscFile } from "@/lib/dsc/types";

/** Per-feature-kind callout toggles for the on-screen plot's overlay, keyed
 *  by every `DscFeatureKind` except "custom" (a user-placed feature is
 *  always shown — there is no kind-level toggle for it), plus the three
 *  marker-family toggles (`baselines`/`tangents`/`enthalpyLabels`). Those
 *  three default OFF: a fresh analysis should show the transition callouts
 *  (Tg/Tm/…) without also cluttering the plot with every fitted baseline,
 *  tangent, and ΔH label the user hasn't asked to see — see
 *  `lib/dsc/plot.ts`'s `DscMarkerToggles` doc comment. */
const DEFAULT_PLOT_MARKERS: DscPlotMarkerToggles = {
  glass: true,
  melt: true,
  crystallization: true,
  coldCrystallization: true,
  cure: true,
  oit: true,
  baselines: false,
  tangents: false,
  enthalpyLabels: false,
  // On by default — the pre-existing behaviour. This is the "declutter"
  // toggle a user reaches for AFTER seeing the marker lines, to drop them
  // while keeping every Tg/Tm/… label right where it was.
  verticals: true,
};

/** Marker-family toggles for the Figure tab. A different shape from the
 *  plot's toggles above (per marker family, not per feature kind) — kept as
 *  genuinely separate state, per §WP6. */
const DEFAULT_FIGURE_MARKERS: DscFigureMarkerToggles = {
  glassOnset: true,
  glassMid: true,
  glassEndset: true,
  peakTemp: true,
  peakOnset: true,
  peakEndset: true,
  // Off by default — same reasoning as the plot's `DEFAULT_PLOT_MARKERS`:
  // the Tg/Tm/… callouts should appear without also drawing every fitted
  // baseline/tangent/ΔH label unasked.
  baselines: false,
  tangents: false,
  enthalpyLabels: false,
  // On by default — the pre-existing behaviour; see the plot's
  // `DEFAULT_PLOT_MARKERS` doc comment above for why this one starts true
  // where its neighbours start false.
  verticals: true,
};

/** The DSC figure defaults — MALDI's / TGA's verbatim. TGA callouts are
 *  sparse and DSC's are too (a handful of ΔH/Tg labels per run), so the
 *  diagonal labels that exist to pack dense MALDI m/z sticks would only
 *  hurt legibility here; decluttering stays on because every DSC callout
 *  carries custom text, which bypasses the min-gap thinner. */
const DSC_FIGURE_SEED: FigureOptionSeed = {
  fontFamily: "Times New Roman",
  width: 800,
  height: 600,
  pngScale: 10,
  showGrid: false,
  background: "transparent",
  axisBold: true,
  peakLabels: { rotation: 0, maxLabels: 40, minGap: 6, decimals: 1, declutter: true },
  legend: { show: true },
};

/** The summary-strip metrics, in display order: Tg mid, Δcp, Tm, ΔHm, Tc,
 *  ΔHc, Xc. `dscMetrics()` already lists them in this relative order, so
 *  filtering to this key set preserves it. */
const SUMMARY_STRIP_KEYS = ["tgMid", "deltaCp", "tm", "dHm", "tc", "dHc", "crystallinity"];

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-card">{children}</div>;
}

function CapabilityTile({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Activity;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4 shadow-card">
      <Icon className="mb-2 h-5 w-5 text-primary" />
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}

/** The active run's headline numbers, laid out as a row of stat chips above
 *  the plot. Reuses `metricValue`/`dscMetrics` rather than reading
 *  `run.analysis` fields directly, so this readout always agrees with the
 *  Compare tab and the exports. */
function SummaryStrip({ run }: { run: DscRunAnalyzed | null }) {
  if (!run) return null;
  const metrics = dscMetrics().filter((m) => SUMMARY_STRIP_KEYS.includes(m.key));
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-card">
      {metrics.map((m) => {
        const v = metricValue(run, m.key);
        return (
          <div key={m.key} className="flex flex-col">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {m.label}
            </span>
            <span className="text-sm font-semibold text-foreground">
              {Number.isFinite(v) ? v.toFixed(m.decimals) : "—"}
              <span className="ml-1 text-xs font-normal text-muted-foreground">{m.unit}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * File import for both dropzones.
 *
 * A `.dscproj` REPLACES the workspace (it is a saved workspace, not another
 * sample) — accepted here as well as from the export menu, because the menu
 * only exists once data is loaded and "open my saved project" is the first
 * thing you want to do on an empty page. Generic tables whose columns can't
 * be auto-detected come back from `parseDscFiles` in `needsMapping` and are
 * queued for the `ColumnMapDialog`, one at a time; a mapping the user has
 * confirmed before (matched by header signature) is applied silently, so the
 * same export layout only ever asks once. Mirrors `Tga.tsx`'s `useTgaImport`.
 */
function useDscImport(onFigureOptionsRestored: (options: FigureOptions | null) => void) {
  const { addParsedFiles, loadProject } = useDscStore();
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<PendingDscColumnMap[]>([]);

  const onFiles = useCallback(
    async (files: File[]) => {
      setBusy(true);
      try {
        const projects = files.filter((f) => f.name.toLowerCase().endsWith(".dscproj"));
        const dataFiles = files.filter((f) => !f.name.toLowerCase().endsWith(".dscproj"));
        // A project replaces the workspace, so only the last one wins and it is
        // applied before anything else is appended on top of it.
        const project = projects[projects.length - 1];
        if (project) {
          try {
            const { state, figureOptions: saved } = deserializeDscProject(await project.text());
            loadProject(state);
            onFigureOptionsRestored(saved);
            toast.success(`Opened ${project.name}`, {
              description: `${state.runs.length} run(s), ${state.materials.length} material(s).`,
            });
          } catch (err) {
            toast.error(`Couldn't open ${project.name}`, {
              description: err instanceof Error ? err.message : undefined,
            });
          }
          if (projects.length > 1) {
            toast.message(`Opened the last of ${projects.length} project files.`);
          }
        }
        if (dataFiles.length === 0) return;
        const { parsed, skipped, needsMapping, warnings } = await parseDscFiles(dataFiles);
        const remembered = loadRememberedMaps();
        const stillPending: PendingDscColumnMap[] = [];
        const extra: ParsedDscFile[] = [];
        for (const p of needsMapping) {
          // The dialog remembers a mapping per header layout, so a repeat
          // import of the same export shape never asks again.
          const known = remembered[headerSignature(p.grid.rows[p.suggestion?.headerRow ?? 0] ?? [])];
          if (known) extra.push(parseMappedGrid(p, known));
          else stillPending.push(p);
        }
        const all = [...parsed, ...extra];
        if (all.length > 0) addParsedFiles(all);
        for (const w of warnings) toast.warning(w);
        if (skipped.length > 0) {
          toast.message(`Skipped ${skipped.length} file(s) (unsupported format).`);
        }
        if (stillPending.length > 0) setQueue((q) => [...q, ...stillPending]);
        if (
          all.length === 0 &&
          warnings.length === 0 &&
          skipped.length === 0 &&
          stillPending.length === 0
        ) {
          toast.error("No DSC runs found in the dropped files.");
        }
      } finally {
        setBusy(false);
      }
    },
    [addParsedFiles, loadProject, onFigureOptionsRestored],
  );

  const pending = queue[0] ?? null;
  const confirmMapping = useCallback(
    (map: DscColumnMap) => {
      setQueue((q) => {
        const [head, ...rest] = q;
        if (head) {
          const file = parseMappedGrid(head, map);
          if (file.runs.length > 0) addParsedFiles([file]);
          else toast.warning(`${head.fileName}: no data rows matched that mapping.`);
        }
        return rest;
      });
    },
    [addParsedFiles],
  );
  const skipMapping = useCallback(() => setQueue((q) => q.slice(1)), []);

  return { onFiles, busy, pending, confirmMapping, skipMapping };
}

function EmptyWorkspace({
  onFiles,
  busy,
}: {
  onFiles: (files: File[]) => void;
  busy: boolean;
}) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <section className="rounded-2xl border border-border/70 bg-card px-6 py-8 shadow-card">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1 text-xs font-semibold text-primary">
          <Thermometer className="h-3.5 w-3.5" />
          Thermal analysis
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">DSC analysis</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          Drop TRIOS DSC25 .tri/.xls files, TA Q-series text or binary exports, or any CSV/XLSX —
          pick a heat/cool segment, measure Tg, melting, crystallization and cure, and build
          publication figures.
        </p>
      </section>
      <Card>
        <FileDropzone onFiles={onFiles} />
        {busy && <p className="mt-3 text-center text-xs text-muted-foreground">Parsing…</p>}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <CapabilityTile
            icon={FileSpreadsheet}
            title="Universal import"
            description="TRIOS .tri/.xls, TA Q-series text and binary, or any CSV/XLSX with a column-mapping dialog."
          />
          <CapabilityTile
            icon={Activity}
            title="Full DSC toolkit"
            description="Glass transition (ASTM E1356), melt/crystallization ΔH, % crystallinity, cure exotherm and OIT."
          />
          <CapabilityTile
            icon={Layers}
            title="Replicate comparison"
            description="Group runs into materials and compare mean ± SD across replicates."
          />
          <CapabilityTile
            icon={TrendingUp}
            title="Publication figures"
            description="Build a styled figure and export to Excel with native charts, PDF, and CSV."
          />
        </div>
      </Card>
    </div>
  );
}

function DscWorkspace() {
  const store = useDscStore();
  const {
    hasData,
    files,
    runs,
    materials,
    params,
    references,
    setParams,
    setRunColor,
    setRunMass,
    setRunScale,
    setRunOffset,
    toggleRunVisible,
    renameRun,
    removeRun,
    setActiveSegment,
    setPolymerFraction,
    setRunReference,
    addFeature,
    updateFeature,
    removeFeature,
    resetFeatures,
    addReference,
    updateReference,
    deleteReference,
    clearAll,
  } = store;

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId],
  );

  // --- Shared view state, hoisted so no tab switch can destroy it (see the
  //     file-level doc comment). xAxis/yAxis/segmentMode are shared between
  //     the on-screen plot and the Figure tab (both `DscPlotXAxis`/
  //     `DscPlotYAxis` and the figure adapter's `DscXAxis`/`DscYAxis` are the
  //     same string unions). y2Mode (plot) and figureY2/figureMarkers
  //     (figure) stay genuinely separate — they drive different toggle
  //     strips over different surfaces, exactly like TGA keeps its plot and
  //     figure toggles apart.
  const [xAxis, setXAxis] = useState<DscPlotXAxis>("temperature");
  const [yAxis, setYAxis] = useState<DscPlotYAxis>("wattsPerGram");
  const [y2Mode, setY2Mode] = useState<DscPlotY2Mode>("off");
  const [segmentMode, setSegmentMode] = useState<DscPlotSegmentMode>("active");
  const [showMarkerLabels, setShowMarkerLabels] = useState(true);
  const [plotMarkers, setPlotMarkers] = useState<DscPlotMarkerToggles>(DEFAULT_PLOT_MARKERS);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  // Display-only trace normalization (map each trace onto its own 0..1
  // span) — shared verbatim between the on-screen plot and the Figure tab,
  // exactly like `xAxis`/`yAxis`/`segmentMode` above. Never touches `params`
  // or any computed analysis number; see `lib/dsc/plot.ts`'s and
  // `lib/dsc/figure.ts`'s matching `normalizeTraces` doc comments.
  const [normalizeTraces, setNormalizeTraces] = useState(false);

  // Spinner increment for every run's Y-offset field (`RunCard` and
  // `DscFigurePanel`'s per-run strip), derived from the CURRENT display
  // mode rather than hardcoded: DSC heat flow is ~0.3 W/g (or, once
  // normalized, confined to 0..1), so a step of `1` throws the trace clean
  // off the chart on one spinner click — the bug `RunCard`'s own doc
  // comment on this prop names. `0.01` covers W/g and normalized display;
  // raw mW values run roughly 1-10, an order of magnitude larger, so `0.1`
  // (also an order of magnitude larger) keeps the same "a few clicks moves
  // it a visible but sane amount" feel rather than being either imperceptible
  // or a single click blowing the trace off-screen again.
  const offsetStep = normalizeTraces || yAxis === "wattsPerGram" ? 0.01 : 0.1;

  // Figure-tab-only state.
  const [figShowCurve, setFigShowCurve] = useState(true);
  const [figureY2, setFigureY2] = useState<DscY2>("none");
  const [figLabelFeatures, setFigLabelFeatures] = useState(true);
  const [figStackRuns, setFigStackRuns] = useState(false);
  // Fixed vertical spacing between stacked runs (Figure tab only — the
  // on-screen plot never stacks). `null` keeps the adapter's automatic
  // accumulated-height ladder; see `lib/dsc/figure.ts`'s `stackSpacing` doc
  // comment.
  const [figStackSpacing, setFigStackSpacing] = useState<number | null>(null);
  const [figureMarkers, setFigureMarkers] = useState<DscFigureMarkerToggles>(DEFAULT_FIGURE_MARKERS);

  // Cure / OIT — a genuinely persistent value (should survive a tab switch).
  const [cureTotalJPerG, setCureTotalJPerG] = useState<number | null>(null);

  // Compare-tab state.
  const metrics = useMemo(() => dscMetrics(), []);
  const [metricKey, setMetricKey] = useState<string>("tm");
  const [grouping, setGrouping] = useState<CompareGrouping>("material");
  const activeMetricKey = metrics.some((m) => m.key === metricKey) ? metricKey : (metrics[0]?.key ?? "");
  const activeMetric = metrics.find((m) => m.key === activeMetricKey);

  // --- Derived plot data ---
  const plotTraces = useMemo(
    () => buildDscPlotTraces({ runs, params, xAxis, yAxis, y2Mode, segmentMode, normalizeTraces }),
    [runs, params, xAxis, yAxis, y2Mode, segmentMode, normalizeTraces],
  );
  const plotMarkerOverlays = useMemo(
    () => buildDscPlotMarkers({ runs, params, xAxis, yAxis, markers: plotMarkers, normalizeTraces }),
    [runs, params, xAxis, yAxis, plotMarkers, normalizeTraces],
  );

  // A feature can belong to any run, not just the selected one (the plot
  // draws every visible run's markers) — resolve the owner from the id
  // rather than assuming it's always `selectedRun`.
  const updateFeatureById = useCallback(
    (featureId: string, patch: { window?: [number, number]; baseline?: [number, number] }) => {
      const owner = runs.find((r) => r.features.some((f) => f.id === featureId));
      if (owner) updateFeature(owner.id, featureId, patch);
    },
    [runs, updateFeature],
  );

  // --- Derived figure data ---
  const figureRuns = useMemo(
    () =>
      runs.map((r) => ({
        id: r.id,
        label: r.label,
        color: r.color,
        visible: r.visible,
        scale: r.scale,
        offset: r.offset,
      })),
    [runs],
  );
  const figureData = useMemo(
    () =>
      buildDscFigureData({
        runs: figShowCurve ? runs : [],
        xAxis,
        yAxis,
        y2: figureY2,
        segmentMode,
        labelFeatures: figLabelFeatures,
        stackRuns: figStackRuns,
        stackSpacing: figStackSpacing,
        normalizeTraces,
        markers: figureMarkers,
        sourceName: selectedRun?.fileName.replace(/\.[^.]+$/, "") ?? undefined,
      }),
    [
      runs,
      figShowCurve,
      xAxis,
      yAxis,
      figureY2,
      segmentMode,
      figLabelFeatures,
      figStackRuns,
      figStackSpacing,
      normalizeTraces,
      figureMarkers,
      selectedRun,
    ],
  );
  const [figureOptions, setFigureOptions] = useFigureOptions(figureData, DSC_FIGURE_SEED);

  // Restoring a `.dscproj`: layer the saved options over freshly-seeded ones
  // so a project written by an older build still opens (same pattern as
  // TGA/MALDI). Declared before `useDscImport` because a dropped `.dscproj`
  // carries figure styling.
  const restoreFigureOptions = useCallback(
    (saved: FigureOptions | null) => {
      setFigureOptions(mergeSavedFigureOptions(defaultFigureOptions(figureData, DSC_FIGURE_SEED), saved));
    },
    [figureData, setFigureOptions],
  );

  const { onFiles, busy, pending, confirmMapping, skipMapping } =
    useDscImport(restoreFigureOptions);

  const bars = useMemo(
    () =>
      grouping === "material"
        ? buildMaterialBars(runs, materials, activeMetricKey)
        : buildRunBars(runs, activeMetricKey),
    [grouping, runs, materials, activeMetricKey],
  );

  const headerAccessory = hasData ? (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground">
        {files.length} file{files.length === 1 ? "" : "s"} · {runs.length} run
        {runs.length === 1 ? "" : "s"} · {materials.length} material
        {materials.length === 1 ? "" : "s"}
      </span>
      <ExportMenu
        figureData={figureData}
        figureOptions={figureOptions}
        onFigureOptionsRestored={restoreFigureOptions}
      />
      <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={clearAll}>
        <Trash2 className="h-3 w-3" />
        Clear all
      </Button>
    </div>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 font-medium text-success">
      <Thermometer className="h-3 w-3" />
      Local DSC workspace
    </span>
  );

  return (
    <AppShell headerAccessory={headerAccessory} mainClassName="px-4 py-5 sm:px-6">
      {hasData ? (
        <div className="mx-auto flex w-full max-w-[1700px] flex-col gap-4 lg:flex-row">
          {/* Left rail */}
          <aside className="flex w-full flex-col gap-4 lg:w-[340px] lg:shrink-0">
            <CollapsibleSection
              title="Files / Runs"
              icon={FileSpreadsheet}
              count={runs.length}
              defaultOpen
              contentClassName="flex flex-col gap-3"
            >
              <FileDropzone onFiles={onFiles} compact />
              {busy && <p className="text-center text-[11px] text-muted-foreground">Parsing…</p>}
              <div className="flex flex-col gap-1">
                {files.map((f) => (
                  <div key={f.id} className="text-[11px] text-muted-foreground">
                    {f.fileName} — {f.runCount} run(s)
                    {f.warnings.length > 0 ? ` · ${f.warnings.length} warning(s)` : ""}
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-2">
                {runs.map((r) => (
                  <div
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedRunId(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setSelectedRunId(r.id);
                    }}
                    className={`rounded-lg text-left ${
                      selectedRun?.id === r.id ? "ring-2 ring-primary/40" : ""
                    }`}
                  >
                    <RunCard
                      run={r}
                      onSetColor={(c) => setRunColor(r.id, c)}
                      onRename={(l) => renameRun(r.id, l)}
                      onSetMass={(m) => setRunMass(r.id, m)}
                      onToggleVisible={() => toggleRunVisible(r.id)}
                      onSetScale={(s) => setRunScale(r.id, s)}
                      onSetOffset={(o) => setRunOffset(r.id, o)}
                      offsetStep={offsetStep}
                      onRemove={() => {
                        removeRun(r.id);
                        if (selectedRunId === r.id) setSelectedRunId(null);
                      }}
                    />
                  </div>
                ))}
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              title="Segments"
              icon={Layers}
              count={selectedRun?.segments.length ?? 0}
              defaultOpen
            >
              {selectedRun ? (
                <SegmentPicker
                  segments={selectedRun.segments}
                  activeSegmentId={selectedRun.activeSegmentId}
                  onSelect={(segId) => setActiveSegment(selectedRun.id, segId)}
                />
              ) : (
                <p className="text-xs text-muted-foreground">Select a run to see its segments.</p>
              )}
            </CollapsibleSection>

            <CollapsibleSection title="Analysis parameters" icon={Sliders}>
              <ParamControls params={params} onPatch={setParams} />
            </CollapsibleSection>

            <CollapsibleSection title="Transitions" icon={Activity}>
              <FeaturePanel
                run={selectedRun}
                selectedFeatureId={selectedFeatureId}
                onSelectFeature={setSelectedFeatureId}
                onAddFeature={(feature) => selectedRun && addFeature(selectedRun.id, feature)}
                onUpdateFeature={(featureId, patch) =>
                  selectedRun && updateFeature(selectedRun.id, featureId, patch)
                }
                onRemoveFeature={(featureId) =>
                  selectedRun && removeFeature(selectedRun.id, featureId)
                }
                onResetFeatures={() => selectedRun && resetFeatures(selectedRun.id)}
              />
            </CollapsibleSection>

            <CollapsibleSection title="Crystallinity" icon={Snowflake}>
              <CrystallinityPanel
                run={selectedRun}
                userReferences={references}
                onSetReference={(id) => selectedRun && setRunReference(selectedRun.id, id)}
                onSetPolymerFraction={(f) => selectedRun && setPolymerFraction(selectedRun.id, f)}
                onAddReference={addReference}
                onUpdateReference={updateReference}
                onDeleteReference={deleteReference}
              />
            </CollapsibleSection>

            <CollapsibleSection title="Cure / OIT" icon={Flame}>
              <CurePanel
                run={selectedRun}
                totalJPerG={cureTotalJPerG}
                onTotalChange={setCureTotalJPerG}
              />
            </CollapsibleSection>

            <CollapsibleSection title="Materials" icon={Layers} count={materials.length}>
              <MaterialsPanel
                metric={activeMetric}
                selectedRunIds={selectedRun ? [selectedRun.id] : []}
                onSelectRun={setSelectedRunId}
              />
            </CollapsibleSection>

            <CollapsibleSection title="Run metadata" icon={FileSpreadsheet}>
              <MetadataPanel run={selectedRun} />
            </CollapsibleSection>
          </aside>

          {/* Main column */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <Tabs defaultValue="analysis">
              <TabsList>
                <TabsTrigger value="analysis">Analysis</TabsTrigger>
                <TabsTrigger value="compare">Compare</TabsTrigger>
                <TabsTrigger value="figure">Figure</TabsTrigger>
              </TabsList>

              <TabsContent value="analysis" className="mt-3">
                <div className="flex flex-col gap-4">
                  <SummaryStrip run={selectedRun} />
                  <div className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card p-4 shadow-card">
                    <MarkersPanel
                      xAxis={xAxis}
                      onXAxisChange={setXAxis}
                      yAxis={yAxis}
                      onYAxisChange={setYAxis}
                      y2Mode={y2Mode}
                      onY2ModeChange={setY2Mode}
                      segmentMode={segmentMode}
                      onSegmentModeChange={setSegmentMode}
                      showMarkerLabels={showMarkerLabels}
                      onShowMarkerLabelsChange={setShowMarkerLabels}
                      markers={plotMarkers}
                      onMarkersChange={setPlotMarkers}
                      normalizeTraces={normalizeTraces}
                      onNormalizeTracesChange={setNormalizeTraces}
                    />
                    <DscPlot
                      traces={plotTraces}
                      markers={plotMarkerOverlays}
                      xLabel={dscPlotXLabel(xAxis)}
                      yLabel={dscPlotYLabel(yAxis, params.exoUp, params.showExoArrow, normalizeTraces)}
                      y2Label={dscPlotY2Label(y2Mode, xAxis)}
                      showY2={y2Mode !== "off"}
                      showMarkerLabels={showMarkerLabels}
                      selectedFeatureId={selectedFeatureId}
                      onSetFeatureWindow={(featureId, window) =>
                        updateFeatureById(featureId, { window })
                      }
                      onSetFeatureBaseline={(featureId, baseline) =>
                        updateFeatureById(featureId, { baseline })
                      }
                      minHeight={420}
                    />
                    {selectedRun && selectedRun.analysis.warnings.length > 0 && (
                      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                        {selectedRun.analysis.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <CollapsibleSection title="Transitions" icon={Activity} defaultOpen>
                    <TransitionTable runs={runs} />
                  </CollapsibleSection>
                  <CollapsibleSection title="Summary" icon={TrendingUp} defaultOpen>
                    <SummaryTable runs={runs} />
                  </CollapsibleSection>
                </div>
              </TabsContent>

              <TabsContent value="compare" className="mt-3">
                <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-card">
                  <ComparePanel
                    bars={bars}
                    metrics={metrics}
                    metricKey={activeMetricKey}
                    onMetricChange={setMetricKey}
                    grouping={grouping}
                    onGroupingChange={setGrouping}
                  />
                </div>
              </TabsContent>

              <TabsContent value="figure" className="mt-3">
                <DscFigurePanel
                  runs={figureRuns}
                  xAxis={xAxis}
                  onXAxisChange={setXAxis}
                  yAxis={yAxis}
                  onYAxisChange={setYAxis}
                  showCurve={figShowCurve}
                  onShowCurveChange={setFigShowCurve}
                  y2={figureY2}
                  onY2Change={setFigureY2}
                  segmentMode={segmentMode}
                  onSegmentModeChange={setSegmentMode}
                  labelFeatures={figLabelFeatures}
                  onLabelFeaturesChange={setFigLabelFeatures}
                  stackRuns={figStackRuns}
                  onStackRunsChange={setFigStackRuns}
                  stackSpacing={figStackSpacing}
                  onStackSpacingChange={setFigStackSpacing}
                  normalizeTraces={normalizeTraces}
                  onNormalizeTracesChange={setNormalizeTraces}
                  offsetStep={offsetStep}
                  onSetRunScale={setRunScale}
                  onSetRunOffset={setRunOffset}
                  markers={figureMarkers}
                  onMarkersChange={setFigureMarkers}
                  figureData={figureData}
                  figureOptions={figureOptions}
                  onFigureOptionsChange={setFigureOptions}
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      ) : (
        <EmptyWorkspace onFiles={onFiles} busy={busy} />
      )}

      {/* One dialog at a time; keyed so each pending file starts from its own
          suggestion rather than the previous file's answers. */}
      {pending && (
        <ColumnMapDialog
          key={pending.fileName}
          pending={pending}
          onCancel={skipMapping}
          onConfirm={confirmMapping}
        />
      )}
    </AppShell>
  );
}

const Dsc = () => (
  <DscProvider>
    <DscWorkspace />
  </DscProvider>
);

export default Dsc;
