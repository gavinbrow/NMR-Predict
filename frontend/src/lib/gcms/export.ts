// GC/MS export helpers: CSV/MSP/text string builders, download plumbing, and a
// combined "report" renderer that draws the chromatogram and mass spectrum as a
// stacked pair to both SVG (self-contained string) and PNG (canvas data URL).
//
// Every string builder is PURE so it can be unit-tested without a DOM. The
// download helpers and the PNG renderer touch the DOM and are skipped under
// jsdom by the test suite. The report renderers NEVER read CSS variables: the
// caller resolves theme colours via `getComputedStyle` and passes the resolved
// hex/rgb strings in, so the exported file opens correctly outside the app.

import { layoutLabels, type PlacedLabel } from "./annotate";
import type {
  ChromPeak,
  ChromTrace,
  MassSpectrum,
  MsRun,
  RunMeta,
  SpecPeak,
  SpectrumPeakRow,
} from "./types";

// ---------------------------------------------------------------------------
// Download plumbing — copied from lib/gpc/export.ts (that folder is being
// deleted; do not import from it). Blob + transient anchor + revoke.
// ---------------------------------------------------------------------------

/** Trigger a browser download of `text` as `filename`. Copied from lib/gpc/export.ts. */
export function downloadText(filename: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Trigger a browser download of a data URL (for PNG export). */
export function downloadDataUrl(filename: string, dataUrl: string): void {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

// ---------------------------------------------------------------------------
// Number formatting — plain, no thousands separators, no locale formatting.
//   RT         → 4 decimals (fixed)
//   m/z        → 3 decimals (fixed)
//   intensity  → up to 6 significant figures, no exponent for values < 1e9
// ---------------------------------------------------------------------------

function fmtRt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(4) : "";
}

function fmtMz(v: number): string {
  return Number.isFinite(v) ? v.toFixed(3) : "";
}

function fmtIntensity(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e9) return v.toExponential(5); // 6 sig figs, exponent for huge values
  // toPrecision(6) then back through Number so JS renders it without an
  // exponent for any value in [1e-6, 1e9).
  return Number(v.toPrecision(6)).toString();
}

function fmtRel(v: number): string {
  if (!Number.isFinite(v)) return "";
  return Number(v.toFixed(2)).toString();
}

function fmtBaseMz(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "";
  return v.toFixed(3);
}

// ---------------------------------------------------------------------------
// CSV — CRLF line endings, a header row, RFC-4180 quoting. Any field
// containing a comma, double quote or newline is wrapped in double quotes with
// inner quotes doubled.
// ---------------------------------------------------------------------------

