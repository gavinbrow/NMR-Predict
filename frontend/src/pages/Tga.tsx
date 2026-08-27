// TGA analysis workspace. Reads thermogravimetric files from a TA Q50 and a
// TRIOS-driven Discovery TGA 5500 (plus generic CSV/spreadsheet exports),
// computes the standard TGA numbers (T5%/T10%/T50%, extrapolated onset, DTG
// peak temperatures, residue, per-step mass loss), overlays multiple runs, and
// builds publication figures with a secondary (right-hand) y-axis for DTG —
// the priority feature, sharing the same figure engine as MALDI/GC-MS/IR.
//
// The provider lives at the page root so the whole store survives tab switches
// via the app's keep-alive routing (App.tsx). Every piece of view state that a
// tab could destroy — the Figure tab's options, the plot's axis/marker toggles,
// the Compare tab's metric — is hoisted to the always-mounted `TgaWorkspace`,
// because `TabsContent` has no `forceMount` and panel-local state would be torn
// down on every tab switch.

import {
  Activity,
  FileSpreadsheet,
  FlaskConical,
  Layers,
  ListOrdered,
  Sliders,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ColumnMapDialog } from "@/components/tga/ColumnMapDialog";
import { ComparePanel, type CompareGrouping } from "@/components/tga/ComparePanel";
import { ExportMenu } from "@/components/tga/ExportMenu";
import { FileDropzone } from "@/components/tga/FileDropzone";
import { MarkersPanel } from "@/components/tga/MarkersPanel";
import { MaterialsPanel } from "@/components/tga/MaterialsPanel";
import { MetadataPanel } from "@/components/tga/MetadataPanel";
import { ParamControls } from "@/components/tga/ParamControls";
import { RunCard } from "@/components/tga/RunCard";
import { StepTable } from "@/components/tga/StepTable";
import { SummaryTable } from "@/components/tga/SummaryTable";
import { TgaPlot } from "@/components/tga/TgaPlot";
import { TgaFigurePanel } from "@/components/tga/figure/TgaFigurePanel";
import { useFigureOptions } from "@/components/ir/figure/useFigureOptions";
import {
  defaultFigureOptions,
  mergeSavedFigureOptions,
  type FigureOptionSeed,
  type FigureOptions,
} from "@/lib/ir/figure";
import { loadRememberedMaps } from "@/lib/tga/columnMaps";
import { buildMaterialBars, buildRunBars, tgaMetrics } from "@/lib/tga/compare";
import {
  buildTgaFigureData,
  type TgaMarkerToggles,
  type TgaXAxis,
  type TgaYAxis,
} from "@/lib/tga/figure";
import {
  buildTgaPlotMarkers,
  buildTgaPlotTraces,
  plotXLabel,
  plotY2Label,
  plotYLabel,
} from "@/lib/tga/plot";
import { deserializeTgaProject } from "@/lib/tga/export";
import { parseMappedGrid, parseTgaFiles, type PendingColumnMap } from "@/lib/tga/parse";
import { headerSignature } from "@/lib/tga/parse/genericTable";
import { TgaProvider, useTgaStore } from "@/lib/tga/store";
import type { ColumnMap } from "@/lib/tga/types";

/** The TGA figure defaults — MALDI's verbatim, with `rotation: 0`,
 *  `decimals: 1` and decluttering on. TGA callouts are sparse, so the diagonal
 *  labels that exist to pack dense MALDI m/z sticks would only hurt legibility
 *  here; but every TGA callout carries custom text, which bypasses the min-gap
 *  thinner, so four overlaid runs put a dozen labels at the same temperature
 *  unless the renderer pushes them apart. */
