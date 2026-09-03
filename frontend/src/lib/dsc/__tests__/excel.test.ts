// The Excel workbook is the export with the most that can silently go wrong:
// a malformed chart part doesn't error, Excel just drops the chart. These
// assertions stand in for opening the file — the package must reload in
// ExcelJS, carry a chart part per chart, and point them at real ranges on the
// runs' own data sheets, at FULL resolution. Mirrors
// `lib/tga/__tests__/excel.test.ts` closely.
//
// Layout under test: a trio of charts (heat flow, derivative, and the two
// combined on a secondary axis) with every run's active segment overlaid on
// the Charts sheet, then the same trio for each run alone on that run's own
// data sheet (columns B/D/E: Temperature / Heat flow (W/g) / Deriv. heat flow).

import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { buildDscExcelBuffer } from "../export";
import { computeDscAnalysis } from "../compute";
import { DEFAULT_PARAMS, type DscMaterial, type DscMetadata, type DscRun, type DscSegment } from "../types";
import type { DscRunAnalyzed } from "../store";

function makeRun(id: string, color: string, points = 400): DscRunAnalyzed {
  const rate = 10;
  const t0 = 25;
  const t1 = 300;
  const dTc = (t1 - t0) / (points - 1);
  const dtMin = dTc / rate;
  const timeMin = new Float64Array(points);
  const tempC = new Float64Array(points);
  const heatFlowMw = new Float64Array(points);
  for (let i = 0; i < points; i += 1) {
    const T = t0 + i * dTc;
    timeMin[i] = i * dtMin;
    tempC[i] = T;
    // A baseline plus a small endothermic bump, so the derivative isn't a
    // flat line — sampleMassMg is 1, so this mW array numerically equals W/g.
    heatFlowMw[i] = 0.01 * T - 0.3 * Math.exp(-((T - 180) ** 2) / (2 * 10 ** 2));
  }
  const segment: DscSegment = {
    id: `${id}:seg0`,
    label: `Ramp ${rate} °C/min to ${t1} °C`,
    kind: "heat",
    rateCPerMin: rate,
    ordinal: 1,
    cycle: 1,
    start: 0,
    end: points,
    tStartC: tempC[0],
    tEndC: tempC[points - 1],
    timeStartMin: timeMin[0],
    timeEndMin: timeMin[points - 1],
  };
  const meta: DscMetadata = {
    instrument: "DSC25",
    operator: "",
    sampleName: id,
    sampleMassMg: 1,
    panMassMg: 0,
    pan: "Tzero Aluminum Hermetic",
    methodSteps: [segment.label],
    runDate: "",
    gases: "N2",
    cooler: "",
    cellConstant: "",
    sampleInterval: "",
    exoDirection: "up",
  };
  const run: DscRun = {
    label: id,
    meta,
    segments: [segment],
    timeMin,
    tempC,
    heatFlowMw,
    id,
    fileId: "f1",
    fileName: `${id}.tri`,
    color,
    scale: 1,
    offset: 0,
    visible: true,
    materialId: "m1",
    activeSegmentId: segment.id,
    massOverrideMg: null,
    polymerFraction: 1,
    referenceId: null,
    features: [],
  };
  return { ...run, analysis: computeDscAnalysis(run, DEFAULT_PARAMS) };
}

const materials: DscMaterial[] = [{ id: "m1", name: "Blend", runIds: ["A", "B"] }];

