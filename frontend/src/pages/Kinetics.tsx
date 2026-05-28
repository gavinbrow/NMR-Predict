import initNmriumCore from "@zakodium/nmrium-core-plugins";
import { FileUp, HardDrive } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { NMRium } from "nmrium";
import type { NMRiumChangeCb } from "nmrium";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { KineticsChart } from "@/components/nmr/KineticsChart";
import { KineticsPanel } from "@/components/nmr/KineticsPanel";
import { OrderTestChart } from "@/components/nmr/OrderTestChart";
import {
  buildSeries,
  extractAnalysisColumns,
  extractKineticSpectra,
  fitModel,
  type AnalysisColumn,
  type FitResult,
  type KineticModelKind,
  type KineticSpectrum,
  type LinearOrder,
  type NmriumStateLike,
  type PeakRole,
  type SeriesPoint,
  type TimeUnit,
  type Timepoint,
  type TrackedPeak,
} from "@/lib/nmr/kinetics";
import { exportKineticsExcel, exportKineticsPdf } from "@/lib/nmr/kineticsExport";

// Stable palette for tracked-peak colors (assigned at creation by index).
const PEAK_PALETTE = [
  "#0ea5e9",
  "#f97316",
  "#10b981",
  "#a855f7",
  "#ef4444",
  "#f59e0b",
  "#14b8a6",
  "#ec4899",
];

const roleOf = (peak: TrackedPeak): PeakRole => peak.role ?? "reactant";

