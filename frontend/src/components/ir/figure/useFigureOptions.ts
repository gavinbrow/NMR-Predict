import { useState } from "react";
import {
  defaultFigureOptions,
  reconcileFigureOptions,
  type FigureData,
  type FigureOptions,
} from "@/lib/ir/figure";

/**
 * Figure options state for a host. Seeds defaults from the first data, then
 * reconciles per-series styles when the series set changes and follows the
 * host's axis labels while the user hasn't overridden them (the same
 * derived-state-during-render pattern the IR section uses elsewhere). Keeping
 * the state at the host level means customizations survive data updates, tab
 * switches, and dialog close/reopen.
 */
export function useFigureOptions(
  data: FigureData,
): [FigureOptions, (next: FigureOptions) => void] {
  const [options, setOptions] = useState<FigureOptions>(() => defaultFigureOptions(data));

  const [seriesKey, setSeriesKey] = useState(() => data.series.map((s) => s.id).join("|"));
  const currentSeriesKey = data.series.map((s) => s.id).join("|");
  if (currentSeriesKey !== seriesKey) {
    setSeriesKey(currentSeriesKey);
    setOptions((prev) => reconcileFigureOptions(prev, data));
  }

  // Follow host label changes (e.g. %T → Absorbance, time-unit changes) unless
  // the user has edited the label away from what the host last provided.
  const [hostLabels, setHostLabels] = useState(() => ({ x: data.xLabel, y: data.yLabel }));
  if (hostLabels.x !== data.xLabel || hostLabels.y !== data.yLabel) {
    const prevLabels = hostLabels;
    setHostLabels({ x: data.xLabel, y: data.yLabel });
    setOptions((prev) => ({
      ...prev,
      x: prev.x.label === prevLabels.x ? { ...prev.x, label: data.xLabel } : prev.x,
      y: prev.y.label === prevLabels.y ? { ...prev.y, label: data.yLabel } : prev.y,
    }));
  }

  return [options, setOptions];
}
