// Export & project I/O for the DSC workspace (WP8). Mirrors `lib/tga/export.ts`
// almost exactly — same CSV/Excel/PDF/project shape, same private plumbing —
// with the differences DSC's data model forces:
//
//  - A DSC run carries several SEGMENTS (heat/cool/heat/cool), not one curve.
//    The "processed curves" CSV therefore emits one block per RUN × SEGMENT
//    (via `segmentView`/`computeDerivative`, recomputed here rather than read
//    off the store's cached `analysis`, which only ever covers the run's
//    ACTIVE segment). The Excel workbook stays one sheet per RUN — its
//    ACTIVE segment, exactly what `DscRunAnalyzed.analysis` already carries —
//    which is what "one per run(-segment)" in the plan means: one sheet per
//    run, decorated with which segment it shows.
//  - Heat flow's unit is not fixed the way TGA's weight (%) is: it's "W/g"
//    when `params.normMode === "wattsPerGram"` and "mW" in raw mode. Every
//    unit string below is read off `params`, never hardcoded — the bug this
//    guards against is real: an earlier TGA revision hardcoded "%/°C" in the
//    curves CSV and silently ignored `params.dtgUnit`.
//  - `.dscproj` round-trips `DscState` (files/runs/materials/params/
//    references) rather than TGA's blank-run correction.
//
// Everything stays client-side: CSV/JSON built in memory and offered as
// downloads; the Excel workbook is written with ExcelJS and post-processed
// with the shared `injectCharts` helper for native, editable charts; the PDF
// report is jsPDF, mirroring `lib/maldi/export.ts`'s `exportReportPdf`.

import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import { injectCharts, type ChartSpec } from "@/lib/maldi/excelChartInject";
import { triggerDownload } from "@/lib/ir/export";
import { downsample } from "@/lib/gcms/view";
import type { FigureOptions } from "@/lib/ir/figure";
import {
  buildSummaryRows,
  dscMetrics,
  type DscMetric,
  type DscSummaryRow,
} from "./compare";
import {
  computeDerivative,
  exoDisplaySign,
  oxidativeInductionTime,
  peakTransition,
  resolveGlassResult,
  segmentView,
  type SegmentView,
} from "./compute";
import { ascendingView } from "./numerics";
import type { DscState } from "./store-core";
import type { DscRunAnalyzed } from "./store";
import {
  DEFAULT_PARAMS,
  type DscMaterial,
  type DscParams,
  type DscRun,
  type DscSegment,
} from "./types";

// --- small shared plumbing ---------------------------------------------------

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function safeName(name: string): string {
  return (name || "dsc").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "dsc";
}

