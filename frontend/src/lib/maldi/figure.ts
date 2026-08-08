// Adapter from the MALDI data model to the neutral figure engine (`lib/ir/figure`,
// the shared publication-figure system). It turns every open file — its spectrum,
// its picked peaks and its assigned ladders — into the engine's `FigureData` shape
// (profile traces, optional centroid/stick series, and data-anchored m/z peak
// labels), so the same fully-controllable figure maker the IR view uses renders
// MALDI publication figures, including cross-file ones. Pure data shaping; no DOM,
// fully unit-testable.

import type { FigureData, FigureSeriesData, PeakLabelDatum } from "@/lib/ir/figure";
import type { Peak, SpectrumData } from "./types";

/**
 * One assigned-ladder group used to split a file's sticks into per-series stems
 * and to colour labels by series. A peak can belong to several series at once
 * (different adduct readings share member peaks), so groups are consulted in
 * ARRAY ORDER: the caller passes them already ordered by precedence (confirmed
 * ladders first, then by descending score) and a shared peak is claimed by the
 * first group that lists it. See {@link MaldiFigureFile.seriesGroups}.
 */
export interface MaldiFigureSeriesGroup {
  /** Stable series id — the stick series is `sticks:${id}` and each owned label
   *  carries it as `seriesId` (so "colour labels by series" resolves the ladder
   *  colour). Must NOT be an index: an index id would make the figure engine's
   *  `reconcileFigureOptions` discard the user's per-series styling every time the
   *  selection changes. Series ids are `crypto.randomUUID()`s, so these stay
   *  unique across files. */
  id: string;
  /** Legend label for this ladder (e.g. its adduct label). Adduct siblings share a
   *  colour by design, so the label is what tells them apart in the legend. In a
   *  cross-file figure it is prefixed with the file name (two files routinely
   *  carry identically-named ladders). */
  label: string;
  /** The ladder's colour (from the page's `colorForSeries`, matching the plot). */
  color: string;
  /** Member peak ids of this ladder (a peak may appear in several groups). */
  peakIds: Set<string>;
}

/**
 * One source file in the figure. Each open document contributes its own trace,
 * its own peaks and its own ladders, each independently styleable — that is what
 * makes a cross-file figure editable file by file rather than as one blob.
 *
 * `scale`/`offset` are the y-transform that puts this file where the on-screen
 * plot puts it (the Documents panel's Normalize and per-trace stack offset).
 * Applying them here rather than leaving the figure on raw counts is what keeps
 * the exported figure and the screen from disagreeing — and without it a weak
 * spectrum plotted beside a strong one is a flat line.
 */
export interface MaldiFigureFile {
  /** Stable id — the trace series is `profile:${id}`. The FIRST file's id is the
   *  primary; it keeps the unqualified legacy series ids so a project saved from
   *  a single-file figure reopens with its styling intact. */
  id: string;
  name: string;
  spectrum: SpectrumData;
  /** This file's peaks, already filtered to what should be drawn (accepted-only,
   *  selected ladders, and so on). Drives its sticks + labels. */
  peaks: Peak[];
  /** This file's assigned ladders, in precedence order. Absent or empty collapses
   *  its peaks into one stick series. */
  seriesGroups?: MaldiFigureSeriesGroup[];
  /** Trace colour — the document's own colour, so the figure matches the plot.
   *  Omitted falls back to the engine's palette. */
  color?: string;
  /** Multiplier applied to every y of this file (profile, sticks and label
   *  anchors alike). Defaults to 1. */
  scale?: number;
  /** Constant added after {@link scale}. Defaults to 0. Also becomes the file's
   *  stick baseline, so stacked stems grow from their own trace. */
  offset?: number;
}

