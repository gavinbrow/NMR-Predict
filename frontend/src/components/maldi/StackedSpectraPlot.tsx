import { useEffect, useRef } from "react";
import uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import { resampleOnto } from "@/lib/maldi/view";
import type { SpectrumData } from "@/lib/maldi/types";

export interface StackSpectrum {
  id: string;
  name: string;
  spectrum: SpectrumData;
}

interface StackedSpectraPlotProps {
  spectra: StackSpectrum[];
  mode: "overlay" | "stacked";
}

const COLORS = ["#1e293b", "#0ea5e9", "#a855f7", "#f59e0b", "#ef4444", "#10b981", "#6366f1", "#ec4899"];
const GRID_POINTS = 4000;

/**
 * Draws several spectra on one shared, resampled m/z axis — either overlaid
 * (all normalized to 100 %) or stacked (each offset vertically). Used by the main
 * viewer when more than one spectrum is open and the user picks overlay/stacked.
 */
export function StackedSpectraPlot({ spectra, mode }: StackedSpectraPlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current || spectra.length === 0) return;
    const container = containerRef.current;

    let lo = Infinity;
    let hi = -Infinity;
    for (const s of spectra) {
      if (s.spectrum.mz.length === 0) continue;
      lo = Math.min(lo, s.spectrum.mz[0]);
      hi = Math.max(hi, s.spectrum.mz[s.spectrum.mz.length - 1]);
    }
    if (!Number.isFinite(lo) || !(hi > lo)) return;

    const grid = new Float64Array(GRID_POINTS);
    for (let i = 0; i < GRID_POINTS; i += 1) grid[i] = lo + ((hi - lo) * i) / (GRID_POINTS - 1);

    const normalized = spectra.map((s) => {
      const y = resampleOnto(grid, s.spectrum);
      let max = 0;
      for (const v of y) if (v > max) max = v;
      const out = new Float64Array(y.length);
      if (max > 0) for (let i = 0; i < y.length; i += 1) out[i] = (y[i] / max) * 100;
      return out;
    });

    // Stacked: shift each trace up by a fixed step so they don't overlap.
    const step = 120;
    const data: (number[] | Float64Array)[] = [grid];
    normalized.forEach((y, i) => {
      if (mode === "stacked") {
        const offset = (spectra.length - 1 - i) * step;
        const shifted = new Float64Array(y.length);
        for (let k = 0; k < y.length; k += 1) shifted[k] = y[k] + offset;
        data.push(shifted);
      } else {
        data.push(y);
      }
    });

    const opts: Options = {
      width: container.clientWidth,
      height: container.clientHeight,
      legend: { show: true },
      cursor: { drag: { x: true, y: false } },
      scales: { x: { time: false }, y: {} },
      axes: [
        { label: "m/z", grid: { stroke: "#e2e8f0", width: 1 } },
        { label: mode === "stacked" ? "rel. intensity (offset)" : "rel. intensity (%)", grid: { stroke: "#e2e8f0", width: 1 } },
      ],
      series: [
        {},
        ...spectra.map((s, i) => ({
          label: s.name,
          stroke: COLORS[i % COLORS.length],
          width: 1,
          points: { show: false },
        })),
      ],
    };

    const plot = new uPlot(opts, data as AlignedData, container);
    plotRef.current = plot;
    const ro = new ResizeObserver(() => plot.setSize({ width: container.clientWidth, height: container.clientHeight }));
    ro.observe(container);
    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [spectra, mode]);

  return <div ref={containerRef} className="h-full w-full" />;
}