function csvCell(value: string | number | undefined | null): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV text. CRLF line endings, so Excel on Windows opens it cleanly. */
export function toCsv(rows: (string | number | undefined | null)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function downloadText(text: string, filename: string, mime = "text/plain"): void {
  triggerDownload(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

/** A finite number rounded for output, or "" so a CSV/sheet shows a blank
 *  rather than "NaN". */
function cell(v: number | null | undefined, decimals: number): number | "" {
  if (v == null || !Number.isFinite(v)) return "";
  return Number(v.toFixed(decimals));
}

/** Short display label for a segment: "Heat 2", "Cool 1", "Isothermal 1". */
function segmentShortLabel(seg: DscSegment): string {
  const word =
    seg.kind === "heat" ? "Heat" : seg.kind === "cool" ? "Cool" : seg.kind === "isothermal" ? "Isothermal" : "Segment";
  return `${word} ${seg.ordinal}`;
}

/** The unit heat flow is shown in, read from `params` rather than hardcoded —
 *  "W/g" once normalized by sample mass, "mW" in raw mode. */
function heatFlowUnit(params: DscParams): string {
  return params.normMode === "raw" ? "mW" : "W/g";
}

/** The derivative's unit, likewise read off `params.normMode`. */
function derivUnit(params: DscParams): string {
  return params.normMode === "raw" ? "mW/°C" : "W/g·°C";
}

// --- CSV ---------------------------------------------------------------------

/** One run × segment's worth of curve data, built fresh with `segmentView` so
 *  every segment is covered — not just the run's cached, active-segment-only
 *  `analysis`. */
interface CurveBlock {
  run: DscRunAnalyzed;
  segment: DscSegment;
  view: SegmentView;
  deriv: Float64Array;
  /** Raw file heat flow (mW), same ascending order and display sign as
   *  `view.heatFlow`, so the two columns line up point-for-point. */
  rawMw: Float64Array;
}

function buildCurveBlocks(runs: DscRunAnalyzed[], params: DscParams): CurveBlock[] {
  const blocks: CurveBlock[] = [];
  for (const run of runs) {
    const sign = exoDisplaySign(run, params);
    for (const segment of run.segments) {
      const view = segmentView(run, segment, params);
      if (view.tempC.length === 0) continue;
      const deriv = computeDerivative(view, params.smoothWindow);
      const rawAsc = ascendingView(run.heatFlowMw, view.segStart, view.segEnd, view.reversed);
      const rawMw = new Float64Array(rawAsc.length);
      for (let i = 0; i < rawMw.length; i += 1) rawMw[i] = sign * rawAsc[i];
      blocks.push({ run, segment, view, deriv, rawMw });
    }
  }
  return blocks;
}

/**
 * Every visible run's processed curves, laid out as side-by-side five-column
 * blocks (Time / Temperature / Heat flow [raw mW] / Heat flow [normalized] /
 * Deriv. heat flow) — one block per run × SEGMENT, with the run + segment
 * name above each. Blocks of different lengths are padded with blanks.
 *
 * ⚠️ The normalized-heat-flow and derivative units are read off
 * `params.normMode`, not hardcoded — see this file's header comment.
 */
export function buildCurvesCsvRows(
  runs: DscRunAnalyzed[],
  params: DscParams,
): (string | number | "")[][] {
  const cols = 5;
  const blocks = buildCurveBlocks(runs, params);
  const unit = heatFlowUnit(params);
  const dUnit = derivUnit(params);

  const titles: (string | number | "")[] = [];
  const headers: (string | number | "")[] = [];
  const units: (string | number | "")[] = [];
  for (const b of blocks) {
    titles.push(`${b.run.label} — ${segmentShortLabel(b.segment)}`, "", "", "", "");
    headers.push("Time", "Temperature", "Heat flow", "Heat flow", "Deriv. heat flow");
    units.push("min", "°C", "mW", unit, dUnit);
  }
  const maxLen = blocks.reduce((m, b) => Math.max(m, b.view.tempC.length), 0);
  const rows: (string | number | "")[][] = [titles, headers, units];
  for (let i = 0; i < maxLen; i += 1) {
    const row: (string | number | "")[] = [];
    for (const b of blocks) {
      if (i >= b.view.tempC.length) {
        row.push(...Array<"">(cols).fill(""));
        continue;
      }
      row.push(
        cell(b.view.timeMin[i], 5),
        cell(b.view.tempC[i], 4),
        cell(b.rawMw[i], 5),
        cell(b.view.heatFlow[i], 5),
        cell(b.deriv[i], 6),
      );
    }
    rows.push(row);
  }
  return rows;
}

/** Download the processed curves of the given runs (every segment) as one CSV. */
export function downloadCurvesCsv(runs: DscRunAnalyzed[], params: DscParams, baseName = "dsc"): void {
  downloadText(
    toCsv(buildCurvesCsvRows(runs, params)),
    `${safeName(baseName)}-curves-${timestampSlug()}.csv`,
    "text/csv",
  );
}

/**
 * Every run's transitions (user + auto features, across EVERY segment — not
 * just the active one) as CSV rows. Each feature's result is recomputed with
 * `segmentView` + the same pure analyzers the store uses
 * (`resolveGlassResult`/`peakTransition`/`oxidativeInductionTime`), because
 * the store's cached `analysis.results` only covers the run's active
 * segment. Glass goes through `resolveGlassResult` rather than
 * `glassTransition` directly — a bare `glassTransition` call here would
 * silently drop a hand-set `manualMidpointC` from the CSV/Excel/PDF exports
 * (all three reuse this builder) even though the on-screen Tg reads it.
 *
 * An OIT feature has no window/onset in °C — its `window`/onset are minutes
 * on an isothermal hold. The fixed column schema has no dedicated OIT
 * columns, so an OIT row reuses "Onset (°C)" for the onset time (min) and
 * "Midpoint/Peak (°C)" for the induction time itself (min); ΔH/Δcp/FWHM stay
 * blank for it, same as for a glass transition.
 */
export function buildTransitionsCsvRows(
  runs: DscRunAnalyzed[],
  params: DscParams,
): (string | number | "")[][] {
  const header: (string | number | "")[] = [
    "Run",
    "Segment",
    "Kind",
    "Label",
    "Window lo (°C)",
    "Window hi (°C)",
    "Onset (°C)",
    "Midpoint/Peak (°C)",
    "Endset (°C)",
    "ΔH (J/g)",
    "ΔH (mJ)",
    "Δcp (J/g·°C)",
    "FWHM (°C)",
  ];
  const body: (string | number | "")[][] = [];
  for (const run of runs) {
    for (const feature of run.features) {
      const segment = run.segments.find((s) => s.id === feature.segmentId);
      if (!segment) continue;
      const view = segmentView(run, segment, params);

      let onset: number | null = null;
      let mid: number | null = null;
      let endset: number | null = null;
      let dhJPerG: number | null = null;
      let dhMj: number | null = null;
      let deltaCp: number | null = null;
      let fwhmC: number | null = null;

      if (feature.kind === "glass") {
        const g = resolveGlassResult(view, feature);
        onset = g.onsetC;
        mid = g.midpointC;
        endset = g.endsetC;
        deltaCp = g.deltaCp;
      } else if (feature.kind === "oit") {
        const o = oxidativeInductionTime(view, feature.window[0]);
        onset = o.onsetMin;
        mid = o.oitMin;
      } else {
        const anchors = feature.baseline ?? feature.window;
        const p = peakTransition(view, run, feature.window, anchors);
        onset = p.onsetC;
        mid = p.peakC;
        endset = p.endsetC;
        dhJPerG = p.enthalpyJPerG;
        dhMj = p.areaMj;
        fwhmC = p.fwhmC;
      }

      body.push([
        run.label,
        segmentShortLabel(segment),
        feature.kind,
        feature.label,
        cell(feature.window[0], 2),
        cell(feature.window[1], 2),
        cell(onset, 2),
        cell(mid, 2),
        cell(endset, 2),
        cell(dhJPerG, 3),
        cell(dhMj, 4),
        cell(deltaCp, 4),
        cell(fwhmC, 2),
      ]);
    }
  }
  return [header, ...body];
}

/** Download every run's transitions as CSV. */
export function downloadTransitionsCsv(runs: DscRunAnalyzed[], params: DscParams, baseName = "dsc"): void {
  downloadText(
    toCsv(buildTransitionsCsvRows(runs, params)),
    `${safeName(baseName)}-transitions-${timestampSlug()}.csv`,
    "text/csv",
  );
}

/** Summary table rows (one per run) as CSV rows, metric columns included. */
export function buildSummaryCsvRows(
  rows: DscSummaryRow[],
  metrics: DscMetric[],
): (string | number | "")[][] {
  const header: (string | number | "")[] = [
    "Run",
    "Material",
    "File",
    "Segment",
    ...metrics.map((m) => `${m.label} (${m.unit})`),
  ];
  const body = rows.map((r) => [
    r.label,
    r.materialName,
    r.fileName,
    r.segmentLabel,
    ...metrics.map((m) => cell(r.values[m.key], m.decimals)),
  ]);
  return [header, ...body];
}

/** Download the cross-run summary as CSV. */
export function downloadSummaryCsv(
  rows: DscSummaryRow[],
  metrics: DscMetric[],
  baseName = "dsc",
): void {
  downloadText(
    toCsv(buildSummaryCsvRows(rows, metrics)),
    `${safeName(baseName)}-summary-${timestampSlug()}.csv`,
    "text/csv",
  );
}

// --- Excel -------------------------------------------------------------------

/**
 * Excel's own ceiling on points in one chart data series. A run's active
 * segment at or under it is charted at FULL resolution straight off its data
 * sheet — no second, thinned copy of the curve anywhere in the workbook. Only
 * a segment longer than this gets a decimated copy (in spare columns on its
 * own sheet) for the chart to read, because Excel would otherwise silently
 * drop the overflow.
 */
const EXCEL_MAX_CHART_POINTS = 32000;

/** Where one run's chart series live: which sheet holds them, the A1 ranges
 *  on it, and the run's own data extents so a single-run chart can scale to
 *  itself rather than to the whole workbook. */
interface DscChartBlock {
  label: string;
  color: string;
  sheet: string;
  /** Zero-based column the run sheet's own charts anchor at, clear of its data. */
  anchorCol: number;
  xRange: string;
  hfRange: string;
  dRange: string;
  /** [min, max] of temperature, normalized heat flow and derivative. */
  tExtent: [number, number];
  hfExtent: [number, number];
  dExtent: [number, number];
}

/** [min, max] over the finite entries of one signal. */
function arrayExtent(src: Float64Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < src.length; i += 1) {
    const v = src[i];
    if (!Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return [lo, hi];
}

/** The combined extent of one quantity across blocks; [0, 1] when nothing is
 *  finite, so an axis is never written as NaN. */
function unionExtent(blocks: DscChartBlock[], key: "tExtent" | "hfExtent" | "dExtent"): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of blocks) {
    lo = Math.min(lo, b[key][0]);
    hi = Math.max(hi, b[key][1]);
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : [0, 1];
}

/** Round outwards to a whole number, for axis bounds that land on a tick. */
function roundOut(v: number, up: boolean): number {
  return Number.isFinite(v) ? Number((up ? Math.ceil(v) : Math.floor(v)).toFixed(4)) : 0;
}

/** Derivative values are small (~0.01-0.1 W/g·°C), so whole-number rounding
 *  would collapse the axis to 0–1 and flatten the curve; pad the real range
 *  instead, with a 0.001 floor so a near-flat derivative still gets a
 *  readable axis. */
function derivBounds([lo, hi]: [number, number]): { min: number; max: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1 };
  const pad = Math.max(Math.abs(lo), Math.abs(hi)) * 0.1 || 0.001;
  return { min: Number((lo - pad).toFixed(4)), max: Number((hi + pad).toFixed(4)) };
}

/** Charts are 16 rows tall (see `buildDrawingXml`), so 18 leaves a two-row gap
 *  and a row for each one's caption. */
const CHART_ROW_PITCH = 18;

/** The three captions naming a trio, for whatever the trio covers. */
function chartCaptions(subject: string): [string, string, string] {
  return [
    `${subject} — heat flow (W/g)`,
    `${subject} — derivative`,
    `${subject} — heat flow + derivative (right axis)`,
  ];
}

/**
 * Three charts over one set of curves: heat flow, derivative heat flow, and
 * the two together on a shared temperature axis with the derivative on a
 * secondary right-hand axis — without that second axis the derivative, one
 * to two orders of magnitude smaller, would draw as a flat line on zero.
 *
 * Called once per run against that run's own block, so every sample carries
 * its own set beside its own data, and once more with every block at once
 * for the overlaid versions on the Charts sheet. Mirrors `tgaChartTrio`.
 */
function dscChartTrio(args: {
  sheetName: string;
  blocks: DscChartBlock[];
  anchorCol: number;
  /** Zero-based row the first chart anchors at; the next two follow below it. */
  firstRow: number;
}): ChartSpec[] {
  const { sheetName, blocks, anchorCol, firstRow } = args;
  if (blocks.length === 0) return [];
  const t = unionExtent(blocks, "tExtent");
  const hf = unionExtent(blocks, "hfExtent");
  const d = derivBounds(unionExtent(blocks, "dExtent"));
  const yTitle = "Heat flow (W/g)";
  const y2Title = "Deriv. heat flow (W/g·°C)";
  const hfSeries = blocks.map((b) => ({
    name: b.label,
    sheet: b.sheet,
    xRange: b.xRange,
    yRange: b.hfRange,
    color: b.color,
  }));
  const dSeries = blocks.map((b) => ({
    name: `${b.label} — deriv.`,
    sheet: b.sheet,
    xRange: b.xRange,
    yRange: b.dRange,
    color: b.color,
  }));
  const common = {
    sheetName,
    // Superseded by `series`, but required by the single-series ChartSpec shape.
    seriesName: "",
    xRange: "",
    yRange: "",
    xMin: roundOut(t[0], false),
    xMax: roundOut(t[1], true),
    xTitle: "Temperature (°C)",
    xNumFmt: "0",
    anchorCol,
  };
  // Plain solid lines, no markers, no trendline — DSC curves are dense
  // traces, not the sparse fitted points MALDI's defaults are shaped for. A
  // legend only earns its space once there is more than one curve.
  const style = (legend: boolean) => ({ line: "solid", markers: false, trendline: false, legend }) as const;
  const hfMin = roundOut(hf[0], false);
  const hfMax = roundOut(hf[1], true);
  return [
    {
      ...common,
      series: hfSeries,
      yMin: hfMin,
      yMax: hfMax,
      yTitle,
      yNumFmt: "0.00",
      style: style(hfSeries.length > 1),
      anchorRow: firstRow,
    },
    {
      ...common,
      series: dSeries,
      yMin: d.min,
      yMax: d.max,
      yTitle: y2Title,
      yNumFmt: "0.000",
      style: style(dSeries.length > 1),
      anchorRow: firstRow + CHART_ROW_PITCH,
    },
    {
      ...common,
      // Same curves again, the derivatives moved to the right axis and
      // dashed so each run's pair reads as one colour in two line styles.
      series: [...hfSeries, ...dSeries.map((s) => ({ ...s, axis: "y2" as const, dash: true }))],
      yMin: hfMin,
      yMax: hfMax,
      yTitle,
      yNumFmt: "0.00",
      y2Min: d.min,
      y2Max: d.max,
      y2Title,
      y2NumFmt: "0.000",
      style: style(true),
      anchorRow: firstRow + CHART_ROW_PITCH * 2,
    },
  ];
}

/** Write a trio's captions on the rows the charts anchor under. */
function addChartCaptions(
  ws: ExcelJS.Worksheet,
  anchorCol: number,
  firstRow: number,
  captions: [string, string, string],
): void {
  captions.forEach((text, i) => {
    // `anchorCol` is zero-based (drawing coordinates); getCell is one-based,
    // so the caption lands in the chart's own column, one row above its top edge.
    const c = ws.getCell(firstRow + i * CHART_ROW_PITCH, anchorCol + 1);
    c.value = text;
    c.font = { bold: true };
  });
}

export interface DscExcelInput {
  runs: DscRunAnalyzed[];
  materials: DscMaterial[];
  params: DscParams;
  /** Optional PNG data URL of the publication figure, embedded on its own sheet. */
  figurePng?: string | null;
  baseName?: string;
}

/**
 * Write the workbook: a Summary sheet, a Transitions sheet, a `Charts` sheet
 * with every run's active segment overlaid, and one full-resolution data
 * sheet per run (its active segment — the same curve `DscPlot`/the Figure tab
 * already show, via `run.analysis.view`/`run.analysis.deriv`). A run with
 * multiple segments still gets every segment's curve in the CSV export
 * (`buildCurvesCsvRows`); the workbook mirrors what the workspace currently
 * displays, one sheet per run, exactly like the TGA workbook.
 *
 * Charts come as a trio — heat flow, derivative heat flow, and the two
 * combined with the derivative on a secondary right-hand axis. Each run's own
 * sheet carries the trio for that run alone, beside its data, and the Charts
 * sheet carries the same trio with every run overlaid.
 *
 * The charts read each run's data sheet DIRECTLY, so every recorded point of
 * the active segment is on the curve and the workbook holds exactly one copy
 * of that data. A run longer than Excel's 32 000-point series limit is the
 * sole exception — see {@link EXCEL_MAX_CHART_POINTS}.
 *
 * Returns the finished .xlsx bytes; {@link exportDscExcel} wraps this with
 * the download. Split so the package can be asserted on in a test without a DOM.
 */
export async function buildDscExcelBuffer(input: DscExcelInput): Promise<Uint8Array> {
  const { runs, materials, params, figurePng } = input;
  const metrics = dscMetrics();
  const summaryRows = buildSummaryRows(runs, materials, metrics);
  const unit = heatFlowUnit(params);
  const dUnit = derivUnit(params);

  const wb = new ExcelJS.Workbook();
  wb.creator = "NMR Predict — DSC";
  wb.created = new Date();

  // --- Summary ---
  const summary = wb.addWorksheet("Summary");
  summary.addRow(["DSC summary"]).font = { bold: true };
  summary.addRow([]);
  summary.addRow(["Smoothing window (points)", params.smoothWindow]);
  summary.addRow(["Min peak enthalpy (J/g)", params.minPeakEnthalpy]);
  summary.addRow(["Exo up", params.exoUp ? "yes" : "no"]);
  summary.addRow(["Normalization", params.normMode]);
  summary.addRow(["Auto-detect transitions", params.autoDetect ? "yes" : "no"]);
  summary.addRow([]);
  const summaryCsvRows = buildSummaryCsvRows(summaryRows, metrics);
  summary.addRow(summaryCsvRows[0]).font = { bold: true };
  for (const row of summaryCsvRows.slice(1)) summary.addRow(row);
  summary.getColumn(1).width = 30;
  summary.getColumn(2).width = 24;
  summary.getColumn(3).width = 24;

  // --- Transitions ---
  const transitionRows = buildTransitionsCsvRows(runs, params);
  const transitions = wb.addWorksheet("Transitions");
  transitions.addRow(transitionRows[0]).font = { bold: true };
  for (const r of transitionRows.slice(1)) transitions.addRow(r);
  transitions.getColumn(1).width = 24;
  transitions.getColumn(4).width = 22;

  // --- The overlay chart sheet, created here so it sits before the data
  //     sheets in the workbook; its charts are anchored further down, once
  //     the ranges they read are known ---
  const chartSheetName = "Charts";
  const chartSheet = wb.addWorksheet(chartSheetName);
  chartSheet.addRow(["DSC charts — every run's active segment overlaid"]).font = { bold: true };
  chartSheet.addRow([
    "Each run's own sheet carries the same three charts for that run alone. Series read the run sheets at full resolution — edit the chart, not the data.",
  ]);

  // --- One data sheet per run (full resolution of its active segment), the
  //     ranges the charts read straight off it, and that run's own charts
  //     beside its data ---
  const usedSheetNames = new Set(["Summary", "Transitions", chartSheetName, "Figure"]);
  const blocks: DscChartBlock[] = [];

  for (const run of runs) {
    // Excel sheet names: 31 chars max, no []:*?/\ and no duplicates.
    let name = run.label.replace(/[[\]:*?/\\]/g, "-").slice(0, 28) || "Run";
    let suffix = 2;
    while (usedSheetNames.has(name)) {
      name = `${name.slice(0, 26)}-${suffix}`;
      suffix += 1;
    }
    usedSheetNames.add(name);
    const ws = wb.addWorksheet(name);

    const view = run.analysis.view;
    const deriv = run.analysis.deriv;
    const n = Math.min(view.tempC.length, view.heatFlow.length, view.timeMin.length, deriv.length);
    const oversized = n > EXCEL_MAX_CHART_POINTS;
    const sign = exoDisplaySign(run, params);
    const rawAsc = ascendingView(run.heatFlowMw, view.segStart, view.segEnd, view.reversed);

    const header = [
      "Time (min)",
      "Temperature (°C)",
      "Heat flow (mW)",
      `Heat flow (${unit})`,
      `Deriv. heat flow (${dUnit})`,
    ];
    // Only an oversized segment pays for a second, thinned copy of its curve.
    const thinned = oversized
      ? (() => {
          const hfDs = downsample({ x: view.tempC.subarray(0, n), y: view.heatFlow.subarray(0, n) }, EXCEL_MAX_CHART_POINTS);
          const dDs = downsample({ x: view.tempC.subarray(0, n), y: deriv.subarray(0, n) }, EXCEL_MAX_CHART_POINTS);
          const m = Math.min(hfDs.x.length, dDs.x.length);
          return { x: hfDs.x, hf: hfDs.y, d: dDs.y, n: m };
        })()
      : null;
    if (thinned) {
      header.push("", "Chart: Temperature (°C)", `Chart: Heat flow (${unit})`, `Chart: Deriv. heat flow (${dUnit})`);
    }
    ws.addRow(header).font = { bold: true };
    for (let i = 0; i < n; i += 1) {
      const row: (string | number | "")[] = [
        cell(view.timeMin[i], 5),
        cell(view.tempC[i], 4),
        cell(sign * rawAsc[i], 5),
        cell(view.heatFlow[i], 5),
        cell(deriv[i], 6),
      ];
      if (thinned) {
        row.push(
          "",
          i < thinned.n ? cell(thinned.x[i], 4) : "",
          i < thinned.n ? cell(thinned.hf[i], 5) : "",
          i < thinned.n ? cell(thinned.d[i], 6) : "",
        );
      }
      ws.addRow(row);
    }
    for (let c = 1; c <= (thinned ? 9 : 5); c += 1) ws.getColumn(c).width = 16;

    // Data starts on sheet row 2 (row 1 is the header).
    const count = thinned ? thinned.n : n;
    if (count > 1) {
      const first = 2;
      const last = first + count - 1;
      // Full resolution: B / D / E. Thinned: G / H / I.
      const [xc, hc, dc] = thinned ? ["G", "H", "I"] : ["B", "D", "E"];
      blocks.push({
        label: run.label,
        color: run.color,
        sheet: name,
        // Clear of the data — column K when the thinned chart columns are
        // present (A–I), column G when they are not (A–E).
        anchorCol: thinned ? 10 : 6,
        xRange: `${xc}${first}:${xc}${last}`,
        hfRange: `${hc}${first}:${hc}${last}`,
        dRange: `${dc}${first}:${dc}${last}`,
        // The run's own extents, so its own charts scale to itself.
        tExtent: arrayExtent(view.tempC.subarray(0, n)),
        hfExtent: arrayExtent(view.heatFlow.subarray(0, n)),
        dExtent: arrayExtent(deriv.subarray(0, n)),
      });
    }
  }

  // --- The charts: the overlaid trio on the Charts sheet, then a trio per
  //     run on that run's own sheet. Overlays come first so they take the
  //     low chart numbers, which is also the order a reader meets them in. ---
  const chartSpecs: ChartSpec[] = [];
  if (blocks.length > 0) {
    const overlayFirstRow = 3;
    addChartCaptions(chartSheet, 1, overlayFirstRow, chartCaptions("All runs"));
    chartSpecs.push(
      ...dscChartTrio({ sheetName: chartSheetName, blocks, anchorCol: 1, firstRow: overlayFirstRow }),
    );
    for (const block of blocks) {
      const ws = wb.getWorksheet(block.sheet);
      if (!ws) continue;
      addChartCaptions(ws, block.anchorCol, 1, chartCaptions(block.label));
      chartSpecs.push(
        ...dscChartTrio({ sheetName: block.sheet, blocks: [block], anchorCol: block.anchorCol, firstRow: 1 }),
      );
    }
  }

  // --- Figure image ---
  if (figurePng) {
    const figSheet = wb.addWorksheet("Figure");
    const imageId = wb.addImage({
      base64: figurePng.replace(/^data:image\/png;base64,/, ""),
      extension: "png",
    });
    figSheet.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 900, height: 675 } });
  }

  const raw = new Uint8Array(await wb.xlsx.writeBuffer());
  // Always run the injector — even with an empty `chartSpecs` — because it
  // also repairs the drawing ExcelJS writes for an embedded image, which
  // Excel otherwise reports as a repaired record.
  return injectCharts(raw, chartSpecs);
}