export interface BuildMaldiFigureArgs {
  /** Files to draw; `files[0]` is the primary. */
  files: MaldiFigureFile[];
  /** Draw the continuous profile trace(s). */
  showProfile: boolean;
  /** Draw the picked peaks as vertical sticks (centroid spectrum). */
  showSticks: boolean;
  /** Annotate peaks with their m/z. */
  labelPeaks: boolean;
  /** File-name stem for downloads. */
  sourceName: string;
  /** Y-axis label. Defaults to "Intensity"; hosts pass the normalised wording
   *  when they normalised the traces. */
  yLabel?: string;
}

/** A neutral dark trace for the primary spectrum (matches the on-screen viewer). */
const PRIMARY_TRACE = "#1e293b";
/** Sky stems for the centroid/stick series (matches the viewer's peak markers). */
const STICK_COLOR = "#0ea5e9";

/** The drawable m/z of a peak (centroid-refined when available). */
const peakMz = (p: Peak): number => p.centroid ?? p.mz;

/** One file's y-transform: where the on-screen plot draws it. */
type Transform = { scale: number; offset: number };

const transformOf = (f: MaldiFigureFile): Transform => ({
  scale: f.scale ?? 1,
  offset: f.offset ?? 0,
});

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
  tf: Transform,
  group: string | undefined,
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
      y: bucket.map((p) => p.intensity * tf.scale + tf.offset),
      // Stems grow from their own file's baseline, not from zero, so a stacked
      // figure's sticks stay attached to the trace they belong to.
      ...(tf.offset ? { baseline: tf.offset } : {}),
      styleHints: { kind: "sticks", lineWidth: 1, color },
      ...(group ? { group } : {}),
      ...(isBase ? {} : { legendHidden: true }),
    });
  }
}

/**
 * Build the figure-engine `FigureData` for a MALDI view. Each file becomes a line
 * series on its own m/z grid, plus (optionally) one stick series per assigned
 * ladder and a set of m/z labels. Per-peak `Peak.color` and `Peak.label` are read
 * straight from the existing peak model — the same fields the on-screen plot and
 * the Peak table already honour — rather than regenerated, so "colour a peak" and
 * "rename a label" made in the Peak table show up in the figure unchanged.
 * `peakLabels` is always present (possibly empty) so the figure maker shows the
 * "Peaks & labels" controls for MALDI.
 *
 * With more than one file every series carries its file's name as its
 * {@link FigureSeriesData.group}, which is what sections the maker's Series list
 * by file, and its legend label is prefixed with the file name (two files
 * routinely carry ladders with identical names).
 */
