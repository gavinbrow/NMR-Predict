// Adapter from the MALDI data model to the neutral figure engine (`lib/ir/figure`,
// the shared publication-figure system). It turns the active spectrum, its picked
// peaks, and any overlaid spectra into the engine's `FigureData` shape — a profile
// trace, an optional centroid/stick series, and data-anchored m/z peak labels —
// so the same fully-controllable figure maker the IR view uses renders MALDI
// publication figures. Pure data shaping; no DOM, fully unit-testable.

import type { FigureData, FigureSeriesData, PeakLabelDatum } from "@/lib/ir/figure";
import type { Peak, SpectrumData } from "./types";

/** One spectrum to plot. The first entry is the primary (its peaks are labelled). */
export interface MaldiFigureSpectrum {
  id: string;
  name: string;
  spectrum: SpectrumData;
}

/**
 * One assigned-ladder group used to split the sticks into per-series stems and to
 * colour labels by series. A peak can belong to several series at once (different
 * adduct readings share member peaks), so groups are consulted in ARRAY ORDER: the
 * caller passes them already ordered by precedence (confirmed ladders first, then
 * by descending score) and a shared peak is claimed by the first group that lists
 * it. See {@link BuildMaldiFigureArgs.seriesGroups}.
 */
export interface MaldiFigureSeriesGroup {
  /** Stable series id — the stick series is `sticks:${id}` and each owned label
   *  carries it as `seriesId` (so "colour labels by series" resolves the ladder
   *  colour). Must NOT be an index: an index id would make the figure engine's
   *  `reconcileFigureOptions` discard the user's per-series styling every time the
   *  selection changes. */
  id: string;
  /** Legend label for this ladder (e.g. its adduct label). Adduct siblings share a
   *  colour by design, so the label is what tells them apart in the legend. */
  label: string;
  /** The ladder's colour (from the page's `colorForSeries`, matching the plot). */
  color: string;
  /** Member peak ids of this ladder (a peak may appear in several groups). */
  peakIds: Set<string>;
}

export interface BuildMaldiFigureArgs {
  /** Spectra to draw as profile traces; `spectra[0]` is the primary. */
  spectra: MaldiFigureSpectrum[];
  /** Peaks of the primary spectrum, already filtered to what should be shown
   *  (e.g. accepted-only, or just the selected series). Drives sticks + labels. */
  peaks: Peak[];
  /** Draw the continuous profile trace(s). */
  showProfile: boolean;
  /** Draw the picked peaks as vertical sticks (centroid spectrum). */
  showSticks: boolean;
  /** Annotate peaks with their m/z. */
  labelPeaks: boolean;
  /** File-name stem for downloads. */
  sourceName: string;
  /**
   * Optional per-series stick grouping. When present, the sticks are emitted as
   * one series per group (id `sticks:${group.id}`, coloured `group.color`) plus an
   * optional trailing `sticks:unassigned` series for shown peaks in no group, and
   * every label carries its owning group's id as `seriesId`. When absent the
   * sticks collapse to a single `"sticks"` series (unchanged legacy behaviour).
   */
  seriesGroups?: MaldiFigureSeriesGroup[];
}

/** A neutral dark trace for the primary spectrum (matches the on-screen viewer). */
const PRIMARY_TRACE = "#1e293b";
/** Sky stems for the centroid/stick series (matches the viewer's peak markers). */
const STICK_COLOR = "#0ea5e9";

/** The drawable m/z of a peak (centroid-refined when available). */
const peakMz = (p: Peak): number => p.centroid ?? p.mz;

/**
 * Append stick series for `members` to `out`, honouring per-peak `Peak.color`.
 * The shared figure renderer strokes an entire stick series in a single colour,
 * so a peak carrying its own colour cannot share a path with a differently-
 * coloured peak: members are bucketed by effective colour (`peak.color` when set,
 * else `baseColor`). The bucket matching `baseColor` keeps the plain `id`/`label`;
 * any explicit override colour gets its own `${id}:c:${color}` series. Those ids
 * are stable (derived from the colour, not a position), so the user's per-series
 * styling survives selection changes. No members → nothing is appended.
 *
 * The base-colour bucket is emitted first (it is the ladder), and the override
 * buckets are marked `legendHidden`: they exist only because one peak was
 * recoloured, and a legend row repeating the ladder's name under a one-off
 * colour is noise. Adding one back is a tick in the legend's entry list.
 */
