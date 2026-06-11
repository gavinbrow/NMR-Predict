import { RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { autoRange, decimateMinMax, seriesPathD } from "@/lib/ir/figure";
import type { BaselinePoint, Spectrum } from "@/lib/ir/types";

interface ManualBaselineEditorProps {
  /** The currently displayed spectra, drawn faintly for context. */
  spectra: Spectrum[];
  /** Shared wavenumber grid (ascending) — fixes the x-extent. */
  grid: number[];
  anchors: BaselinePoint[];
  onChange: (next: BaselinePoint[]) => void;
  /** Match the IR convention (high cm⁻¹ on the left). */
  reversedX?: boolean;
}

// Fixed viewBox; the SVG scales to its container via `w-full h-auto`.
const VB_W = 760;
const VB_H = 300;
const M = { left: 52, right: 14, top: 14, bottom: 30 };
const HIT_R = 9;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * A hand-drawn baseline editor for the "Manual (draw)" method. The user clicks
 * to drop anchor points and drags them to trace a baseline in absorbance space;
 * the resulting polyline (flat outside the anchor span, matching the math in
 * `baseline.ts`) is subtracted from every spectrum. Drags are kept local for
 * responsiveness and committed to the parent on release.
 */
export function ManualBaselineEditor({
  spectra,
  grid,
  anchors,
  onChange,
  reversedX = true,
}: ManualBaselineEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  // Live copy so dragging doesn't churn the (heavier) parent recompute per move.
  const [local, setLocal] = useState(anchors);
  if (dragIdx === null && local !== anchors) setLocal(anchors);

  const plotW = VB_W - M.left - M.right;
  const plotH = VB_H - M.top - M.bottom;

  // x-extent from the grid; y-extent from the spectra and the current anchors.
  const { xLo, xHi, yLo, yHi, contextPaths } = useMemo(() => {
    const xl = grid.length ? grid[0] : 0;
    const xh = grid.length ? grid[grid.length - 1] : 1;
    const allY: number[] = [];
    const paths: string[] = [];
    // Provisional scales for the context curves (y filled in after the range).
    for (const s of spectra) for (const a of s.absorbance) if (Number.isFinite(a)) allY.push(a);
    for (const p of local) allY.push(p.y);
    let [yl, yh] = autoRange(allY);
    if (yl === yh) {
      yl -= 1;
      yh += 1;
    }
    const pad = (yh - yl) * 0.08;
    yl -= pad;
    yh += pad;

    const sxc = (x: number) =>
      M.left + ((reversedX ? xh - x : x - xl) / (xh - xl || 1)) * plotW;
    const syc = (a: number) => M.top + ((yh - a) / (yh - yl || 1)) * plotH;
    for (const s of spectra) {
      const dec = decimateMinMax(s.wavenumber, s.absorbance, 500);
      paths.push(seriesPathD(dec.x, dec.y, sxc, syc));
    }
    return { xLo: xl, xHi: xh, yLo: yl, yHi: yh, contextPaths: paths };
  }, [spectra, grid, local, reversedX, plotW, plotH]);

  const sx = (x: number) => M.left + ((reversedX ? xHi - x : x - xLo) / (xHi - xLo || 1)) * plotW;
  const sy = (a: number) => M.top + ((yHi - a) / (yHi - yLo || 1)) * plotH;
  const ix = (vx: number) => {
    const frac = (vx - M.left) / plotW;
    return reversedX ? xHi - frac * (xHi - xLo) : xLo + frac * (xHi - xLo);
  };
  const iy = (vy: number) => yHi - ((vy - M.top) / plotH) * (yHi - yLo);

  const toVB = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return { vx: 0, vy: 0 };
    const r = svg.getBoundingClientRect();
    return {
      vx: r.width ? ((e.clientX - r.left) / r.width) * VB_W : 0,
      vy: r.height ? ((e.clientY - r.top) / r.height) * VB_H : 0,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { vx, vy } = toVB(e);
    const hit = local.findIndex((p) => Math.hypot(sx(p.x) - vx, sy(p.y) - vy) <= HIT_R);
    if (hit >= 0) {
      svgRef.current?.setPointerCapture(e.pointerId);
      setDragIdx(hit);
      e.preventDefault();
      return;
    }
    // Add a point only when the click lands inside the plot area.
    if (vx < M.left || vx > M.left + plotW || vy < M.top || vy > M.top + plotH) return;
    const next = [...local, { x: clamp(ix(vx), xLo, xHi), y: clamp(iy(vy), yLo, yHi) }];
    setLocal(next);
    svgRef.current?.setPointerCapture(e.pointerId);
    setDragIdx(next.length - 1);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragIdx === null) return;
    const { vx, vy } = toVB(e);
    const nx = clamp(ix(clamp(vx, M.left, M.left + plotW)), xLo, xHi);
    const ny = clamp(iy(clamp(vy, M.top, M.top + plotH)), yLo, yHi);
    setLocal((prev) => prev.map((p, i) => (i === dragIdx ? { x: nx, y: ny } : p)));
  };

  const endDrag = (e: React.PointerEvent) => {
    if (dragIdx === null) return;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    setDragIdx(null);
    onChange(local);
  };

  const removeAt = (i: number) => onChange(anchors.filter((_, j) => j !== i));
  const clear = () => onChange([]);
  const reset = () => {
    if (grid.length < 2) return;
    let lo = Infinity;
    for (const s of spectra) for (const a of s.absorbance) if (Number.isFinite(a) && a < lo) lo = a;
    if (!Number.isFinite(lo)) lo = 0;
    onChange([
      { x: grid[0], y: lo },
      { x: grid[grid.length - 1], y: lo },
    ]);
  };

  // The baseline polyline: sorted anchors, held flat beyond the end anchors.
  const sorted = [...local].sort((a, b) => a.x - b.x);
  const baselineD = (() => {
    if (sorted.length === 0) return "";
    const pts: [number, number][] = [];
    pts.push([sx(reversedX ? xHi : xLo), sy(sorted[0].y)]);
    for (const p of sorted) pts.push([sx(p.x), sy(p.y)]);
    pts.push([sx(reversedX ? xLo : xHi), sy(sorted[sorted.length - 1].y)]);
    return pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`).join("");
  })();

  // A few orientation ticks (min / mid / max on each axis).
  const xTicks = [xLo, (xLo + xHi) / 2, xHi];
  const yTicks = [yLo, (yLo + yHi) / 2, yHi];

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          Click to add baseline points, drag to move them. The same baseline (absorbance space) is
          subtracted from every spectrum.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={reset}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset
          </Button>
          <Button variant="outline" size="sm" onClick={clear} disabled={anchors.length === 0}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border/60 bg-background/40">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="h-auto w-full"
          style={{ touchAction: "none", cursor: "crosshair" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={() => setDragIdx(null)}
        >
          <rect x={0} y={0} width={VB_W} height={VB_H} fill="transparent" pointerEvents="all" />

          {/* gridlines */}
          {yTicks.map((t) => (
            <line
              key={`gy${t}`}
              x1={M.left}
              x2={M.left + plotW}
              y1={sy(t)}
              y2={sy(t)}
              stroke="#e2e8f0"
              strokeWidth={1}
            />
          ))}

          {/* context spectra (faint) */}
          {contextPaths.map((d, i) =>
            d ? (
              <path
                key={i}
                d={d}
                fill="none"
                stroke="#94a3b8"
                strokeWidth={1}
                strokeOpacity={0.55}
              />
            ) : null,
          )}

          {/* the drawn baseline */}
          {baselineD && (
            <path d={baselineD} fill="none" stroke="#dc2626" strokeWidth={1.75} strokeLinejoin="round" />
          )}

          {/* anchor handles */}
          {local.map((p, i) => (
            <circle
              key={i}
              cx={sx(p.x)}
              cy={sy(p.y)}
              r={5}
              fill="#dc2626"
              stroke="#ffffff"
              strokeWidth={1.5}
              style={{ cursor: "grab" }}
            />
          ))}

          {/* frame */}
          <rect
            x={M.left}
            y={M.top}
            width={plotW}
            height={plotH}
            fill="none"
            stroke="#334155"
            strokeWidth={1}
          />

          {/* axis ticks */}
          {xTicks.map((t) => (
            <text
              key={`tx${t}`}
              x={sx(t)}
              y={VB_H - 10}
              textAnchor="middle"
              fontSize={11}
              fill="#334155"
            >
              {Math.round(t)}
            </text>
          ))}
          {yTicks.map((t) => (
            <text
              key={`ty${t}`}
              x={M.left - 6}
              y={sy(t) + 4}
              textAnchor="end"
              fontSize={11}
              fill="#334155"
            >
              {t.toFixed(2)}
            </text>
          ))}
        </svg>
      </div>

      {anchors.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {[...anchors]
            .map((p, i) => ({ p, i }))
            .sort((a, b) => a.p.x - b.p.x)
            .map(({ p, i }) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground"
              >
                {Math.round(p.x)} cm⁻¹, A={p.y.toFixed(3)}
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="ml-0.5 text-muted-foreground hover:text-destructive"
                  title="Remove point"
                >
                  ✕
                </button>
              </span>
            ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          No baseline points yet — click on the plot above to start, or press Reset for a flat
          starting line.
        </p>
      )}
    </div>
  );
}