/** Build the workbook and hand it to the browser as a download. */
export async function exportDscExcel(input: DscExcelInput): Promise<void> {
  const buffer = await buildDscExcelBuffer(input);
  triggerDownload(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    `${safeName(input.baseName ?? "dsc")}-report-${timestampSlug()}.xlsx`,
  );
}

// --- PDF ---------------------------------------------------------------------

export interface DscPdfInput {
  runs: DscRunAnalyzed[];
  materials: DscMaterial[];
  params: DscParams;
  /** PNG data URL of the publication figure, drawn under the header. */
  figurePng?: string | null;
  projectName?: string;
}

/** A simple bordered table writer: returns the y the caller should continue at. */
function pdfTable(
  doc: jsPDF,
  startY: number,
  margin: number,
  colWidths: number[],
  header: string[],
  body: (string | number)[][],
  pageHeight: number,
): number {
  const rowH = 13;
  let y = startY;
  const drawHeader = () => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    let x = margin;
    for (let i = 0; i < header.length; i += 1) {
      doc.text(String(header[i]), x, y);
      x += colWidths[i];
    }
    y += 4;
    doc.setDrawColor(200);
    doc.line(margin, y, margin + colWidths.reduce((a, b) => a + b, 0), y);
    y += rowH - 4;
    doc.setFont("helvetica", "normal");
  };
  drawHeader();
  for (const row of body) {
    if (y > pageHeight - 50) {
      doc.addPage();
      y = 50;
      drawHeader();
    }
    let x = margin;
    for (let i = 0; i < row.length; i += 1) {
      doc.text(String(row[i] ?? ""), x, y);
      x += colWidths[i];
    }
    y += rowH;
  }
  return y;
}

