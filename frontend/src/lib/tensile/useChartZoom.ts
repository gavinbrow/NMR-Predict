// Drag-to-zoom for recharts charts (shared across the tensile views).
//
// recharts has no built-in zoom, so this hook implements the common pattern:
// while the pointer is dragged across the plot we track an x-range, and on
// release we pin the XAxis to that range and auto-fit the YAxis to the data that
// falls inside it. A reset (button or double-click) clears the zoom and the axes
// snap back to their default auto-scaled domains. The hook is presentational —
// it owns only the zoom state and the event handlers; each chart wires the
// returned `domain`/`refArea` onto its axes and an optional drag rectangle.

import { useCallback, useMemo, useRef, useState } from "react";

/** A single plotted point, used to auto-fit the Y axis to a zoomed X window. */
export interface ChartPoint {
  x: number;
  y: number;
}

/** A pinned [min, max] domain for both axes. */
export interface ZoomDomain {
  x: [number, number];
  y: [number, number];
}

/** The minimal recharts mouse-event shape we rely on. */
interface ChartMouseState {
  activeLabel?: number | string;
}

export interface ChartZoom {
  /** The pinned domain while zoomed, or `null` when auto-scaled. */
  domain: ZoomDomain | null;
  /** The in-progress drag rectangle (x only); `null` when not dragging. */
  refArea: { x1: number; x2: number } | null;
  isZoomed: boolean;
  /** Spread onto the recharts chart element. */
  onMouseDown: (e: ChartMouseState | null) => void;
  onMouseMove: (e: ChartMouseState | null) => void;
  onMouseUp: () => void;
  /** Cancel an in-progress drag (wire to the chart's onMouseLeave). */
  onMouseLeave: () => void;
  /** Pin the X axis to [a, b] (order-independent); Y auto-fits to the data. */
  zoomToX: (a: number, b: number) => void;
  reset: () => void;
}

const EPS = 1e-9;

// A committed drag must span at least this fraction of the currently-visible
// x-range to actually zoom. It filters out plain clicks and the tiny pointer
// jitter during a double-click — both of which would otherwise re-zoom by a
// sliver and make the chart feel impossible to zoom back out of.
const MIN_DRAG_FRACTION = 0.02;

/**
 * @param points Every plotted point across the visible series, used to auto-fit
 *   the Y axis when the user zooms into an X window. Pass a stable, memoized
 *   array (it is only read on commit, but is a dependency of `zoomToX`).
 */
export function useChartZoom(points: ChartPoint[]): ChartZoom {
  const [domain, setDomain] = useState<ZoomDomain | null>(null);
  const [sel, setSel] = useState<{ x1: number; x2: number } | null>(null);
  const dragging = useRef(false);

  // Full x-extent of the data, used to size the minimum-drag threshold when not
  // yet zoomed.
  const xExtent = useMemo<[number, number] | null>(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      if (Number.isFinite(p.x)) {
        if (p.x < lo) lo = p.x;
        if (p.x > hi) hi = p.x;
      }
    }
    return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
  }, [points]);

  const fitY = useCallback(
    (a: number, b: number): [number, number] => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      let yMin = Infinity;
      let yMax = -Infinity;
      for (const p of points) {
        if (p.x >= lo && p.x <= hi && Number.isFinite(p.y)) {
          if (p.y < yMin) yMin = p.y;
          if (p.y > yMax) yMax = p.y;
        }
      }
      if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return [0, 1];
      if (yMax - yMin < EPS) return [yMin - 1, yMax + 1];
      const pad = (yMax - yMin) * 0.05;
      return [yMin - pad, yMax + pad];
    },
    [points],
  );

  const zoomToX = useCallback(
    (a: number, b: number) => {
      if (Math.abs(a - b) < EPS) return;
      setDomain({ x: [Math.min(a, b), Math.max(a, b)], y: fitY(a, b) });
    },
    [fitY],
  );

  // Commit a finished drag only if it spans a meaningful slice of what's visible.
  const commitDrag = useCallback(
    (s: { x1: number; x2: number }) => {
      const span = Math.abs(s.x1 - s.x2);
      const visible = domain
        ? domain.x[1] - domain.x[0]
        : xExtent
          ? xExtent[1] - xExtent[0]
          : 0;
      const minSpan = visible > 0 ? visible * MIN_DRAG_FRACTION : EPS;
      if (span > minSpan) zoomToX(s.x1, s.x2);
    },
    [domain, xExtent, zoomToX],
  );

  const onMouseDown = useCallback((e: ChartMouseState | null) => {
    if (e?.activeLabel == null) return;
    const x = Number(e.activeLabel);
    if (!Number.isFinite(x)) return;
    dragging.current = true;
    setSel({ x1: x, x2: x });
  }, []);

  const onMouseMove = useCallback((e: ChartMouseState | null) => {
    if (!dragging.current || e?.activeLabel == null) return;
    const x = Number(e.activeLabel);
    if (!Number.isFinite(x)) return;
    setSel((s) => (s ? { ...s, x2: x } : null));
  }, []);

  const onMouseUp = useCallback(() => {
    dragging.current = false;
    setSel((s) => {
      if (s) commitDrag(s);
      return null;
    });
  }, [commitDrag]);

  // Pointer left the plot mid-drag: drop the selection so it can't get "stuck"
  // with a phantom rectangle or a half-finished drag blocking the next action.
  const onMouseLeave = useCallback(() => {
    dragging.current = false;
    setSel(null);
  }, []);

  const reset = useCallback(() => {
    dragging.current = false;
    setSel(null);
    setDomain(null);
  }, []);

  return useMemo(
    () => ({
      domain,
      refArea: sel,
      isZoomed: domain != null,
      onMouseDown,
      onMouseMove,
      onMouseUp,
      onMouseLeave,
      zoomToX,
      reset,
    }),
    [domain, sel, onMouseDown, onMouseMove, onMouseUp, onMouseLeave, zoomToX, reset],
  );
}
