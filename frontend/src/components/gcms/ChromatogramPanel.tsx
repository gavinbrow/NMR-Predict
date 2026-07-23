import { useCallback, useMemo } from "react";
import type { MutableRefObject } from "react";
import type { LabelInput } from "@/lib/gcms/annotate";
import type { ChromPeak, ChromTrace } from "@/lib/gcms/types";
import { GcmsPlot, type PanelTrace, type PlotMarker } from "./GcmsPlot";

/** Resolve the app's --primary design token for fallback marker colours. */
function primaryToken(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  if (!raw) return "hsl(190 90% 38%)";
  return raw.startsWith("hsl") ? raw : `hsl(${raw})`;
}

export interface ChromatogramPanelProps {
  traces: ChromTrace[];
  peaks: ChromPeak[];
  cursorRt: number | null;
  selections: [number, number][];
  /** Parallel to `selections` — see the identical doc on `GcmsPlotProps`. */
  selectionColors?: string[];
  background: [number, number] | null;
  activeTraceId: string | null;
  title: string;
  normalize: boolean;
  stacked: boolean;
  logY: boolean;
  dragMode?: "auto" | "zoom" | "select" | "background";
  captureRef?: MutableRefObject<((scale?: number) => string | null) | null>;
  onHoverRt(rt: number | null): void;
  onPinRt(rt: number): void;
  onSelectRange(
    lo: number,
    hi: number,
    mode: "zoom" | "select" | "background",
    additive: boolean,
  ): void;
  /** Click-to-pick a trace (Phase 3 task C) — forwarded straight to GcmsPlot. */
  onPickTrace?(id: string): void;
  /** Shift+wheel per-trace gain (Phase 3 task D) — forwarded straight to GcmsPlot. */
  onScaleTrace?(id: string, factor: number): void;
}

/**
 * Thin adapter that maps {@link ChromTrace}s to {@link PanelTrace}s and
 * {@link ChromPeak}s to integration markers + RT labels, then renders a single
 * {@link GcmsPlot} in line mode. All rendering and interaction logic lives in
 * `GcmsPlot`; this file only does the data-shape translation.
 */
export function ChromatogramPanel(props: ChromatogramPanelProps): JSX.Element {
  const {
    traces,
    peaks,
    cursorRt,
    selections,
    selectionColors,
    background,
    activeTraceId,
    title,
    normalize,
    stacked,
    logY,
    dragMode,
    captureRef,
    onHoverRt,
    onPinRt,
    onSelectRange,
    onPickTrace,
    onScaleTrace,
  } = props;

  // Map ChromTrace[] -> PanelTrace[].
  const panelTraces = useMemo<PanelTrace[]>(
    () =>
      traces.map((t) => ({
        id: t.id,
        label: t.label,
        x: t.rtMin,
        y: t.intensity,
        color: t.color,
        visible: t.visible,
        offset: t.offset,
        scale: t.scale,
        width: 1,
      })),
    [traces],
  );

  // Index the active trace's (rt, intensity) once so we can read the apex y
  // for peak markers/annotations without a binary search per peak per render.
  const activeTrace = useMemo(
    () => traces.find((t) => t.id === activeTraceId) ?? traces[0] ?? null,
    [traces, activeTraceId],
  );

  // Look up the intensity at a given rt by binary search on the active trace.
  const intensityAt = useCallback(
    (rt: number): number => {
      if (!activeTrace || activeTrace.rtMin.length === 0) return 0;
      const x = activeTrace.rtMin;
      const y = activeTrace.intensity;
      let lo = 0;
      let hi = x.length - 1;
      if (rt <= x[0]) return y[0];
      if (rt >= x[hi]) return y[hi];
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (x[mid] < rt) lo = mid + 1;
        else hi = mid;
      }
      // Pick the closer of the two bracketing samples.
      if (lo > 0 && Math.abs(x[lo - 1] - rt) < Math.abs(x[lo] - rt)) lo -= 1;
      return y[lo];
    },
    [activeTrace],
  );

  // Turn peaks into apex / start / end markers and RT annotations.
  const markers = useMemo<PlotMarker[]>(() => {
    const out: PlotMarker[] = [];
    for (const p of peaks) {
      const color = activeTrace?.color ?? primaryToken();
      const apexY = p.height > 0 ? p.height : intensityAt(p.rtApex);
      out.push({ x: p.rtApex, y: apexY, kind: "apex", color });
      out.push({ x: p.rtStart, y: 0, kind: "start", color });
      out.push({ x: p.rtEnd, y: 0, kind: "end", color });
    }
    return out;
  }, [peaks, activeTrace, intensityAt]);

  const annotations = useMemo<LabelInput[]>(() => {
    return peaks.map((p) => ({
      x: p.rtApex,
      y: p.height > 0 ? p.height : intensityAt(p.rtApex),
      lines: [p.rtApex.toFixed(3)],
      priority: p.height,
      color: p.name ? activeTrace?.color : undefined,
    }));
  }, [peaks, activeTrace, intensityAt]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <GcmsPlot
        axis="rt"
        drawMode="line"
        xLabel="Retention time (min)"
        title={title}
        traces={panelTraces}
        activeTraceId={activeTraceId}
        annotations={annotations}
        markers={markers}
        labelFloorFrac={0.02}
        cursorX={cursorRt}
        selections={selections}
        selectionColors={selectionColors}
        background={background}
        normalize={normalize}
        stacked={stacked}
        logY={logY}
        dragMode={dragMode}
        captureRef={captureRef}
        onHover={(rt, _idx) => onHoverRt(rt)}
        onClick={(rt, _mods) => onPinRt(rt)}
        onSelectRange={onSelectRange}
        onPickTrace={onPickTrace}
        onScaleTrace={onScaleTrace}
      />
    </div>
  );
}