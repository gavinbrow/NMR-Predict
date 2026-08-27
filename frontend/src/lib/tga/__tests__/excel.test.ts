// The Excel workbook is the export with the most that can silently go wrong:
// a malformed chart part doesn't error, Excel just drops the chart. These
// assertions stand in for opening the file — the package must reload in
// ExcelJS, carry both chart parts, and point them at real ranges on the runs'
// own data sheets, at FULL resolution (an earlier revision charted a thinned
// ~900-point copy, which quietly dropped most of every exported curve).

import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { buildTgaExcelBuffer } from "../export";
import { computeAnalysis } from "../compute";
import { DEFAULT_PARAMS, type TgaMaterial, type TgaMetadata } from "../types";
import type { TgaRunAnalyzed } from "../store";

function makeRun(id: string, color: string, points = 400): TgaRunAnalyzed {
  const tempC = new Float64Array(points);
  const weightMg = new Float64Array(points);
  const timeMin = new Float64Array(points);
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    tempC[i] = 25 + t * 575;
    // A sigmoid-ish single step so the analysis finds something real.
    weightMg[i] = 10 * (0.13 + 0.87 / (1 + Math.exp((tempC[i] - 360) / 20)));
    timeMin[i] = t * 57.5;
  }
  const meta: TgaMetadata = {
    instrument: "TGA5500",
    operator: "",
    sampleName: id,
    sampleSizeMg: 10,
    pan: "Platinum",
    methodSteps: ["Ramp 10 °C/min to 600 °C"],
    runDate: "",
    gases: "N2",
  };
  return {
    id,
    fileId: "f1",
    fileName: `${id}.tri`,
    label: id,
    color,
    meta,
    segments: [{ label: "Ramp" }],
    timeMin,
    tempC,
    weightMg,
    scale: 1,
    offset: 0,
    visible: true,
    materialId: "m1",
    analysis: computeAnalysis(weightMg, tempC, timeMin, DEFAULT_PARAMS, { sampleSizeMg: 10 }),
  };
}

const materials: TgaMaterial[] = [{ id: "m1", name: "Blend", runIds: ["A", "B"] }];

describe("buildTgaExcelBuffer", () => {
  it("produces a package ExcelJS can reload, with every sheet", async () => {
    const buffer = await buildTgaExcelBuffer({
      runs: [makeRun("A", "#2563eb"), makeRun("B", "#dc2626")],
      materials,
      params: DEFAULT_PARAMS,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("Summary");
    expect(names).toContain("Steps");
    expect(names).toContain("Charts");
    // One full-resolution data sheet per run.
    expect(names).toContain("A");
    expect(names).toContain("B");
  });

  it("injects two native charts wired to the runs' own data sheets", async () => {
    const buffer = await buildTgaExcelBuffer({
      runs: [makeRun("A", "#2563eb"), makeRun("B", "#dc2626")],
      materials,
      params: DEFAULT_PARAMS,
    });
    const zip = await JSZip.loadAsync(buffer);
    const charts = Object.keys(zip.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n));
    expect(charts).toHaveLength(2);

    const chart1 = await zip.file("xl/charts/chart1.xml")!.async("string");
    const chart2 = await zip.file("xl/charts/chart2.xml")!.async("string");
    // Weight % chart, then the DTG chart, both against temperature.
    expect(chart1).toContain("Temperature (");
    expect(chart1).toContain("Weight (%)");
    expect(chart2).toContain("Deriv. weight");
    // One series per run, reading that run's OWN sheet across every data row
    // (400 points → rows 2..401), in the run's colour, named after the run.
    for (const chart of [chart1, chart2]) {
      expect(chart).toContain("'A'!$B$2:$B$401");
      expect(chart).toContain("'B'!$B$2:$B$401");
      expect(chart).toContain('<a:srgbClr val="2563EB"/>');
      expect(chart).toContain('<a:srgbClr val="DC2626"/>');
      expect([...chart.matchAll(/<c:ser>/g)]).toHaveLength(2);
      // TGA curves are plain lines: no MALDI dotted stroke, markers or trendline.
      expect(chart).not.toContain("prstDash");
      expect(chart).not.toContain("<c:trendline>");
      expect(chart).toContain("<c:legend>");
    }
    // Every part the package needs must be declared, or Excel silently repairs.
    const ct = await zip.file("[Content_Types].xml")!.async("string");
    expect(ct).toContain("/xl/charts/chart1.xml");
    expect(ct).toContain("/xl/charts/chart2.xml");
  });

  it("charts every point of a long run, with no second copy of the curve", async () => {
    const points = 4000;
    const buffer = await buildTgaExcelBuffer({
      runs: [makeRun("A", "#2563eb", points)],
      materials: [{ id: "m1", name: "Blend", runIds: ["A"] }],
      params: DEFAULT_PARAMS,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    // Data sheet: header + every point, and only the five signal columns —
    // the thinned chart columns exist solely for runs past Excel's series cap.
    const ws = wb.getWorksheet("A")!;
    expect(ws.rowCount).toBe(points + 1);
    expect(ws.columnCount).toBe(5);
    // And the chart reaches the last of them.
    const zip = await JSZip.loadAsync(buffer);
    const chart1 = await zip.file("xl/charts/chart1.xml")!.async("string");
    expect(chart1).toContain(`'A'!$B$2:$B$${points + 1}`);
    expect(chart1).toContain(`'A'!$D$2:$D$${points + 1}`);
  });

  it("thins only a run past Excel's series cap, and charts the thinned copy", async () => {
    // Excel silently drops points past 32 000 in one chart series, so a run
    // longer than that (a TRIOS .tri is ~35 000) gets a decimated copy in spare
    // columns beside its full-resolution data — the one case where the chart
    // is not reading every recorded point.
    const points = 33_000;
    const buffer = await buildTgaExcelBuffer({
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
  }, 30_000);

  it("survives a run whose label collides with a reserved sheet name", async () => {
    const clash = makeRun("Summary", "#16a34a");
    const buffer = await buildTgaExcelBuffer({
      runs: [clash],
      materials: [{ id: "m1", name: "Blend", runIds: ["Summary"] }],
      params: DEFAULT_PARAMS,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    // The real Summary sheet keeps its name; the run's sheet is renamed.
    const summary = wb.getWorksheet("Summary")!;
    expect(String(summary.getCell("A1").value)).toBe("TGA summary");
    expect(wb.worksheets.length).toBe(4); // Summary, Steps, the run, Charts
    // The chart follows the renamed sheet rather than pointing at "Summary".
    const zip = await JSZip.loadAsync(buffer);
    const chart1 = await zip.file("xl/charts/chart1.xml")!.async("string");
    expect(chart1).toContain("'Summary-2'!");
    expect(chart1).not.toContain("'Summary'!");
  });
});