const Kinetics = () => {
  const core = useMemo(() => initNmriumCore(), []);

  const [spectra, setSpectra] = useState<KineticSpectrum[]>([]);
  const [analysisColumns, setAnalysisColumns] = useState<AnalysisColumn[]>([]);
  const [timepoints, setTimepoints] = useState<Record<string, Timepoint | undefined>>({});
  const [trackedPeaks, setTrackedPeaks] = useState<TrackedPeak[]>([]);
  const [model, setModel] = useState<KineticModelKind>("first");
  const [displayUnit, setDisplayUnit] = useState<TimeUnit>("min");
  const [showConnectingLine, setShowConnectingLine] = useState(true);
  const [showFitLine, setShowFitLine] = useState(true);
  const [orderTestOrder, setOrderTestOrder] = useState<LinearOrder>("first");
  const [exporting, setExporting] = useState(false);

  const kineticsChartRef = useRef<HTMLDivElement>(null);
  const orderChartRef = useRef<HTMLDivElement>(null);

  // Re-read on every change (data, view, and settings). The "1D multiple spectra
  // analysis" panel writes to settings, and a fresh drag-drop sometimes only
  // surfaces through a view event — so we never gate on `source` here.
  const handleNmriumChange = useCallback<NMRiumChangeCb>((state) => {
    // NMRium's concrete NmriumState is bridged to our deliberately-loose
    // extraction interface; the cast is the single boundary between the two.
    const loose = state as unknown as NmriumStateLike;
    setSpectra(extractKineticSpectra(loose));
    setAnalysisColumns(extractAnalysisColumns(loose));
  }, []);

  const handleTimepointChange = useCallback((id: string, timepoint: Timepoint | undefined) => {
    setTimepoints((prev) => ({ ...prev, [id]: timepoint }));
  }, []);

  const handleAddPeak = useCallback(
    (peak: { label: string; from: number; to: number; role: PeakRole }) => {
      setTrackedPeaks((prev) => {
        const id = `peak-${Date.now()}-${prev.length}`;
        const color = PEAK_PALETTE[prev.length % PEAK_PALETTE.length];
        const next = [...prev, { id, color, ...peak }];
        // Only one standard at a time: demote any prior standard.
        if (peak.role === "standard") {
          return next.map((p) =>
            p.id !== id && roleOf(p) === "standard" ? { ...p, role: "reactant" as PeakRole } : p,
          );
        }
        return next;
      });
    },
    [],
  );

  const handleRemovePeak = useCallback((id: string) => {
    setTrackedPeaks((prev) => prev.filter((peak) => peak.id !== id));
  }, []);

  const handlePeakRoleChange = useCallback((id: string, role: PeakRole) => {
    setTrackedPeaks((prev) =>
      prev.map((peak) => {
        if (peak.id === id) return { ...peak, role };
        // Setting one peak as standard demotes any other standard.
        if (role === "standard" && roleOf(peak) === "standard") {
          return { ...peak, role: "reactant" as PeakRole };
        }
        return peak;
      }),
    );
  }, []);

  // Turn the "1D multiple spectra analysis" columns into tracked peaks, skipping
  // any whose ppm window already matches an existing tracked peak.
  const handleImportAnalysisColumns = useCallback(() => {
    setTrackedPeaks((prev) => {
      const existing = new Set(prev.map((p) => `${p.from.toFixed(3)}:${p.to.toFixed(3)}`));
      const additions: TrackedPeak[] = [];
      analysisColumns.forEach((col, index) => {
        const key = `${col.from.toFixed(3)}:${col.to.toFixed(3)}`;
        if (existing.has(key)) return;
        existing.add(key);
        const position = prev.length + additions.length;
        additions.push({
          id: `peak-${Date.now()}-${index}-${position}`,
          color: PEAK_PALETTE[position % PEAK_PALETTE.length],
          label: col.label,
          from: col.from,
          to: col.to,
          role: "reactant",
        });
      });
      return [...prev, ...additions];
    });
  }, [analysisColumns]);

  const standardPeak = useMemo(
    () => trackedPeaks.find((peak) => roleOf(peak) === "standard") ?? null,
    [trackedPeaks],
  );

  const seriesByPeak = useMemo<Record<string, SeriesPoint[]>>(() => {
    const result: Record<string, SeriesPoint[]> = {};
    for (const peak of trackedPeaks) {
      result[peak.id] = buildSeries(spectra, timepoints, peak, standardPeak);
    }
    return result;
  }, [trackedPeaks, spectra, timepoints, standardPeak]);

  const fitByPeak = useMemo<Record<string, FitResult | null>>(() => {
    const result: Record<string, FitResult | null> = {};
    for (const peak of trackedPeaks) {
      if (roleOf(peak) === "standard") {
        result[peak.id] = null;
        continue;
      }
      const series = seriesByPeak[peak.id] ?? [];
      result[peak.id] = series.length >= 2 ? fitModel(series, model) : null;
    }
    return result;
  }, [trackedPeaks, seriesByPeak, model]);

  const runExport = useCallback(
    async (kind: "pdf" | "excel") => {
      setExporting(true);
      try {
        const payload = {
          displayUnit,
          model,
          peaks: trackedPeaks,
          seriesByPeak,
          fitByPeak,
          kineticsChartEl: kineticsChartRef.current,
          orderChartEl: orderChartRef.current,
        };
        if (kind === "pdf") {
          await exportKineticsPdf(payload);
          toast.success("Exported PDF report");
        } else {
          await exportKineticsExcel(payload);
          toast.success("Exported Excel workbook");
        }
      } catch (error) {
        console.error("Kinetics export failed", error);
        toast.error("Export failed — see console for details");
      } finally {
        setExporting(false);
      }
    },
    [displayUnit, model, trackedPeaks, seriesByPeak, fitByPeak],
  );

  return (
    <AppShell
      headerAccessory={
        <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 font-medium text-success">
          <HardDrive className="h-3 w-3" />
          Local kinetics workspace
        </span>
      }
      mainClassName="px-4 py-5 sm:px-6"
    >
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <section className="rounded-3xl border border-border/70 bg-card p-5 shadow-card">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">
            NMR Kinetics
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
            Reaction kinetics from a spectrum series
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Drop a series of time-resolved NMR files into the viewer, baseline and integrate the
            peaks you care about (use the stacked view to compare them), then assign each spectrum a
            time. Tracked-peak integrals are plotted against time and fit to a kinetic model — all
            locally in your browser.
          </p>
        </section>

        <section className="h-[70vh] min-h-[560px] overflow-hidden rounded-3xl border border-border/70 bg-white shadow-card">
          <NMRium
            core={core}
            onChange={handleNmriumChange}
            emptyText={
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                  <FileUp className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Drop your time-series spectra here.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Multiple files load together; switch to stacked alignment to compare peaks
                    over time.
                  </p>
                </div>
              </div>
            }
          />
        </section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="overflow-y-auto rounded-3xl border border-border/70 bg-card p-4 shadow-card">
            <KineticsPanel
              spectra={spectra}
              analysisColumns={analysisColumns}
              onImportAnalysisColumns={handleImportAnalysisColumns}
              timepoints={timepoints}
              onTimepointChange={handleTimepointChange}
              trackedPeaks={trackedPeaks}
              onAddPeak={handleAddPeak}
              onRemovePeak={handleRemovePeak}
              onPeakRoleChange={handlePeakRoleChange}
              model={model}
              onModelChange={setModel}
              displayUnit={displayUnit}
              onDisplayUnitChange={setDisplayUnit}
              fitByPeak={fitByPeak}
              showConnectingLine={showConnectingLine}
              onShowConnectingLineChange={setShowConnectingLine}
              showFitLine={showFitLine}
              onShowFitLineChange={setShowFitLine}
              onExportPdf={() => runExport("pdf")}
              onExportExcel={() => runExport("excel")}
              exporting={exporting}
            />
          </section>

          <section className="rounded-3xl border border-border/70 bg-card p-5 shadow-card">
            <h2 className="text-sm font-semibold text-foreground">Kinetics</h2>
            <div ref={kineticsChartRef} className="mt-2 h-[440px]">
              <KineticsChart
                peaks={trackedPeaks}
                seriesByPeak={seriesByPeak}
                fitByPeak={fitByPeak}
                displayUnit={displayUnit}
                normalized={standardPeak != null}
                showConnectingLine={showConnectingLine}
                showFitLine={showFitLine}
              />
            </div>
          </section>
        </div>

        <section className="rounded-3xl border border-border/70 bg-card p-5 shadow-card">
          <h2 className="text-sm font-semibold text-foreground">Reaction-order test</h2>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            Plot the linearized concentration term against time. The order whose transform is the
            straightest line (highest R²) is the apparent reaction order.
          </p>
          <div ref={orderChartRef} className="mt-3 h-[420px]">
            <OrderTestChart
              peaks={trackedPeaks}
              seriesByPeak={seriesByPeak}
              order={orderTestOrder}
              onOrderChange={setOrderTestOrder}
              displayUnit={displayUnit}
            />
          </div>
        </section>
      </div>
    </AppShell>
  );
};

export default Kinetics;
