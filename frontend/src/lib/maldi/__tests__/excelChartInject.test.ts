import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { injectCharts, type ChartSpec } from "../excelChartInject";
import JSZip from "jszip";

/**
 * End-to-end: ExcelJS builds a workbook, we inject scatter charts into the
 * zip, and the result must (a) be a valid zip, (b) carry every chart part,
 * (c) wire the worksheet to a drawing, and (d) declare all new parts in
 * [Content_Types].xml. This is the cheapest way to catch a malformed OOXML
 * package without opening Excel.
 */
async function buildSampleWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Series");
  ws.getColumn(1).width = 8;
  for (let i = 2; i <= 7; i += 1) ws.getColumn(i).width = 14;
  ws.getCell("A1").value = "Series 1";
  ws.getCell("C2").value = { formula: "SLOPE(D6:D9,A6:A9)" };
  ws.getCell("E2").value = { formula: "INTERCEPT(D6:D9,A6:A9)" };
  ws.getCell("A5").value = "n";
  ws.getCell("D5").value = "neutral mass";
  for (let i = 0; i < 4; i += 1) {
    const r = 6 + i;
    ws.getCell(`A${r}`).value = i + 3;
    ws.getCell(`B${r}`).value = 100 + i * 22.2;
    ws.getCell(`D${r}`).value = 80 + i * 22.2;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("excelChartInject", () => {
  it("injects chart parts, drawing, rels and content-type overrides", async () => {
    const before = await buildSampleWorkbook();
    const specs: ChartSpec[] = [
      {
        sheetName: "Series",
        title: "Series 1 — [M+Na]+",
        xRange: "A6:A9",
        yRange: "D6:D9",
        anchorCol: 8,
        anchorRow: 0,
      },
    ];
    const after = await injectCharts(before, specs);

    const zip = await JSZip.loadAsync(after);
    const names = Object.keys(zip.files);
    expect(names).toContain("xl/charts/chart1.xml");
    // The drawing number depends on whether a Spectrum image already used
    // drawing1; here there's no image so it's drawing1.
    const drawingName = names.find((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))!;
    expect(drawingName).toBeTruthy();
    const drawingBase = drawingName.replace(/^xl\/drawings\//, "");
    expect(names).toContain(`xl/drawings/_rels/${drawingBase}.rels`);
    expect(names).toContain("xl/worksheets/_rels/sheet1.xml.rels");

    const ct = await zip.file("[Content_Types].xml")!.async("string");
    expect(ct).toContain("/xl/charts/chart1.xml");
    expect(ct).toContain(`/${drawingName}`);

    const sheetRels = await zip.file("xl/worksheets/_rels/sheet1.xml.rels")!.async("string");
    expect(sheetRels).toContain(drawingBase);
    expect(sheetRels).toContain("/relationships/drawing");

    const sheet1 = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet1).toContain('<drawing r:id="rId');

    const drawing = await zip.file(drawingName)!.async("string");
    expect(drawing).toContain("graphicFrame");
    expect(drawing).toContain("twoCellAnchor");

    const drawingRelsName = `xl/drawings/_rels/${drawingBase}.rels`;
    const drawingRels = await zip.file(drawingRelsName)!.async("string");
    expect(drawingRels).toContain("../charts/chart1.xml");

    const chart = await zip.file("xl/charts/chart1.xml")!.async("string");
    expect(chart).toContain("scatterChart");
    expect(chart).toContain("c:trendline");
    expect(chart).toContain("c:trendlineType val=\"linear\"");
    expect(chart).toContain("c:dispEq val=\"1\"");
    expect(chart).toContain("c:dispRSqr val=\"1\"");
    expect(chart).toContain("'Series'!A6:A9");
    expect(chart).toContain("'Series'!D6:D9");
    expect(chart).toContain("<c:valAx");
    expect(chart).not.toContain("<c:catAx");

    // Round-trip: ExcelJS must be able to re-open the doctored workbook
    // without choking on the injected chart parts.
    const reopened = new ExcelJS.Workbook();
    await expect(reopened.xlsx.load(after)).resolves.toBeDefined();
    expect(reopened.getWorksheet("Series")).toBeDefined();
  });

  it("is a no-op when no specs are passed", async () => {
    const before = await buildSampleWorkbook();
    const after = await injectCharts(before, []);
    expect(after.length).toBe(before.length);
  });
});