describe("buildDscExcelBuffer", () => {
  it("produces a package ExcelJS can reload, with every sheet", async () => {
    const buffer = await buildDscExcelBuffer({
      runs: [makeRun("A", "#2563eb"), makeRun("B", "#dc2626")],
      materials,
      params: DEFAULT_PARAMS,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("Summary");
    expect(names).toContain("Transitions");
    expect(names).toContain("Charts");
    // One full-resolution data sheet per run (its active segment).
    expect(names).toContain("A");
    expect(names).toContain("B");
  });

  it("overlays every run in a trio of charts on the Charts sheet", async () => {
    const buffer = await buildDscExcelBuffer({
      runs: [makeRun("A", "#2563eb"), makeRun("B", "#dc2626")],
      materials,
      params: DEFAULT_PARAMS,
    });
    const zip = await JSZip.loadAsync(buffer);
    // Three overlays plus a trio for each of the two runs.
    const charts = Object.keys(zip.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n));
    expect(charts).toHaveLength(9);

    // The overlays are written first, so they take chart1..chart3.
    const [heatFlow, deriv, combined] = await Promise.all(
      [1, 2, 3].map((i) => zip.file(`xl/charts/chart${i}.xml`)!.async("string")),
    );
    expect(heatFlow).toContain("Temperature (");
    expect(heatFlow).toContain("Heat flow (W/g)");
    expect(heatFlow).not.toContain("Deriv. heat flow");
    expect(deriv).toContain("Deriv. heat flow");
    // The combined chart carries both quantities, the derivative on its own
    // right-hand axis — four axes rather than two.
    expect(combined).toContain("Heat flow (W/g)");
    expect(combined).toContain("Deriv. heat flow");
    expect([...combined.matchAll(/<c:valAx>/g)]).toHaveLength(4);
    expect(combined).toContain('<c:axPos val="r"/>');

    // One series per run on the single-quantity charts, two per run combined
    // — each reading that run's OWN sheet across every data row (400 points
    // -> rows 2..401), in the run's colour, named after the run.
    expect([...heatFlow.matchAll(/<c:ser>/g)]).toHaveLength(2);
    expect([...deriv.matchAll(/<c:ser>/g)]).toHaveLength(2);
    expect([...combined.matchAll(/<c:ser>/g)]).toHaveLength(4);
    for (const chart of [heatFlow, deriv, combined]) {
      expect(chart).toContain("'A'!$B$2:$B$401");
      expect(chart).toContain("'B'!$B$2:$B$401");
      expect(chart).toContain('<a:srgbClr val="2563EB"/>');
      expect(chart).toContain('<a:srgbClr val="DC2626"/>');
      // DSC curves are plain lines: no MALDI markers or trendline.
      expect(chart).not.toContain("<c:trendline>");
      expect(chart).toContain("<c:legend>");
    }
    // Heat flow reads column D, the derivative column E, and the combined both.
    expect(heatFlow).toContain("'A'!$D$2:$D$401");
    expect(heatFlow).not.toContain("$E$2:$E$401");
    expect(deriv).toContain("'A'!$E$2:$E$401");
    expect(combined).toContain("'A'!$D$2:$D$401");
    expect(combined).toContain("'A'!$E$2:$E$401");
    // Only the combined chart dashes a line — to tell a run's two curves apart.
    expect(heatFlow).not.toContain("prstDash");
    expect(deriv).not.toContain("prstDash");
    expect(combined).toContain('<a:prstDash val="dash"/>');

    // Every part the package needs must be declared, or Excel silently repairs.
    const ct = await zip.file("[Content_Types].xml")!.async("string");
    for (const part of charts) expect(ct).toContain(`/${part}`);
  });

  it("gives every run its own trio of charts, on its own data sheet", async () => {
    const buffer = await buildDscExcelBuffer({
      runs: [makeRun("A", "#2563eb"), makeRun("B", "#dc2626")],
      materials,
      params: DEFAULT_PARAMS,
    });
    const zip = await JSZip.loadAsync(buffer);
    // chart4..6 belong to run A, chart7..9 to run B — grouped per sheet, in
    // the order the runs were exported.
    const own = async (i: number) => zip.file(`xl/charts/chart${i}.xml`)!.async("string");
    for (const [run, other, indices] of [
      ["A", "B", [4, 5, 6]],
      ["B", "A", [7, 8, 9]],
    ] as const) {
      const trio = await Promise.all(indices.map(own));
      const [heatFlow, , combined] = trio;
      for (const chart of trio) {
        expect(chart).toContain(`'${run}'!$B$2:$B$401`);
        // A single-run chart shows that run and nothing else.
        expect(chart).not.toContain(`'${other}'!`);
      }
      expect([...heatFlow.matchAll(/<c:ser>/g)]).toHaveLength(1);
      expect([...combined.matchAll(/<c:ser>/g)]).toHaveLength(2);
      // One curve needs no legend to be identified; two do.
      expect(heatFlow).not.toContain("<c:legend>");
      expect(combined).toContain("<c:legend>");
      expect([...combined.matchAll(/<c:valAx>/g)]).toHaveLength(4);
    }
    // Each run's sheet is wired to a drawing of its own, and the workbook
    // still reopens with the charts' captions beside the data.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet("A")!;
    expect(String(ws.getCell("G1").value)).toContain("A —");
    expect(String(ws.getCell("G19").value)).toContain("derivative");
  });

  it("charts every point of a long run, with no second copy of the curve", async () => {
    const points = 4000;
    const buffer = await buildDscExcelBuffer({
      runs: [makeRun("A", "#2563eb", points)],
      materials: [{ id: "m1", name: "Blend", runIds: ["A"] }],
      params: DEFAULT_PARAMS,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    // Data sheet: header + every point, and only the five signal columns —
    // the thinned chart columns exist solely for a segment past Excel's
    // series cap. (Column G holds a chart caption, so measure a data row.)
    const ws = wb.getWorksheet("A")!;
    expect(ws.rowCount).toBe(points + 1);
    expect(ws.getRow(2).cellCount).toBe(5);
    // And the chart reaches the last of them.
    const zip = await JSZip.loadAsync(buffer);
    const chart1 = await zip.file("xl/charts/chart1.xml")!.async("string");
    expect(chart1).toContain(`'A'!$B$2:$B$${points + 1}`);
    expect(chart1).toContain(`'A'!$D$2:$D$${points + 1}`);
  });

  it("thins only a run past Excel's series cap, and charts the thinned copy", async () => {
    // Excel silently drops points past 32 000 in one chart series, so a
    // segment longer than that (a TRIOS .tri heat ramp is ~16 800, but two
    // concatenated ramps or a slow scan can exceed it) gets a decimated copy
    // in spare columns beside its full-resolution data — the one case where
    // the chart is not reading every recorded point.
    const points = 33_000;
    const buffer = await buildDscExcelBuffer({
      runs: [makeRun("Long", "#2563eb", points)],
      materials: [{ id: "m1", name: "Blend", runIds: ["Long"] }],
      params: DEFAULT_PARAMS,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet("Long")!;
    // Full resolution is still there, in the first five columns.
    expect(ws.rowCount).toBe(points + 1);
    expect(String(ws.getCell("B1").value)).toContain("Temperature");
    // Plus the chart columns (F is a blank separator).
    expect(String(ws.getCell("G1").value)).toContain("Chart");
    const zip = await JSZip.loadAsync(buffer);
    const chart1 = await zip.file("xl/charts/chart1.xml")!.async("string");
    // The chart reads G/H, capped at the limit, never the 33 000-row B/D.
    expect(chart1).toContain("'Long'!$G$2:$G$32001");
    expect(chart1).toContain("'Long'!$H$2:$H$32001");
    expect(chart1).not.toContain(`$B$2:$B$${points + 1}`);
    // And its own charts anchor clear of those extra columns, at K.
    expect(String(ws.getCell("K1").value)).toContain("Long —");
  }, 30_000);

  it("survives a run whose label collides with a reserved sheet name", async () => {
    const clash = makeRun("Summary", "#16a34a");
    const buffer = await buildDscExcelBuffer({
      runs: [clash],
      materials: [{ id: "m1", name: "Blend", runIds: ["Summary"] }],
      params: DEFAULT_PARAMS,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    // The real Summary sheet keeps its name; the run's sheet is renamed.
    const summary = wb.getWorksheet("Summary")!;
    expect(String(summary.getCell("A1").value)).toBe("DSC summary");
    expect(wb.worksheets.length).toBe(4); // Summary, Transitions, the run, Charts
    // The chart follows the renamed sheet rather than pointing at "Summary".
    const zip = await JSZip.loadAsync(buffer);
    const chart1 = await zip.file("xl/charts/chart1.xml")!.async("string");
    expect(chart1).toContain("'Summary-2'!");
    expect(chart1).not.toContain("'Summary'!");
  });
});
