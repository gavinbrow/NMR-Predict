import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { kendrickAnalysis } from "@/lib/maldi/kendrick";
import type { Peak } from "@/lib/maldi/types";

interface KendrickPlotProps {
  peaks: Peak[];
  baseRepeat: number;
  onBaseRepeatChange: (value: number) => void;
  /** Called with the peak ids in the clicked KMD row (a homologous series). */
  onSelectCluster: (peakIds: string[]) => void;
}

const KMD_TOLERANCE = 0.012;

/**
 * Kendrick mass-defect scatter plot. Each peak is a point at (nominal m/z, KMD);
 * peaks of one homologous series line up on a horizontal row. Clicking a point
 * selects its row (shared KMD) and reports the member peaks so the spectrum and
 * table can highlight them.
 */
export function KendrickPlot({ peaks, baseRepeat, onBaseRepeatChange, onSelectCluster }: KendrickPlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [selectedKmd, setSelectedKmd] = useState<number | null>(null);

  const points = useMemo(() => {
    if (!(baseRepeat > 0)) return [];
    return kendrickAnalysis(peaks, baseRepeat).sort((a, b) => a.nominalMass - b.nominalMass);
  }, [peaks, baseRepeat]);

  // Stable refs for the click handler (avoids recreating the plot on selection).
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const onSelectRef = useRef(onSelectCluster);
  onSelectRef.current = onSelectCluster;

  const buildData = (highlightKmd: number | null): AlignedData => {
    const xs = points.map((p) => p.nominalMass);
    const yAll = points.map((p) => p.kmd);
    const yHi = points.map((p) =>
      highlightKmd != null && Math.abs(p.kmd - highlightKmd) <= KMD_TOLERANCE ? p.kmd : null,
    );
    return [xs, yAll, yHi];
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    if (points.length === 0) return;

    const opts: Options = {
      width: container.clientWidth,
      height: container.clientHeight,
      cursor: { drag: { x: false, y: false }, points: { show: false } },
      legend: { show: false },
      scales: { x: { time: false } },
      axes: [
        { label: "Nominal m/z", grid: { stroke: "#e2e8f0", width: 1 } },
        { label: "Kendrick mass defect", grid: { stroke: "#e2e8f0", width: 1 } },
      ],
      series: [
        {},
        { paths: () => null, points: { show: true, size: 5, stroke: "#0ea5e9", fill: "#0ea5e9" } },
        { paths: () => null, points: { show: true, size: 8, stroke: "#a855f7", fill: "#a855f7" } },
      ],
      hooks: {
        setSelect: [],
      },
    };

    const plot = new uPlot(opts, buildData(null), container);
    plotRef.current = plot;

    const handleClick = (event: MouseEvent) => {
      const rect = plot.over.getBoundingClientRect();
      const kmd = plot.posToVal(event.clientY - rect.top, "y");
      const list = pointsRef.current;
      const members = list.filter((p) => Math.abs(p.kmd - kmd) <= KMD_TOLERANCE);
      if (members.length === 0) {
        setSelectedKmd(null);
        onSelectRef.current([]);
        return;
      }
      const meanKmd = members.reduce((s, p) => s + p.kmd, 0) / members.length;
      setSelectedKmd(meanKmd);
      onSelectRef.current(members.map((p) => p.peakId));
    };
    plot.over.addEventListener("click", handleClick);

    const ro = new ResizeObserver(() => {
      plot.setSize({ width: container.clientWidth, height: container.clientHeight });
    });
    ro.observe(container);

    return () => {
      plot.over.removeEventListener("click", handleClick);
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  // Repaint the highlighted row when the selection changes.
  useEffect(() => {
    plotRef.current?.setData(buildData(selectedKmd));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKmd, points]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-2">
        <Label className="text-[11px] text-muted-foreground">Base repeat unit (Da)</Label>
        <Input
          type="number"
          step={0.001}
          className="h-7 w-28 text-xs"
          value={baseRepeat || ""}
          onChange={(e) => onBaseRepeatChange(Number(e.target.value))}
        />
        <span className="text-[11px] text-muted-foreground">Click a row to highlight its series.</span>
      </div>
      {points.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          Pick peaks and set a base repeat unit to see the Kendrick plot.
        </div>
      ) : (
        <div ref={containerRef} className="min-h-0 flex-1" />
      )}
    </div>
  );
}
