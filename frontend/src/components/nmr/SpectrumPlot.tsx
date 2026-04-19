import initNmriumCore from "@zakodium/nmrium-core-plugins";
import { Check, EyeOff, Layers3 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { buildNmriumViewerModel, getEngineColorMap } from "@/lib/nmr/nmrium";
import {
  deriveSignals,
  multiplicityLabel,
  signalSelectionAtomIndices,
  type DerivedSignal,
} from "@/lib/nmr/signals";
import type { Mode, Nucleus, Shift } from "@/types/nmr";
import {
  NmriumBareViewer,
  type HighlightBand,
  type SignalAnnotation,
} from "./NmriumBareViewer";

const HOVER_TOLERANCE_PPM: Record<string, number> = {
  "1H": 0.09,
  "13C": 1.1,
  "15N": 2.0,
  "19F": 1.2,
  "31P": 1.2,
};

const HIGHLIGHT_MIN_HALF_WIDTH_PPM: Record<string, number> = {
  "1H": 0.03,
  "13C": 0.45,
  "15N": 0.8,
  "19F": 0.45,
  "31P": 0.45,
};

interface SpectrumPlotProps {
  shifts: Shift[];
  nucleus: Nucleus;
  mode: Mode;
  selectedAtomIndex: number | null;
  activeSourceId?: string | null;
  activeSourceLabel?: string | null;
  linkingEnabled?: boolean;
  onAtomHover?: (atomIndices: number[] | null) => void;
}

function signalHighlightRange(signal: DerivedSignal, nucleus: Nucleus): [number, number] {
  const halfWidth = HIGHLIGHT_MIN_HALF_WIDTH_PPM[nucleus] ?? 0.5;
  if (signal.lines.length > 0) {
    const shifts = signal.lines.map((line) => line.shift);
    const lo = Math.min(...shifts);
    const hi = Math.max(...shifts);
    const pad = nucleus === "1H" ? 0.018 : halfWidth * 0.85;
    return [lo - pad, hi + pad];
  }
  return [signal.center - halfWidth, signal.center + halfWidth];
}

function signalHoverTolerance(signal: DerivedSignal, nucleus: Nucleus) {
  const [low, high] = signalHighlightRange(signal, nucleus);
  const span = Math.abs(high - low);
  const base = HOVER_TOLERANCE_PPM[nucleus] ?? 1;
  if (nucleus === "1H") {
    return Math.min(base, Math.max(0.03, span * 0.85));
  }
  return Math.min(base, Math.max(0.18, span * 1.2));
}

function signalHoverScore(signal: DerivedSignal, ppm: number, nucleus: Nucleus) {
  const [low, high] = signalHighlightRange(signal, nucleus);
  const lineDistance =
    signal.lines.length > 0
      ? Math.min(...signal.lines.map((line) => Math.abs(line.shift - ppm)))
      : Number.POSITIVE_INFINITY;
  const centerDistance = Math.abs(signal.center - ppm);
  const boundaryDistance = ppm < low ? low - ppm : ppm > high ? ppm - high : 0;
  return Math.min(lineDistance, centerDistance * 0.85) + boundaryDistance * 3;
}

function SummaryPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border/70 bg-background/90 px-2.5 py-1 text-[11px] font-medium text-foreground">
      {children}
    </span>
  );
}