export function buildMaldiFigureData(args: BuildMaldiFigureArgs): FigureData {
  const { files, showProfile, showSticks, labelPeaks, sourceName, yLabel } = args;
  const series: FigureSeriesData[] = [];
  // Only a genuinely cross-file figure gets file headings and file-prefixed
  // labels; a single-file figure reads exactly as it did before.
  const multi = files.length > 1;

  // Resolve each shown peak's owning ladder, per file. Peaks belong to several
  // series at once (adduct readings share member peaks), so precedence decides
  // the owner: the caller orders each file's `seriesGroups` (confirmed ladders
  // first, then by descending score), and the FIRST group in that order that
  // lists the peak claims it.
  const groupOf = new Map<string, MaldiFigureSeriesGroup>();
  for (const f of files) {
    if (!f.seriesGroups?.length) continue;
    for (const p of f.peaks) {
      const owner = f.seriesGroups.find((g) => g.peakIds.has(p.id));
      if (owner) groupOf.set(p.id, owner);
    }
  }

  // One pass per file, emitting its trace and then its sticks, so everything a
  // file contributed is CONTIGUOUS in `series`. The controls group adjacent runs,
  // and the legend reads in the same order, so a file reads as one block in both
  // rather than as a trace at the top and its ladders further down.
  files.forEach((f, i) => {
    const tf = transformOf(f);
    const heading = multi ? f.name : undefined;

    if (showProfile) {
      series.push({
        id: `profile:${f.id}`,
        label: f.name,
        x: Array.from(f.spectrum.mz),
        y: Array.from(f.spectrum.intensity, (v) => v * tf.scale + tf.offset),
        // Cross-file figures take each document's own colour, so the figure
        // matches the plot and every file is identifiable. A single-file figure
        // keeps the neutral dark trace (recolouring it magenta because the
        // Documents panel happens to hold a swatch would be a surprise).
        styleHints: {
          kind: "line",
          lineWidth: 1,
          ...(multi ? (f.color ? { color: f.color } : {}) : i === 0 ? { color: PRIMARY_TRACE } : {}),
        },
        ...(heading ? { group: heading } : {}),
      });
    }

    if (showSticks && f.peaks.length > 0) {
      // Peaks no ladder owns take the file's colour in a cross-file figure (it
      // is the only thing that says which file they came from) and the neutral
      // stick colour in a single-file one, exactly as before.
      const looseColor = (multi ? f.color : undefined) ?? STICK_COLOR;
      // The primary file keeps the unqualified legacy ids so figures saved
      // before cross-file support reopen with their styling intact; later files
      // qualify theirs by file id. Ladder ids are already globally unique.
      const suffix = i === 0 ? "" : `:${f.id}`;
      if (f.seriesGroups?.length) {
        // One stick series per ladder (stable `sticks:${ladderId}`, in the ladder
        // colour), then a trailing unassigned bucket for any shown peak of this
        // file in no ladder. Emitted in the caller's precedence order.
        for (const g of f.seriesGroups) {
          pushStickSeries(
            series,
            f.peaks.filter((p) => groupOf.get(p.id) === g),
            `sticks:${g.id}`,
            multi ? `${f.name} · ${g.label}` : g.label,
            g.color,
            tf,
            heading,
          );
        }
        pushStickSeries(
          series,
          f.peaks.filter((p) => !groupOf.has(p.id)),
          `sticks:unassigned${suffix}`,
          multi ? `${f.name} · Unassigned` : "Unassigned",
          looseColor,
          tf,
          heading,
        );
      } else {
        // No ladders assigned in this file — its peaks collapse to one series.
        pushStickSeries(
          series,
          f.peaks,
          `sticks${i === 0 ? "" : `:file:${f.id}`}`,
          multi ? f.name : "Peaks",
          looseColor,
          tf,
          heading,
        );
      }
    }
  });

  const peakLabels: PeakLabelDatum[] = [];
  if (labelPeaks) {
    for (const f of files) {
      const tf = transformOf(f);
      for (const p of f.peaks) {
        const mz = peakMz(p);
        const owner = groupOf.get(p.id);
        // A user-authored `Peak.label` is shown verbatim; `customText` protects it
        // from the maker's Decimals reformat. An empty label falls back to the m/z.
        const custom = typeof p.label === "string" && p.label.length > 0;
        peakLabels.push({
          id: p.id,
          x: mz,
          y: p.intensity * tf.scale + tf.offset,
          // Thin by the peak's own intensity, so a stacked file's offset can't
          // hand every label to whichever trace happens to sit highest.
          priority: p.intensity,
          text: custom ? p.label! : mz.toFixed(2),
          ...(custom ? { customText: true } : {}),
          // Per-peak colour flows straight through to the label renderer, where it
          // wins over both "colour by series" and the single label colour.
          ...(p.color ? { color: p.color } : {}),
          // Owning ladder's stick-series id, so "colour labels by series" maps a
          // label to its ladder colour.
          ...(owner ? { seriesId: `sticks:${owner.id}` } : {}),
        });
      }
    }
  }

  // The shared grid is the primary file's m/z (used to seed the x-range and as
  // the fallback for any series that omits its own x — none here do).
  const primaryMz = files[0]?.spectrum.mz;
  return {
    x: primaryMz ? Array.from(primaryMz) : [],
    series,
    xLabel: "m/z",
    yLabel: yLabel || "Intensity",
    reversedX: false,
    sourceName: sourceName || "maldi",
    peakLabels,
  };
}