/** Generate a PDF report: parameters, the figure, the summary table, and
 *  every run's detected transitions. */
export function exportDscReportPdf(input: DscPdfInput): void {
  const { runs, materials, params, figurePng, projectName = "DSC analysis" } = input;
  const metrics = dscMetrics();
  const summaryRows = buildSummaryRows(runs, materials, metrics);

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("DSC Report", margin, y);
  y += 20;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(
    `${projectName}   •   ${runs.length} run${runs.length === 1 ? "" : "s"}   •   ${new Date().toLocaleString()}`,
    margin,
    y,
  );
  y += 13;
  doc.text(
    `Normalization: ${params.normMode}   •   Smoothing: ${params.smoothWindow} pts   •   Min peak ΔH: ${params.minPeakEnthalpy} J/g   •   Exo up: ${params.exoUp ? "yes" : "no"}`,
    margin,
    y,
  );
  doc.setTextColor(0);
  y += 18;

  if (figurePng) {
    const imgWidth = contentWidth;
    const imgHeight = imgWidth * 0.72;
    if (y + imgHeight > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
    // `"FAST"` matters here: without it jsPDF embeds the raster verbatim and
    // a 1600x1200 figure turns a two-page report into a ~7 MB file.
    doc.addImage(figurePng, "PNG", margin, y, imgWidth, imgHeight, undefined, "FAST");
    y += imgHeight + 18;
  }

  // Summary table.
  if (y > pageHeight - 120) {
    doc.addPage();
    y = margin;
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Summary", margin, y);
  y += 16;
  const labelWidth = Math.max(80, contentWidth - 34 * metrics.length);
  const summaryHeader = ["Run", ...metrics.map((m) => `${m.label} (${m.unit})`)];
  const summaryWidths = [labelWidth, ...metrics.map(() => 34)];
  y = pdfTable(
    doc,
    y,
    margin,
    summaryWidths,
    summaryHeader,
    summaryRows.map((r) => [
      r.label.length > 18 ? `${r.label.slice(0, 17)}…` : r.label,
      ...metrics.map((m) => {
        const v = r.values[m.key];
        return Number.isFinite(v) ? v.toFixed(m.decimals) : "—";
      }),
    ]),
    pageHeight,
  );
  y += 14;

  // Transitions table (condensed — the CSV/Excel carry every column).
  const transitionRows = buildTransitionsCsvRows(runs, params);
  if (transitionRows.length > 1) {
    if (y > pageHeight - 120) {
      doc.addPage();
      y = margin;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Transitions", margin, y);
    y += 16;
    const widths = [90, 46, 56, 76, 50, 55, 50, 50];
    pdfTable(
      doc,
      y,
      margin,
      widths,
      ["Run", "Segment", "Kind", "Label", "Onset °C", "Mid/Peak °C", "Endset °C", "ΔH J/g"],
      transitionRows.slice(1).map((r) => [
        String(r[0]).length > 16 ? `${String(r[0]).slice(0, 15)}…` : String(r[0]),
        String(r[1]),
        String(r[2]),
        String(r[3]).length > 12 ? `${String(r[3]).slice(0, 11)}…` : String(r[3]),
        String(r[6] === "" ? "—" : r[6]),
        String(r[7] === "" ? "—" : r[7]),
        String(r[8] === "" ? "—" : r[8]),
        String(r[9] === "" ? "—" : r[9]),
      ]),
      pageHeight,
    );
  }

  doc.save(`${safeName(projectName)}-report-${timestampSlug()}.pdf`);
}

// --- Project JSON (.dscproj) --------------------------------------------------

/** A run with its typed arrays flattened to plain number[] for JSON. */
interface SerializableDscRun
  extends Omit<DscRun, "timeMin" | "tempC" | "heatFlowMw" | "heatFlowNormFile"> {
  timeMin: number[];
  tempC: number[];
  heatFlowMw: number[];
  heatFlowNormFile?: number[];
}

/** The on-disk shape of a `.dscproj` file. */
export interface DscProjectRecord {
  version: 1;
  savedAt: string;
  state: Omit<DscState, "runs"> & { runs: SerializableDscRun[] };
  /** The publication figure's styling, so a reopened project looks identical. */
  figureOptions?: FigureOptions | null;
}

/** Pick exactly the persisted fields. Deliberately NOT a spread of `run`: the
 *  store hands out `DscRunAnalyzed` in places, and spreading would drag the
 *  derived `analysis` (the segment view + every feature result) into the
 *  project file. */
function serializeRun(run: DscRun): SerializableDscRun {
  return {
    id: run.id,
    fileId: run.fileId,
    fileName: run.fileName,
    label: run.label,
    color: run.color,
    meta: run.meta,
    segments: run.segments,
    scale: run.scale,
    offset: run.offset,
    visible: run.visible,
    materialId: run.materialId,
    activeSegmentId: run.activeSegmentId,
    massOverrideMg: run.massOverrideMg,
    polymerFraction: run.polymerFraction,
    referenceId: run.referenceId,
    features: run.features,
    timeMin: Array.from(run.timeMin),
    tempC: Array.from(run.tempC),
    heatFlowMw: Array.from(run.heatFlowMw),
    ...(run.heatFlowNormFile ? { heatFlowNormFile: Array.from(run.heatFlowNormFile) } : {}),
  };
}

function deserializeRun(run: SerializableDscRun): DscRun {
  return {
    id: run.id,
    fileId: run.fileId,
    fileName: run.fileName,
    label: run.label,
    color: run.color,
    meta: run.meta,
    segments: run.segments,
    scale: run.scale,
    offset: run.offset,
    visible: run.visible,
    materialId: run.materialId,
    activeSegmentId: run.activeSegmentId,
    massOverrideMg: run.massOverrideMg,
    polymerFraction: run.polymerFraction,
    referenceId: run.referenceId,
    features: run.features,
    timeMin: Float64Array.from(run.timeMin ?? []),
    tempC: Float64Array.from(run.tempC ?? []),
    heatFlowMw: Float64Array.from(run.heatFlowMw ?? []),
    ...(run.heatFlowNormFile ? { heatFlowNormFile: Float64Array.from(run.heatFlowNormFile) } : {}),
  };
}

/** Serialize the workspace to `.dscproj` JSON text. */
export function serializeDscProject(state: DscState, figureOptions?: FigureOptions | null): string {
  const record: DscProjectRecord = {
    version: 1,
    savedAt: new Date().toISOString(),
    state: { ...state, runs: state.runs.map(serializeRun) },
    figureOptions: figureOptions ?? null,
  };
  return JSON.stringify(record);
}

/** Parse a `.dscproj` file. Throws with a readable message on anything that
 *  isn't a DSC project, so the caller can surface it as a toast. */
export function deserializeDscProject(text: string): {
  state: DscState;
  figureOptions: FigureOptions | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Not a valid .dscproj file (unreadable JSON).");
  }
  const record = parsed as Partial<DscProjectRecord>;
  if (!record || typeof record !== "object" || !record.state || !Array.isArray(record.state.runs)) {
    throw new Error("Not a DSC project file.");
  }
  const s = record.state;
  return {
    state: {
      files: s.files ?? [],
      runs: s.runs.map(deserializeRun),
      materials: s.materials ?? [],
      params: { ...DEFAULT_PARAMS, ...s.params },
      references: s.references ?? [],
    },
    figureOptions: record.figureOptions ?? null,
  };
}

/** Download the workspace as a `.dscproj` file. */
export function downloadDscProject(
  state: DscState,
  figureOptions: FigureOptions | null,
  baseName = "dsc",
): void {
  downloadText(
    serializeDscProject(state, figureOptions),
    `${safeName(baseName)}-${timestampSlug()}.dscproj`,
    "application/json",
  );
}