function pushStickSeries(
  out: FigureSeriesData[],
  members: Peak[],
  id: string,
  label: string,
  baseColor: string,
): void {
  if (members.length === 0) return;
  // First-seen colour order keeps the emitted series order deterministic.
  const byColor = new Map<string, Peak[]>();
  for (const p of members) {
    const color = p.color ?? baseColor;
    const bucket = byColor.get(color);
    if (bucket) bucket.push(p);
    else byColor.set(color, [p]);
  }
  const ordered = [...byColor].sort(
    (a, b) => Number(b[0] === baseColor) - Number(a[0] === baseColor),
  );
  for (const [color, bucket] of ordered) {
    const isBase = color === baseColor;
    out.push({
      id: isBase ? id : `${id}:c:${color}`,
      label,
      x: bucket.map(peakMz),
      y: bucket.map((p) => p.intensity),
      styleHints: { kind: "sticks", lineWidth: 1, color },
      ...(isBase ? {} : { legendHidden: true }),
    });
  }
}

/**
 * Build the figure-engine `FigureData` for a MALDI view. Each spectrum becomes a
 * line series on its own m/z grid; the primary's peaks optionally become stick
 * series and a set of m/z labels. Per-peak `Peak.color` and `Peak.label` are read
 * straight from the existing peak model — the same fields the on-screen plot and
 * the Peak table already honour — rather than regenerated, so "colour a peak" and
 * "rename a label" made in the Peak table show up in the figure unchanged.
 * `peakLabels` is always present (possibly empty) so the figure maker shows the
 * "Peaks & labels" controls for MALDI.
 */
export function buildMaldiFigureData(args: BuildMaldiFigureArgs): FigureData {
  const { spectra, peaks, showProfile, showSticks, labelPeaks, sourceName, seriesGroups } = args;
  const series: FigureSeriesData[] = [];

  if (showProfile) {
    spectra.forEach((s, i) => {
      series.push({
        id: `profile:${s.id}`,
        label: s.name,
        x: Array.from(s.spectrum.mz),
        y: Array.from(s.spectrum.intensity),
        // Primary trace dark; overlays fall back to the engine's palette.
        styleHints: { kind: "line", lineWidth: 1, ...(i === 0 ? { color: PRIMARY_TRACE } : {}) },
      });
    });
  }

  const grouped = !!seriesGroups && seriesGroups.length > 0;

  // Resolve each shown peak's owning ladder. Peaks belong to several series at
  // once (adduct readings share member peaks), so precedence decides the owner:
  // the caller orders `seriesGroups` (confirmed ladders first, then by descending
  // score), and the FIRST group in that order that lists the peak claims it.
  const groupOf = new Map<string, MaldiFigureSeriesGroup>();
  if (grouped) {
    for (const p of peaks) {
      const owner = seriesGroups!.find((g) => g.peakIds.has(p.id));
      if (owner) groupOf.set(p.id, owner);
    }
  }

  if (showSticks && peaks.length > 0) {
    if (grouped) {
      // One stick series per group (stable `sticks:${group.id}`, in the ladder
      // colour), then a trailing `sticks:unassigned` for any shown peak in no
      // selected ladder. Emitted in the caller's precedence order.
      for (const g of seriesGroups!) {
        pushStickSeries(
          series,
          peaks.filter((p) => groupOf.get(p.id) === g),
          `sticks:${g.id}`,
          g.label,
          g.color,
        );
      }
      pushStickSeries(
        series,
        peaks.filter((p) => !groupOf.has(p.id)),
        "sticks:unassigned",
        "Unassigned",
        STICK_COLOR,
      );
    } else {
      // Legacy single-series behaviour when no grouping is supplied.
      pushStickSeries(series, peaks, "sticks", "Peaks", STICK_COLOR);
    }
  }

  const peakLabels: PeakLabelDatum[] = labelPeaks
    ? peaks.map((p) => {
        const mz = peakMz(p);
        const owner = groupOf.get(p.id);
        // A user-authored `Peak.label` is shown verbatim; `customText` protects it
        // from the maker's Decimals reformat. An empty label falls back to the m/z.
        const custom = typeof p.label === "string" && p.label.length > 0;
        return {
          id: p.id,
          x: mz,
          y: p.intensity,
          text: custom ? p.label! : mz.toFixed(2),
          ...(custom ? { customText: true } : {}),
          // Per-peak colour flows straight through to the label renderer, where it
          // wins over both "colour by series" and the single label colour.
          ...(p.color ? { color: p.color } : {}),
          // Owning ladder's stick-series id, so "colour labels by series" maps a
          // label to its ladder colour.
          ...(owner ? { seriesId: `sticks:${owner.id}` } : {}),
        };
      })
    : [];

  // The shared grid is the primary spectrum's m/z (used to seed the x-range and as
  // the fallback for any series that omits its own x — none here do).
  const primaryMz = spectra[0]?.spectrum.mz;
  return {
    x: primaryMz ? Array.from(primaryMz) : [],
    series,
    xLabel: "m/z",
    yLabel: "Intensity",
    reversedX: false,
    sourceName: sourceName || "maldi",
    peakLabels,
  };
}