const TGA_FIGURE_SEED: FigureOptionSeed = {
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

/**
 * File import for both dropzones.
 *
 * Three things arrive through the same gesture. A `.tgaproj` REPLACES the
 * workspace (it is a saved workspace, not another sample) — accepted here as
 * well as from the export menu, because the menu only exists once data is
 * loaded and "open my saved project" is the first thing you want to do on an
 * empty page. Generic tables whose columns can't be auto-detected come back
 * from `parseTgaFiles` in `needsMapping` and are queued for the
 * `ColumnMapDialog`, one at a time; a mapping the user has confirmed before
 * (matched by header signature) is applied silently, so the same export layout
 * only ever asks once. Everything else is parsed and appended.
 */
function useTgaImport(onFigureOptionsRestored: (options: FigureOptions | null) => void) {
  const { addParsedFiles, loadProject } = useTgaStore();
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<PendingColumnMap[]>([]);

  const onFiles = useCallback(
    async (files: File[]) => {
      setBusy(true);
      try {
        const projects = files.filter((f) => f.name.toLowerCase().endsWith(".tgaproj"));
        const dataFiles = files.filter((f) => !f.name.toLowerCase().endsWith(".tgaproj"));
        // A project replaces the workspace, so only the last one wins and it is
        // applied before anything else is appended on top of it.
        const project = projects[projects.length - 1];
        if (project) {
          try {
            const { state, figureOptions: saved } = deserializeTgaProject(await project.text());
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
        const { parsed, skipped, needsMapping, warnings } = await parseTgaFiles(dataFiles);
        const remembered = loadRememberedMaps();
        const stillPending: PendingColumnMap[] = [];
        const extra = [];
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
          toast.error("No TGA runs found in the dropped files.");
        }
      } finally {
        setBusy(false);
      }
    },
    [addParsedFiles, loadProject, onFigureOptionsRestored],
  );

  const pending = queue[0] ?? null;
  const confirmMapping = useCallback(
    (map: ColumnMap) => {
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
          <FlaskConical className="h-3.5 w-3.5" />
          Thermal analysis
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">TGA analysis</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          Drop thermogravimetric files from a TA Q50 or a TRIOS-driven Discovery TGA 5500 —
          or any CSV or spreadsheet export. Compute Td / onset / DTG / residue, overlay runs,
          and build publication figures with a secondary axis.
        </p>
      </section>
      <Card>
        <FileDropzone onFiles={onFiles} />
        {busy && <p className="mt-3 text-center text-xs text-muted-foreground">Parsing…</p>}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <CapabilityTile
            icon={TrendingUp}
            title="Decomposition"
            description="T5%, T10%, T50%, extrapolated onset, DTG peak temperatures."
          />
          <CapabilityTile
            icon={Activity}
            title="Overlay runs"
            description="Compare multiple samples on one plot with a right-hand DTG axis."
          />
          <CapabilityTile
            icon={Sliders}
            title="Tune live"
            description="Normalization mode, DTG window, Td thresholds — recompute instantly."
          />
          <CapabilityTile
            icon={FileSpreadsheet}
            title="Publication figures"
            description="Times New Roman, transparent, bold axes — MALDI's figure defaults."
          />
        </div>
      </Card>
    </div>
  );
}

function TgaWorkspace() {
  const store = useTgaStore();
  const {
    hasData,
    files,
    runs,
    materials,
    params,
    blankRunId,
    setParams,
    setRunColor,
    setRunScale,
    setRunOffset,
    toggleRunVisible,
    renameRun,
    removeRun,
    setBlankRun,
    clearAll,
  } = store;

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId],
  );

  // --- Shared view state, hoisted so no tab switch can destroy it. ---
  const [xAxis, setXAxis] = useState<TgaXAxis>("temperature");
  const [yAxis, setYAxis] = useState<TgaYAxis>("weightPct");
  const [showDtg, setShowDtg] = useState(true);
  const [showMarkerLabels, setShowMarkerLabels] = useState(true);
  const [markers, setMarkers] = useState<TgaMarkerToggles>({
    onset: true,
    endset: false,
    td: true,
    tmax: true,
    residue: true,
    stepShade: false,
  });

  // Figure-tab-only state.
  const [figShowTga, setFigShowTga] = useState(true);
  const [figLabelMarkers, setFigLabelMarkers] = useState(true);
  const [figStackRuns, setFigStackRuns] = useState(false);

  // Compare-tab state.
  const metrics = useMemo(() => tgaMetrics(params.tdThresholds), [params.tdThresholds]);
  const [metricKey, setMetricKey] = useState<string>("td:5");
  const [grouping, setGrouping] = useState<CompareGrouping>("material");
  // A threshold edit can delete the focused metric's column; fall back rather
  // than leaving the chart pointing at a key nothing produces.
  const activeMetricKey = metrics.some((m) => m.key === metricKey)
    ? metricKey
    : (metrics[0]?.key ?? "");
  const activeMetric = metrics.find((m) => m.key === activeMetricKey);

  // The steps table follows the plot, so its badge counts what the plot shows.
  const visibleStepCount = useMemo(
    () => runs.reduce((n, r) => (r.visible ? n + r.analysis.steps.length : n), 0),
    [runs],
  );

  // --- Derived plot data ---
  const plotTraces = useMemo(
    () => buildTgaPlotTraces({ runs, xAxis, yAxis }),
    [runs, xAxis, yAxis],
  );
  const plotMarkers = useMemo(
    () => buildTgaPlotMarkers({ runs, xAxis, yAxis, markers }),
    [runs, xAxis, yAxis, markers],
  );

  // --- Derived figure data ---
  const figureRuns = useMemo(
    () => runs.map((r) => ({ id: r.id, label: r.label, color: r.color, visible: r.visible })),
    [runs],
  );
  const figureData = useMemo(
    () =>
      buildTgaFigureData({
        runs: figShowTga ? runs : [],
        xAxis,
        yAxis,
        showDtg,
        labelMarkers: figLabelMarkers,
        stackRuns: figStackRuns,
        markers,
        sourceName: selectedRun?.fileName.replace(/\.[^.]+$/, "") ?? undefined,
      }),
    [runs, figShowTga, xAxis, yAxis, showDtg, figLabelMarkers, figStackRuns, markers, selectedRun],
  );
  const [figureOptions, setFigureOptions] = useFigureOptions(figureData, TGA_FIGURE_SEED);

  // Restoring a `.tgaproj`: layer the saved options over freshly-seeded ones so
  // a project written by an older build still opens (same pattern as MALDI).
  const restoreFigureOptions = useCallback(
    (saved: FigureOptions | null) => {
      if (!saved) return;
      setFigureOptions(
        mergeSavedFigureOptions(defaultFigureOptions(figureData, TGA_FIGURE_SEED), saved),
      );
    },
    [figureData, setFigureOptions],
  );

  // Declared after `restoreFigureOptions` because the import path can open a
  // `.tgaproj`, which carries the figure styling with it.
  const { onFiles, busy, pending, confirmMapping, skipMapping } =
    useTgaImport(restoreFigureOptions);

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
      <FileSpreadsheet className="h-3 w-3" />
      Local TGA workspace
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
                      onToggleVisible={() => toggleRunVisible(r.id)}
                      onSetScale={(s) => setRunScale(r.id, s)}
                      onSetOffset={(o) => setRunOffset(r.id, o)}
                      onRemove={() => {
                        removeRun(r.id);
                        if (selectedRunId === r.id) setSelectedRunId(null);
                      }}
                    />
                  </div>
                ))}
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Analysis parameters" icon={Sliders} defaultOpen>
              <ParamControls params={params} onPatch={setParams} />
            </CollapsibleSection>

            <CollapsibleSection title="Materials" icon={Layers} count={materials.length}>
              <MaterialsPanel
                metric={activeMetric}
                selectedRunIds={selectedRun ? [selectedRun.id] : []}
                onSelectRun={setSelectedRunId}
              />
            </CollapsibleSection>

            <CollapsibleSection title="Blank subtraction" icon={Activity}>
              <div className="grid gap-2 text-xs">
                <p className="text-muted-foreground">
                  Designate one run as the blank for buoyancy correction. Its weight is
                  interpolated onto each sample's temperature grid and subtracted.
                </p>
                <select
                  value={blankRunId ?? ""}
                  onChange={(e) => setBlankRun(e.target.value || null)}
                  className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs"
                >
                  <option value="">(none)</option>
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
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
                  <div className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card p-4 shadow-card">
                    <MarkersPanel
                      xAxis={xAxis}
                      onXAxisChange={setXAxis}
                      yAxis={yAxis}
                      onYAxisChange={setYAxis}
                      showDtg={showDtg}
                      onShowDtgChange={setShowDtg}
                      showMarkerLabels={showMarkerLabels}
                      onShowMarkerLabelsChange={setShowMarkerLabels}
                      markers={markers}
                      onMarkersChange={setMarkers}
                    />
                    <TgaPlot
                      traces={plotTraces}
                      markers={plotMarkers}
                      xLabel={plotXLabel(xAxis)}
                      yLabel={plotYLabel(yAxis)}
                      y2Label={plotY2Label(params.dtgUnit)}
                      showDtg={showDtg}
                      showMarkerLabels={showMarkerLabels}
                      minHeight={420}
                    />
                  </div>
                  <CollapsibleSection title="Summary" icon={TrendingUp} defaultOpen>
                    <SummaryTable runs={runs} params={params} />
                  </CollapsibleSection>
                  <CollapsibleSection
                    title="Degradation steps"
                    icon={ListOrdered}
                    count={visibleStepCount}
                    defaultOpen
                  >
                    <StepTable runs={runs} selectedRunId={selectedRun?.id ?? null} />
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
                <TgaFigurePanel
                  runs={figureRuns}
                  xAxis={xAxis}
                  onXAxisChange={setXAxis}
                  yAxis={yAxis}
                  onYAxisChange={setYAxis}
                  showTga={figShowTga}
                  onShowTgaChange={setFigShowTga}
                  showDtg={showDtg}
                  onShowDtgChange={setShowDtg}
                  labelMarkers={figLabelMarkers}
                  onLabelMarkersChange={setFigLabelMarkers}
                  stackRuns={figStackRuns}
                  onStackRunsChange={setFigStackRuns}
                  markers={markers}
                  onMarkersChange={setMarkers}
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

const Tga = () => (
  <TgaProvider>
    <TgaWorkspace />
  </TgaProvider>
);

export default Tga;