function EngineChip({
  active,
  color,
  engine,
  onOnly,
  onToggle,
  protonCount,
  signalCount,
}: {
  active: boolean;
  color: string;
  engine: string;
  onOnly: () => void;
  onToggle: () => void;
  protonCount?: number;
  signalCount: number;
}) {
  return (
    <div
      className={`rounded-2xl border transition-smooth ${
        active
          ? "border-border/70 bg-background shadow-sm"
          : "border-border/50 bg-background/55 opacity-80"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-3 py-3 text-left"
      >
        <span
          className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{engine}</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                active
                  ? "bg-foreground text-background"
                  : "border border-border/70 bg-background text-muted-foreground"
              }`}
            >
              {active ? "On" : "Off"}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
            <span>{signalCount} peaks</span>
            {typeof protonCount === "number" ? <span>{protonCount}H total</span> : null}
          </div>
        </div>
      </button>

      <div className="flex items-center justify-between border-t border-border/60 px-3 py-2">
        <button
          type="button"
          onClick={onOnly}
          className="text-[11px] font-medium text-muted-foreground transition-smooth hover:text-foreground"
        >
          Only this
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="text-[11px] font-medium text-muted-foreground transition-smooth hover:text-foreground"
        >
          {active ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

export function SpectrumPlot({
  shifts,
  nucleus,
  mode,
  selectedAtomIndex,
  activeSourceId = null,
  activeSourceLabel = null,
  linkingEnabled = true,
  onAtomHover,
}: SpectrumPlotProps) {
  const core = useMemo(() => initNmriumCore(), []);
  const allSignals = useMemo(() => deriveSignals(shifts, nucleus, mode), [mode, nucleus, shifts]);
  const allSources = useMemo(
    () =>
      allSignals
        .map((signal) => signal.sourceId)
        .filter((sourceId): sourceId is string => Boolean(sourceId))
        .filter((sourceId, index, items) => items.indexOf(sourceId) === index),
    [allSignals],
  );

  const allEngines = useMemo(
    () =>
      allSignals
        .map((signal) => signal.engine)
        .filter((engine): engine is string => Boolean(engine))
        .filter((engine, index, items) => items.indexOf(engine) === index),
    [allSignals],
  );

  const engineColors = useMemo(() => getEngineColorMap(allEngines), [allEngines]);
  const [visibleEngines, setVisibleEngines] = useState<string[]>(allEngines);

  useEffect(() => {
    if (mode !== "individual") return;
    setVisibleEngines((current) => {
      const filtered = current.filter((engine) => allEngines.includes(engine));
      return filtered.length > 0 || current.length === 0 ? filtered.length > 0 ? filtered : allEngines : allEngines;
    });
  }, [allEngines, mode]);

  const visibleShifts = useMemo(() => {
    if (mode !== "individual") return shifts;
    if (visibleEngines.length === 0) return [];
    return shifts.filter((shift) => visibleEngines.includes(shift.engine ?? ""));
  }, [mode, shifts, visibleEngines]);

  const signals = useMemo(
    () => deriveSignals(visibleShifts, nucleus, mode),
    [mode, nucleus, visibleShifts],
  );
  const interactiveSignals = useMemo(() => {
    if (!linkingEnabled) return [];
    if (!activeSourceId) return signals;
    return signals.filter((signal) => signal.sourceId === activeSourceId);
  }, [activeSourceId, linkingEnabled, signals]);

  const viewerModel = useMemo(
    () => buildNmriumViewerModel(visibleShifts, nucleus, mode, core.version),
    [core.version, mode, nucleus, visibleShifts],
  );

  const protonIntegral = useMemo(
    () =>
      nucleus === "1H"
        ? signals.reduce((sum, signal) => sum + (signal.integration ?? 0), 0)
        : null,
    [nucleus, signals],
  );

  const [hoveredSignal, setHoveredSignal] = useState<DerivedSignal | null>(null);

  useEffect(() => {
    if (!hoveredSignal) return;
    if (interactiveSignals.some((signal) => signal.id === hoveredSignal.id)) return;
    setHoveredSignal(null);
    onAtomHover?.(null);
  }, [hoveredSignal, interactiveSignals, onAtomHover]);

  useEffect(() => {
    if (linkingEnabled) return;
    if (!hoveredSignal && selectedAtomIndex == null) return;
    setHoveredSignal(null);
    onAtomHover?.(null);
  }, [hoveredSignal, linkingEnabled, onAtomHover, selectedAtomIndex]);

  const selectedSignals = useMemo(
    () =>
      selectedAtomIndex == null
        ? []
        : interactiveSignals.filter((signal) =>
            signalSelectionAtomIndices(signal, nucleus).includes(selectedAtomIndex),
          ),
    [interactiveSignals, nucleus, selectedAtomIndex],
  );

  const activeSignals = hoveredSignal ? [hoveredSignal] : selectedSignals;
  const activeSignal = hoveredSignal ?? (selectedSignals.length === 1 ? selectedSignals[0] : null);

  const highlightBands = useMemo<HighlightBand[]>(
    () =>
      activeSignals.map((signal) => ({
        id: signal.id,
        range: signalHighlightRange(signal, nucleus),
        color: signal.engine ? engineColors[signal.engine] : undefined,
      })),
    [activeSignals, engineColors, nucleus],
  );

  const signalAnnotations = useMemo<SignalAnnotation[]>(
    () =>
      mode === "individual" && nucleus === "1H"
        ? signals
            .filter((signal) => typeof signal.integration === "number")
            .map((signal) => ({
              id: signal.id,
              ppm: signal.center,
              label: `${signal.integration}H`,
              color: signal.engine ? engineColors[signal.engine] ?? "#0ea5e9" : "#0ea5e9",
            }))
        : [],
    [engineColors, mode, nucleus, signals],
  );

  const handleHoverPpm = useCallback(
    (ppm: number | null) => {
      if (ppm == null || interactiveSignals.length === 0) {
        if (hoveredSignal) {
          setHoveredSignal(null);
          onAtomHover?.(null);
        }
        return;
      }

      let nearest: DerivedSignal | null = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const signal of interactiveSignals) {
        const score = signalHoverScore(signal, ppm, nucleus);
        if (score < bestScore) {
          bestScore = score;
          nearest = signal;
        }
      }

      if (!nearest || bestScore > signalHoverTolerance(nearest, nucleus)) {
        if (hoveredSignal) {
          setHoveredSignal(null);
          onAtomHover?.(null);
        }
        return;
      }

      if (hoveredSignal?.id !== nearest.id) {
        setHoveredSignal(nearest);
        onAtomHover?.(signalSelectionAtomIndices(nearest, nucleus));
      }
    },
    [hoveredSignal, interactiveSignals, nucleus, onAtomHover],
  );

  const toggleVisibleEngine = useCallback((engine: string) => {
    setVisibleEngines((current) =>
      current.includes(engine)
        ? current.filter((item) => item !== engine)
        : [...current, engine],
    );
  }, []);

  const onlyVisibleEngine = useCallback((engine: string) => {
    setVisibleEngines([engine]);
  }, []);

  const showAllEngines = useCallback(() => {
    setVisibleEngines(allEngines);
  }, [allEngines]);

  const clearVisibleEngines = useCallback(() => {
    setVisibleEngines([]);
    setHoveredSignal(null);
    onAtomHover?.(null);
  }, [onAtomHover]);

  const selectedEngineNames = useMemo(
    () =>
      [...new Set(selectedSignals.map((signal) => signal.engine).filter(Boolean))] as string[],
    [selectedSignals],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SummaryPill>{nucleus}</SummaryPill>
          <SummaryPill>{mode === "consensus" ? "Consensus view" : "Per-engine overlay"}</SummaryPill>
          <SummaryPill>
            {signals.length} peak{signals.length === 1 ? "" : "s"}
          </SummaryPill>
          {protonIntegral != null ? <SummaryPill>{protonIntegral}H total</SummaryPill> : null}
          {allSources.length > 1 && activeSourceLabel ? (
            <SummaryPill>{activeSourceLabel} active</SummaryPill>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {linkingEnabled
            ? allSources.length > 1 && activeSourceLabel
              ? `Hover peaks to highlight atoms for ${activeSourceLabel}. Engine filtering on the right also scopes the atom sync.`
              : "Hover peaks to highlight atoms. Engine filtering on the right limits both the graph and the atom sync."
            : "The editor currently holds an unsaved structure, so atom highlighting is paused until you select a predicted component or run a new prediction."}
        </p>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border/60 bg-white shadow-card">
        <div
          className={`grid min-h-[580px] ${
            mode === "individual" && allEngines.length > 0
              ? "grid-cols-1 xl:grid-cols-[minmax(0,1fr)_240px]"
              : "grid-cols-1"
          }`}
        >
          <div className="flex min-h-[580px] min-w-0 flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-4 py-3 text-[11px] text-muted-foreground">
              <span>Drag to zoom, scroll to rescale, double-click to reset. Narrow peak matching is active.</span>
              {!linkingEnabled && allSources.length > 1 ? (
                <span className="rounded-full bg-muted px-2 py-1 font-medium text-muted-foreground">
                  Atom linking paused for draft molecule
                </span>
              ) : null}
              {linkingEnabled && selectedAtomIndex != null ? (
                <span className="rounded-full bg-accent/10 px-2 py-1 font-medium text-accent">
                  Atom #{selectedAtomIndex} linked to {selectedSignals.length || 0} visible peak
                  {selectedSignals.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>

            <div className="relative min-h-0 flex-1 bg-white">
              <div className="relative h-full min-h-[530px] w-full bg-white">
                <NmriumBareViewer
                  aggregator={viewerModel.aggregator}
                  core={core}
                  state={viewerModel.state}
                  onHoverPpm={handleHoverPpm}
                  highlightBands={highlightBands}
                  signalAnnotations={signalAnnotations}
                  emptyText={
                    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
                      {mode === "individual" && visibleEngines.length === 0
                        ? "Enable at least one engine in the spectrum rail to render the graph."
                        : "No predicted signals were returned for this request."}
                    </div>
                  }
                />

                {activeSignal ? (
                  <div className="pointer-events-none absolute left-3 top-3 z-20 max-w-[280px] rounded-xl border border-border/70 bg-background/95 px-3 py-2 text-xs shadow-card backdrop-blur">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        {activeSignal.center.toFixed(nucleus === "1H" ? 2 : 1)} ppm
                      </span>
                      {allSources.length > 1 && activeSignal.sourceLabel ? (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
                          {activeSignal.sourceLabel}
                        </span>
                      ) : null}
                      {activeSignal.engine ? (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                          style={{
                            color: activeSignal.engine ? engineColors[activeSignal.engine] : "#0ea5e9",
                            backgroundColor: "rgba(255,255,255,0.85)",
                          }}
                        >
                          {activeSignal.engine}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-muted-foreground">{activeSignal.assignmentText}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {activeSignal.integration != null ? (
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {activeSignal.integration}H
                        </span>
                      ) : null}
                      {multiplicityLabel(activeSignal.multiplicity) ? (
                        <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                          {multiplicityLabel(activeSignal.multiplicity)}
                        </span>
                      ) : null}
                      {activeSignal.couplingHz != null ? (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          J {activeSignal.couplingHz.toFixed(1)} Hz
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {!hoveredSignal && selectedSignals.length > 1 ? (
                  <div className="pointer-events-none absolute left-3 top-3 z-20 max-w-[300px] rounded-xl border border-border/70 bg-background/95 px-3 py-2 text-xs shadow-card backdrop-blur">
                    <div className="text-sm font-semibold text-foreground">
                      {selectedSignals.length} linked peaks
                    </div>
                    <div className="mt-0.5 text-muted-foreground">
                      Visible engine matches for atom #{selectedAtomIndex}
                      {allSources.length > 1 && activeSourceLabel ? ` in ${activeSourceLabel}` : ""}
                    </div>
                    {selectedEngineNames.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {selectedEngineNames.map((engine) => (
                          <span
                            key={engine}
                            className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                            style={{
                              color: engineColors[engine] ?? "#0ea5e9",
                              backgroundColor: "rgba(255,255,255,0.85)",
                            }}
                          >
                            {engine}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {mode === "individual" && allEngines.length > 0 ? (
            <aside className="border-t border-border/60 bg-muted/15 xl:border-l xl:border-t-0">
              <div className="flex h-full flex-col">
                <div className="border-b border-border/60 px-4 py-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Layers3 className="h-4 w-4 text-primary" />
                    Engine spectra
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Toggle overlays here. Peak hover, peak highlight, and atom sync only use the engines that stay enabled.
                  </p>

                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={showAllEngines}
                      className="rounded-full border border-border/70 bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-smooth hover:bg-muted"
                    >
                      Show all
                    </button>
                    <button
                      type="button"
                      onClick={clearVisibleEngines}
                      className="rounded-full border border-border/70 bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-smooth hover:bg-muted hover:text-foreground"
                    >
                      <span className="inline-flex items-center gap-1">
                        <EyeOff className="h-3 w-3" />
                        Hide all
                      </span>
                    </button>
                  </div>
                </div>

                <div className="flex-1 space-y-3 overflow-y-auto p-3">
                  {allEngines.map((engine) => {
                    const engineSignals = allSignals.filter((signal) => signal.engine === engine);
                    const protonCount =
                      nucleus === "1H"
                        ? engineSignals.reduce((sum, signal) => sum + (signal.integration ?? 0), 0)
                        : undefined;

                    return (
                      <EngineChip
                        key={engine}
                        active={visibleEngines.includes(engine)}
                        color={engineColors[engine] ?? "#0ea5e9"}
                        engine={engine}
                        signalCount={engineSignals.length}
                        protonCount={protonCount}
                        onOnly={() => onlyVisibleEngine(engine)}
                        onToggle={() => toggleVisibleEngine(engine)}
                      />
                    );
                  })}
                </div>

                <div className="border-t border-border/60 px-4 py-3 text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <Check className="h-3 w-3 text-primary" />
                    {visibleEngines.length} of {allEngines.length} engine
                    {allEngines.length === 1 ? "" : "s"} visible
                  </div>
                </div>
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}
