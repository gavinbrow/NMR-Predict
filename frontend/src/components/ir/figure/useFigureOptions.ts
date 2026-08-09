import { useCallback, useRef, useState } from "react";
import {
  defaultFigureOptions,
  reconcileFigureOptions,
  reconcilePeakLabelOverrides,
  type FigureData,
  type FigureOptionSeed,
  type FigureOptions,
} from "@/lib/ir/figure";

/**
 * Figure options state for a host. Seeds defaults from the first data (plus the
 * host's own `seed` preferences), then reconciles per-series styles when the
 * series set changes and follows the host's axis labels while the user hasn't
 * overridden them (the same derived-state-during-render pattern the IR section
 * uses elsewhere). Keeping the state at the host level means customizations
 * survive data updates, tab switches, and dialog close/reopen.
 *
 * `seed` is read once, when the state is first created; changing it later has no
 * effect (it is a default, not a controlled value).
 *
 * The returned setter is referentially stable, so hosts can restore a persisted
 * figure from an effect without re-running it on every options change.
 */
export function useFigureOptions(
  data: FigureData,
  seed?: FigureOptionSeed,
): [FigureOptions, (next: FigureOptions) => void] {
  const [options, setOptions] = useState<FigureOptions>(() => defaultFigureOptions(data, seed));

  // Wrap setOptions so we can tell when the user explicitly toggled peak-label
  // visibility — that touch wins over the auto-seed below (WP0b). Any change
  // touching `peakLabels.show` counts; everything else passes through untouched.
  // The current options are read through a ref so the setter stays stable.
  const userToggledPeakLabels = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const setOptionsTracked = useCallback((next: FigureOptions) => {
    if (next.peakLabels.show !== optionsRef.current.peakLabels.show) {
      userToggledPeakLabels.current = true;
    }
    setOptions(next);
  }, []);

  const [seriesKey, setSeriesKey] = useState(() => data.series.map((s) => s.id).join("|"));
  const currentSeriesKey = data.series.map((s) => s.id).join("|");
  if (currentSeriesKey !== seriesKey) {
    setSeriesKey(currentSeriesKey);
    setOptions((prev) => reconcileFigureOptions(prev, data));
  }

  // Drop peak-label overrides whose peak id is gone (peaks re-pick with fresh
  // ids). Keyed on the label-id set so it only runs when the labels actually
  // change, and it leaves options untouched when nothing needs pruning.
  const [labelKey, setLabelKey] = useState(() =>
    (data.peakLabels ?? []).map((p) => p.id).join("|"),
  );
  const currentLabelKey = (data.peakLabels ?? []).map((p) => p.id).join("|");
  if (currentLabelKey !== labelKey) {
    setLabelKey(currentLabelKey);
    setOptions((prev) => {
      const overrides = reconcilePeakLabelOverrides(prev.peakLabels.overrides, data);
      return overrides === prev.peakLabels.overrides
        ? prev
        : { ...prev, peakLabels: { ...prev.peakLabels, overrides } };
    });
  }

  // Follow host label changes (e.g. %T → Absorbance, time-unit changes) unless
  // the user has edited the label away from what the host last provided.
  //
  // A changed axis label also means the axis changed UNITS, which invalidates any
  // manual bound the user zoomed in with: dragging or scrolling the preview writes
  // real numbers into `x.min`/`y.max` (FigureMaker's `handleZoom`), and those
  // numbers only mean anything in the unit they were captured in. MALDI's Normalize
  // is the case that bites — it flips the y label between "Intensity" and
  // "Rel. intensity (%)", and it turns itself on the moment a second document
  // becomes visible. A user who had scrolled the preview to 0–8000 counts kept that
  // axis over 0–100 % data, so both traces flattened onto the baseline and the
  // figure looked like it had ignored the new file. Drop the bounds on the axis
  // whose unit moved, and only that one: an m/z window stays meaningful when the
  // intensity unit changes underneath it.
  const [hostLabels, setHostLabels] = useState(() => ({ x: data.xLabel, y: data.yLabel }));
  if (hostLabels.x !== data.xLabel || hostLabels.y !== data.yLabel) {
    const prevLabels = hostLabels;
    const xChanged = prevLabels.x !== data.xLabel;
    const yChanged = prevLabels.y !== data.yLabel;
    setHostLabels({ x: data.xLabel, y: data.yLabel });
    setOptions((prev) => ({
      ...prev,
      x: xChanged
        ? { ...prev.x, label: prev.x.label === prevLabels.x ? data.xLabel : prev.x.label, min: null, max: null }
        : prev.x,
      y: yChanged
        ? { ...prev.y, label: prev.y.label === prevLabels.y ? data.yLabel : prev.y.label, min: null, max: null }
        : prev.y,
    }));
  }

  // Re-seed peakLabels.show when labels first appear (WP0b). defaultFigureOptions
  // seeds it once from `data.peakLabels?.length > 0`, so a host that mounts the
  // figure before picking peaks (MALDI's Figure tab is always mounted) seeds it
  // off and the labels then never come on. Mirror the hostLabels follow pattern:
  // when `data.peakLabels` goes from empty to non-empty and the user has not
  // explicitly toggled visibility, turn `show` on. Once the user touches it, it
  // is theirs.
  const [hadPeakLabels, setHadPeakLabels] = useState(() => (data.peakLabels?.length ?? 0) > 0);
  const hasPeakLabels = (data.peakLabels?.length ?? 0) > 0;
  if (hasPeakLabels !== hadPeakLabels) {
    setHadPeakLabels(hasPeakLabels);
    if (hasPeakLabels && !userToggledPeakLabels.current) {
      setOptions((prev) => (prev.peakLabels.show ? prev : { ...prev, peakLabels: { ...prev.peakLabels, show: true } }));
    }
  }

  return [options, setOptionsTracked];
}