function quoteCsv(field: string): string {
  if (/[",\n\r]/.test(field)) return `"${field.replace(/"/g, '""')}"`;
  return field;
}

function csvText(rows: string[][]): string {
  return rows.map((r) => r.map(quoteCsv).join(",")).join("\r\n");
}

/** One column per visible trace, sharing a union RT column. Traces are sampled
 *  onto the union grid; a trace with no point at a grid RT gets an EMPTY cell,
 *  not a zero. */
export function chromatogramCsv(traces: ChromTrace[]): string {
  const vis = traces.filter((t) => t.visible);
  if (vis.length === 0) return csvText([["rt"]]);
  // Union of every trace's RT samples, sorted ascending. A trace contributes
  // its own RTs to the grid; at another trace's RT it has no point and the
  // cell stays empty (not a zero — a zero would be a false measurement).
  const rtSet = new Set<number>();
  for (const t of vis) for (let i = 0; i < t.rtMin.length; i += 1) rtSet.add(t.rtMin[i]);
  const grid = Array.from(rtSet).sort((a, b) => a - b);
  const maps = vis.map((t) => {
    const m = new Map<number, number>();
    for (let i = 0; i < t.rtMin.length; i += 1) m.set(t.rtMin[i], t.intensity[i]);
    return m;
  });
  const rows: string[][] = [["rt", ...vis.map((t) => t.label)]];
  for (const rt of grid) {
    const row: string[] = [fmtRt(rt)];
    for (const m of maps) {
      const v = m.get(rt);
      row.push(v == null ? "" : fmtIntensity(v));
    }
    rows.push(row);
  }
  return csvText(rows);
}

/** "m/z,intensity,rel%" for one spectrum, m/z at 3 decimals. The rel% column
 *  is computed relative to the base peak (the tallest sample). */
export function spectrumCsv(spec: MassSpectrum): string {
  const n = spec.mz.length;
  let base = 0;
  for (let i = 0; i < n; i += 1) if (spec.intensity[i] > base) base = spec.intensity[i];
  const rows: string[][] = [["m/z", "intensity", "rel%"]];
  for (let i = 0; i < n; i += 1) {
    const rel = base > 0 ? (spec.intensity[i] / base) * 100 : 0;
    rows.push([fmtMz(spec.mz[i]), fmtIntensity(spec.intensity[i]), fmtRel(rel)]);
  }
  return csvText(rows);
}

/** Peak apex plus the user-visible integration boundaries and derived values. */
export function chromPeakCsv(peaks: ChromPeak[]): string {
  const rows: string[][] = [[
    "rt",
    "rtStart",
    "rtEnd",
    "height",
    "area",
    "area%",
    "width",
    "basePeakMz",
    "name",
  ]];
  for (const p of peaks) {
    rows.push([
      fmtRt(p.rtApex),
      fmtRt(p.rtStart),
      fmtRt(p.rtEnd),
      fmtIntensity(p.height),
      fmtIntensity(p.area),
      fmtRel(p.areaPct),
      fmtRt(p.rtEnd - p.rtStart),
      fmtBaseMz(p.basePeakMz),
      p.name ?? "",
    ]);
  }
  return csvText(rows);
}

/** Picked spectrum peaks. Provenance columns are included when the table rows
 * identify a live view or chromatographic source peak. */
export function spectrumPeakCsv(peaks: (SpecPeak | SpectrumPeakRow)[]): string {
  const withSources = peaks.some((peak) => "sourceLabel" in peak);
  const rows: string[][] = [
    withSources
      ? ["chromatogramPeak", "rtStart", "rtEnd", "m/z", "intensity", "rel%"]
      : ["m/z", "intensity", "rel%"],
  ];
  for (const p of peaks) {
    if (withSources) {
      const sourced = p as SpectrumPeakRow;
      rows.push([
        sourced.sourceLabel ?? "",
        sourced.sourceRtStart == null ? "" : fmtRt(sourced.sourceRtStart),
        sourced.sourceRtEnd == null ? "" : fmtRt(sourced.sourceRtEnd),
        fmtMz(p.mz),
        fmtIntensity(p.intensity),
        fmtRel(p.relPct),
      ]);
    } else {
      rows.push([fmtMz(p.mz), fmtIntensity(p.intensity), fmtRel(p.relPct)]);
    }
  }
  return csvText(rows);
}

// ---------------------------------------------------------------------------
// NIST MSP library format — the spectrum can be searched in external software.
//
//   Name: <name>
//   Formula:
//   MW:
//   CAS#:
//   Comment: <sample> <method> RT <rtLo>-<rtHi> min
//   Num Peaks: <n>
//   <mz> <intensity>; <mz> <intensity>; ...   (5 pairs per line)
//   <blank line>
//
// NIST tolerates empty Formula/MW/CAS# values, so the keys are KEPT with empty
// values rather than omitted (keeps the block shape stable for parsers that
// key off the labels).
// ---------------------------------------------------------------------------

export function spectrumMsp(
  spec: MassSpectrum,
  peaks: SpecPeak[],
  meta: RunMeta,
  name: string,
): string {
  // Base peak drives the 999 scaling (the NIST convention). Fall back to the
  // spectrum's own base peak when the picked list is empty.
  let base = 0;
  for (const p of peaks) if (p.intensity > base) base = p.intensity;
  if (base <= 0 && spec.basePeak) base = spec.basePeak.intensity;
  if (base <= 0) {
    for (let i = 0; i < spec.intensity.length; i += 1)
      if (spec.intensity[i] > base) base = spec.intensity[i];
  }
  const scale = base > 0 ? 999 / base : 0;

  const sample = meta.sample ?? "";
  const method = meta.method ?? "";
  const rtLo = spec.rtLo;
  const rtHi = spec.rtHi;

  const lines: string[] = [
    `Name: ${name}`,
    "Formula:",
    "MW:",
    "CAS#:",
    `Comment: ${sample} ${method} RT ${rtLo}-${rtHi} min`,
    `Num Peaks: ${peaks.length}`,
  ];

  // 5 pairs per line, "<mz> <intensity>" separated by "; ". m/z rounded to 1
  // decimal place, intensity an integer scaled so the base peak is 999.
  for (let i = 0; i < peaks.length; i += 5) {
    const slice = peaks.slice(i, i + 5);
    const pair = (p: SpecPeak): string => `${p.mz.toFixed(1)} ${Math.round(p.intensity * scale)}`;
    lines.push(slice.map(pair).join("; "));
  }

  // Trailing blank line — NIST separates entries with one.
  lines.push("");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Metadata text — a human-readable dump of a run.
// ---------------------------------------------------------------------------

export function metadataText(run: MsRun): string {
  const m = run.meta;
  const out: string[] = [];
  out.push("GC/MS Run Metadata");
  out.push("==================");
  const row = (label: string, v: unknown): void => {
    const s = v == null || v === "" ? "—" : String(v);
    out.push(`${label.padEnd(20)} ${s}`);
  };
  row("Name:", run.name);
  row("Source path:", run.sourcePath);
  row("Format:", run.format);
  row("Detector:", run.detector);
  row("Operator:", m.operator);
  row("Sample:", m.sample);
  row("Method:", m.method);
  row("Instrument:", m.instrument);
  row("Serial number:", m.serialNumber);
  row("Acquired:", m.acquiredDate);
  row("Inlet:", m.inlet);
  row("Ionization:", m.ionization);
  if (m.ciReagent) row("CI reagent:", m.ciReagent);
  row("Polarity:", m.polarity ?? "—");
  row("Scan mode:", m.scanMode);
  row("Low mass:", m.lowMass);
  row("High mass:", m.highMass);
  row("Solvent delay:", m.solventDelayMin != null ? `${m.solventDelayMin} min` : undefined);
  row("Run time:", m.runTimeMin != null ? `${m.runTimeMin} min` : undefined);
  row("Source temp:", m.sourceTemp != null ? `${m.sourceTemp} C` : undefined);
  row("Quad temp:", m.quadTemp != null ? `${m.quadTemp} C` : undefined);
  row("Oven initial:", m.ovenInitialTempC != null ? `${m.ovenInitialTempC} C` : undefined);
  if (m.ovenRamps && m.ovenRamps.length > 0) {
    out.push("Oven ramps:");
    out.push("    #   rate (C/min)   final (C)   hold (min)");
    m.ovenRamps.forEach((r, i) => {
      out.push(
        `    ${String(i + 1).padStart(2)}   ${String(r.rate).padStart(12)}   ${String(r.finalTemp).padStart(9)}   ${String(r.finalTime).padStart(9)}`,
      );
    });
  }
  out.push("");
  out.push("Scan summary");
  out.push("------------");
  row("Scan count:", run.scanCount);
  row("Point count:", run.pointCount);
  row("RT range:", `${run.rtRange[0].toFixed(4)}-${run.rtRange[1].toFixed(4)} min`);
  row("m/z range:", `${run.mzRange[0].toFixed(3)}-${run.mzRange[1].toFixed(3)}`);
  row("TIC range:", `${fmtIntensity(run.ticRange[0])}-${fmtIntensity(run.ticRange[1])}`);
  if (run.warnings.length > 0) {
    out.push("");
    out.push("Warnings");
    out.push("--------");
    for (const w of run.warnings) out.push(`- ${w}`);
  }
  return out.join("\r\n");
}

// ---------------------------------------------------------------------------
// Combined report — two stacked panels (chromatogram on top, mass spectrum
// below), each 50% of the height minus a small gutter. The SAME layout is
// rendered to SVG (a self-contained string) and PNG (an offscreen canvas).
// ---------------------------------------------------------------------------

export interface ReportPanelSpec {
  title: string;
  xLabel: string;
  traces: { x: Float64Array; y: Float64Array; color: string; width: number; label?: string }[];
  drawMode: "line" | "stick";
  labels: { x: number; y: number; lines: string[]; priority: number }[];
}

export interface ReportTheme {
  fg: string;
  muted: string;
  border: string;
  bg: string;
}

// Panel margins (CSS pixels, before the PNG `scale` is applied).
const MARGIN_LEFT = 56;
const MARGIN_RIGHT = 14;
const MARGIN_TOP = 24; // title line
const MARGIN_BOTTOM = 44; // x ticks + x label
const GUTTER = 12;
// Label font metrics — MUST match the metrics passed to `layoutLabels` so the
// leader lines line up with the placed boxes. charWidth ≈ fontSize * 0.6.
const LABEL_FONT = "11px ui-sans-serif, system-ui, sans-serif";
const LABEL_FONT_SIZE = 11;
const LABEL_LINE_HEIGHT = 13;
const LABEL_CHAR_WIDTH = 6.6;
const TICK_FONT = "10px ui-sans-serif, system-ui, sans-serif";
const TITLE_FONT = "11px ui-sans-serif, system-ui, sans-serif";
const LEGEND_ROW_HEIGHT = 13;
/** Keep the fixed-height report useful even when hundreds of separate XICs
 * are present. The final visible item summarizes every omitted trace. */
const MAX_LEGEND_ROWS = 3;

interface PanelLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  plotBottom: number;
  plotRight: number;
  title: string;
  xLabel: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  xTicks: number[];
  yTicks: number[];
  // Traces with points already converted to PIXEL coordinates.
  traces: { pts: Array<[number, number]>; color: string; width: number; mode: "line" | "stick" }[];
  legend: { label: string; color: string | null; x: number; y: number }[];
  placed: PlacedLabel[];
  // Recomputed label box sizes (w/h) aligned with `placed` for leader drawing.
  boxes: { w: number; h: number }[];
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  let step: number;
  if (norm < 1.5) step = mag;
  else if (norm < 3) step = 2 * mag;
  else if (norm < 7) step = 5 * mag;
  else step = 10 * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    // Guard against floating-point drift on long loops.
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks;
}

function fmtTick(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (v === 0) return "0";
  return Number(v.toPrecision(4)).toString();
}

function boxSizeFor(lines: string[]): { w: number; h: number } {
  let maxLen = 0;
  for (const ln of lines) if (ln.length > maxLen) maxLen = ln.length;
  return { w: maxLen * LABEL_CHAR_WIDTH, h: lines.length * LABEL_LINE_HEIGHT };
}

interface LegendSource {
  label: string;
  color: string | null;
}

/** Lay out one candidate legend, returning null when it needs too many rows. */
function packLegend(
  items: LegendSource[],
  plotLeft: number,
  top: number,
  plotWidth: number,
  maxRows: number,
): { items: PanelLayout["legend"]; rows: number } | null {
  const packed: PanelLayout["legend"] = [];
  let row = 0;
  let cursor = 0;
  for (const item of items) {
    // A summary has no colour swatch, so it needs less horizontal space.
    const itemWidth = (item.color == null ? 0 : 18) + item.label.length * 5.5;
    if (cursor > 0 && cursor + itemWidth > plotWidth) {
      row += 1;
      cursor = 0;
    }
    if (row >= maxRows) return null;
    packed.push({
      ...item,
      x: plotLeft + cursor,
      y: top + MARGIN_TOP + row * LEGEND_ROW_HEIGHT,
    });
    cursor += itemWidth + 10;
  }
  return { items: packed, rows: items.length > 0 ? row + 1 : 0 };
}

/** Preserve as many m/z-to-colour mappings as fit, then state exactly how
 * many traces were omitted rather than allowing the legend to crush the plot. */
function boundedLegend(
  labelled: { label?: string; color: string }[],
  plotLeft: number,
  top: number,
  plotWidth: number,
): { items: PanelLayout["legend"]; rows: number } {
  if (labelled.length <= 1) return { items: [], rows: 0 };
  const all = labelled.map((trace) => ({ label: trace.label!, color: trace.color }));
  const full = packLegend(all, plotLeft, top, plotWidth, MAX_LEGEND_ROWS);
  if (full) return full;

  // Find the largest prefix that still leaves room for an explicit overflow
  // summary. Continue through every prefix because the summary can become one
  // character shorter when its count crosses a power-of-ten boundary.
  let best = packLegend(
    [{ label: `+${all.length} more traces`, color: null }],
    plotLeft,
    top,
    plotWidth,
    MAX_LEGEND_ROWS,
  )!;
  for (let visibleCount = 1; visibleCount < all.length; visibleCount += 1) {
    const omitted = all.length - visibleCount;
    const summary = `+${omitted} more trace${omitted === 1 ? "" : "s"}`;
    const candidate = packLegend(
      [...all.slice(0, visibleCount), { label: summary, color: null }],
      plotLeft,
      top,
      plotWidth,
      MAX_LEGEND_ROWS,
    );
    if (candidate) best = candidate;
  }
  return best;
}

function layoutPanel(
  spec: ReportPanelSpec,
  left: number,
  top: number,
  width: number,
  height: number,
): PanelLayout {
  const plotLeft = left + MARGIN_LEFT;
  const plotRight = left + width - MARGIN_RIGHT;
  const basePlotWidth = Math.max(1, plotRight - plotLeft);
  const labelled = spec.traces.filter((trace) => trace.label);
  const { items: legend, rows: legendRows } = boundedLegend(
    labelled,
    plotLeft,
    top,
    basePlotWidth,
  );
  const plotTop = top + MARGIN_TOP + legendRows * LEGEND_ROW_HEIGHT;
  const plotBottom = top + height - MARGIN_BOTTOM;
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const plotHeight = Math.max(1, plotBottom - plotTop);

  // Data extents from every trace. y always starts at 0 (both the TIC and the
  // mass spectrum sit on a zero baseline); a degenerate trace falls back to
  // [0, 1] so the scale math never divides by zero.
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMax = 0;
  for (const tr of spec.traces) {
    const n = tr.x.length;
    if (n === 0) continue;
    if (tr.x[0] < xMin) xMin = tr.x[0];
    if (tr.x[n - 1] > xMax) xMax = tr.x[n - 1];
    for (let i = 0; i < n; i += 1) {
      const y = tr.y[i];
      if (Number.isFinite(y) && y > yMax) yMax = y;
    }
  }
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) {
    xMin = 0;
    xMax = 1;
  }
  if (yMax <= 0) yMax = 1;
  const yMin = 0;
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const xToPx = (x: number): number => plotLeft + ((x - xMin) / xSpan) * plotWidth;
  const yToPx = (y: number): number => plotTop + plotHeight - ((y - yMin) / ySpan) * plotHeight;

  const traces = spec.traces.map((tr) => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < tr.x.length; i += 1) {
      const y = tr.y[i];
      if (!Number.isFinite(y)) continue;
      pts.push([xToPx(tr.x[i]), yToPx(y)]);
    }
    return { pts, color: tr.color, width: tr.width, mode: spec.drawMode };
  });

  // Labels: convert DATA-unit anchors to PLOT pixels, then let `layoutLabels`
  // place them without overlap. THIS is why layoutLabels exists — do not
  // re-implement placement here.
  const labelInputs = spec.labels.map((l) => ({
    x: xToPx(l.x),
    y: yToPx(l.y),
    lines: l.lines,
    priority: l.priority,
  }));
  const placed = layoutLabels(labelInputs, {
    plotLeft,
    plotTop,
    plotWidth,
    plotHeight,
    fontSize: LABEL_FONT_SIZE,
    lineHeight: LABEL_LINE_HEIGHT,
    charWidth: LABEL_CHAR_WIDTH,
    maxLabels: 40,
    minGapPx: 2,
    leaderMinPx: 10,
  });
  const boxes = placed.map((p) => boxSizeFor(p.lines));

  return {
    left,
    top,
    width,
    height,
    plotLeft,
    plotTop,
    plotWidth,
    plotHeight,
    plotBottom,
    plotRight,
    title: spec.title,
    xLabel: spec.xLabel,
    xMin,
    xMax,
    yMin,
    yMax,
    xTicks: niceTicks(xMin, xMax, 6),
    yTicks: niceTicks(yMin, yMax, 5),
    traces,
    legend,
    placed,
    boxes,
  };
}

/**
 * Lay out the report's panels. `top` is null for a run with no chromatogram
 * (a direct-infusion or single-scan acquisition), in which case the spectrum
 * gets the whole canvas instead of half of it above an empty frame.
 */
function twoPanels(
  top: ReportPanelSpec | null,
  bottom: ReportPanelSpec,
  width: number,
  height: number,
) {
  if (!top) return { topL: null, botL: layoutPanel(bottom, 0, 0, width, height) };
  const panelH = (height - GUTTER) / 2;
  const topL = layoutPanel(top, 0, 0, width, panelH);
  const botL = layoutPanel(bottom, 0, panelH + GUTTER, width, height - panelH - GUTTER);
  return { topL, botL };
}

// --- SVG ---------------------------------------------------------------------

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function svgPanel(p: PanelLayout, theme: ReportTheme): string {
  const parts: string[] = [];
  // Frame.
  parts.push(
    `<rect x="${p.plotLeft}" y="${p.plotTop}" width="${p.plotWidth}" height="${p.plotHeight}" fill="none" stroke="${theme.border}" stroke-width="1"/>`,
  );
  // Title (top-left, small muted).
  parts.push(
    `<text x="${p.left + 4}" y="${p.top + 14}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" fill="${theme.muted}">${xmlEsc(p.title)}</text>`,
  );
  // Trace legend lives in reserved space between the title and plot, so
  // separated XIC colours remain attributable to their m/z in standalone SVG.
  for (const item of p.legend) {
    if (item.color != null) {
      parts.push(
        `<line x1="${item.x}" y1="${item.y + 5}" x2="${item.x + 10}" y2="${item.y + 5}" stroke="${item.color}" stroke-width="2"/>`,
      );
    }
    parts.push(
      `<text x="${item.x + (item.color == null ? 0 : 14)}" y="${item.y + 8}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="9" fill="${theme.muted}">${xmlEsc(item.label)}</text>`,
    );
  }
  // Y axis ticks + labels.
  for (const t of p.yTicks) {
    const y = p.plotTop + p.plotHeight - ((t - p.yMin) / (p.yMax - p.yMin || 1)) * p.plotHeight;
    if (y < p.plotTop - 0.5 || y > p.plotBottom + 0.5) continue;
    parts.push(
      `<line x1="${p.plotLeft}" y1="${y}" x2="${p.plotLeft - 4}" y2="${y}" stroke="${theme.border}" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${p.plotLeft - 6}" y="${y + 3}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10" fill="${theme.muted}" text-anchor="end">${xmlEsc(fmtTick(t))}</text>`,
    );
  }
  // X axis ticks + labels.
  for (const t of p.xTicks) {
    const x = p.plotLeft + ((t - p.xMin) / (p.xMax - p.xMin || 1)) * p.plotWidth;
    if (x < p.plotLeft - 0.5 || x > p.plotRight + 0.5) continue;
    parts.push(
      `<line x1="${x}" y1="${p.plotBottom}" x2="${x}" y2="${p.plotBottom + 4}" stroke="${theme.border}" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${x}" y="${p.plotBottom + 16}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10" fill="${theme.muted}" text-anchor="middle">${xmlEsc(fmtTick(t))}</text>`,
    );
  }
  // X axis label, centred beneath the ticks.
  parts.push(
    `<text x="${p.plotLeft + p.plotWidth / 2}" y="${p.plotBottom + 32}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" fill="${theme.fg}" text-anchor="middle">${xmlEsc(p.xLabel)}</text>`,
  );
  // Traces.
  for (const tr of p.traces) {
    if (tr.pts.length === 0) continue;
    if (tr.mode === "stick") {
      const baseY = p.plotBottom;
      for (const [x, y] of tr.pts) {
        parts.push(
          `<line x1="${x}" y1="${baseY}" x2="${x}" y2="${y}" stroke="${tr.color}" stroke-width="${tr.width}"/>`,
        );
      }
    } else {
      const pts = tr.pts.map(([x, y]) => `${x},${y}`).join(" ");
      parts.push(
        `<polyline points="${pts}" fill="none" stroke="${tr.color}" stroke-width="${tr.width}" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
    }
  }
  // Labels + leader lines. The leader connects the anchor to the bottom-centre
  // of the placed label box; the label text is drawn line by line below the
  // box top.
  for (let i = 0; i < p.placed.length; i += 1) {
    const lab = p.placed[i];
    const box = p.boxes[i];
    const boxCenterX = lab.x + box.w / 2;
    const boxBottom = lab.y + box.h;
    parts.push(
      `<line x1="${lab.anchorX}" y1="${lab.anchorY}" x2="${boxCenterX}" y2="${boxBottom}" stroke="${theme.muted}" stroke-width="0.5"/>`,
    );
    for (let li = 0; li < lab.lines.length; li += 1) {
      const ly = lab.y + (li + 1) * LABEL_LINE_HEIGHT - (LABEL_LINE_HEIGHT - LABEL_FONT_SIZE) / 2;
      parts.push(
        `<text x="${boxCenterX}" y="${ly}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="${LABEL_FONT_SIZE}" fill="${lab.color ?? theme.fg}" text-anchor="middle">${xmlEsc(lab.lines[li])}</text>`,
      );
    }
  }
  return parts.join("");
}

export function renderReportSvg(
  top: ReportPanelSpec | null,
  bottom: ReportPanelSpec,
  opts: { width: number; height: number; theme: ReportTheme },
): string {
  const { width, height, theme } = opts;
  const { topL, botL } = twoPanels(top, bottom, width, height);
  const body =
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${theme.bg}"/>` +
    (topL ? svgPanel(topL, theme) : "") +
    svgPanel(botL, theme);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">${body}</svg>`
  );
}

// --- PNG ---------------------------------------------------------------------

function canvasPanel(ctx: CanvasRenderingContext2D, p: PanelLayout, theme: ReportTheme): void {
  ctx.save();
  // Frame.
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(p.plotLeft + 0.5, p.plotTop + 0.5, p.plotWidth, p.plotHeight);
  // Title.
  ctx.fillStyle = theme.muted;
  ctx.font = TITLE_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(p.title, p.left + 4, p.top + 14);
  // Same reserved-space legend as SVG, preserving m/z-to-colour provenance.
  ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "alphabetic";
  for (const item of p.legend) {
    if (item.color != null) {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(item.x, item.y + 5);
      ctx.lineTo(item.x + 10, item.y + 5);
      ctx.stroke();
    }
    ctx.fillStyle = theme.muted;
    ctx.fillText(item.label, item.x + (item.color == null ? 0 : 14), item.y + 8);
  }
  // Legend swatches change both properties; axes must retain their normal
  // neutral border styling in PNG just as they do in the SVG renderer.
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  // Y ticks.
  ctx.font = TICK_FONT;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const t of p.yTicks) {
    const y = p.plotTop + p.plotHeight - ((t - p.yMin) / (p.yMax - p.yMin || 1)) * p.plotHeight;
    if (y < p.plotTop - 0.5 || y > p.plotBottom + 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(p.plotLeft, y);
    ctx.lineTo(p.plotLeft - 4, y);
    ctx.stroke();
    ctx.fillText(fmtTick(t), p.plotLeft - 6, y);
  }
  // X ticks.
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const t of p.xTicks) {
    const x = p.plotLeft + ((t - p.xMin) / (p.xMax - p.xMin || 1)) * p.plotWidth;
    if (x < p.plotLeft - 0.5 || x > p.plotRight + 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(x, p.plotBottom);
    ctx.lineTo(x, p.plotBottom + 4);
    ctx.stroke();
    ctx.fillText(fmtTick(t), x, p.plotBottom + 6);
  }
  // X label.
  ctx.font = TITLE_FONT;
  ctx.fillStyle = theme.fg;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(p.xLabel, p.plotLeft + p.plotWidth / 2, p.plotBottom + 32);
  // Traces.
  for (const tr of p.traces) {
    if (tr.pts.length === 0) continue;
    ctx.strokeStyle = tr.color;
    ctx.lineWidth = tr.width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (tr.mode === "stick") {
      const baseY = p.plotBottom;
      ctx.beginPath();
      for (const [x, y] of tr.pts) {
        ctx.moveTo(x, baseY);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else {
      ctx.beginPath();
      const [firstX, firstY] = tr.pts[0];
      ctx.moveTo(firstX, firstY);
      for (let i = 1; i < tr.pts.length; i += 1) ctx.lineTo(tr.pts[i][0], tr.pts[i][1]);
      ctx.stroke();
    }
  }
  // Labels + leader lines.
  ctx.font = LABEL_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (let i = 0; i < p.placed.length; i += 1) {
    const lab = p.placed[i];
    const box = p.boxes[i];
    const boxCenterX = lab.x + box.w / 2;
    const boxBottom = lab.y + box.h;
    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(lab.anchorX, lab.anchorY);
    ctx.lineTo(boxCenterX, boxBottom);
    ctx.stroke();
    ctx.fillStyle = lab.color ?? theme.fg;
    for (let li = 0; li < lab.lines.length; li += 1) {
      const ly = lab.y + (li + 1) * LABEL_LINE_HEIGHT - 2;
      ctx.fillText(lab.lines[li], boxCenterX, ly);
    }
  }
  ctx.restore();
}

export function renderReportPng(
  top: ReportPanelSpec | null,
  bottom: ReportPanelSpec,
  opts: { width: number; height: number; scale: number; theme: ReportTheme },
): string {
  const { width, height, scale, theme } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.scale(scale, scale);
  // Background.
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
  const { topL, botL } = twoPanels(top, bottom, width, height);
  if (topL) canvasPanel(ctx, topL, theme);
  canvasPanel(ctx, botL, theme);
  return canvas.toDataURL("image/png");
}
