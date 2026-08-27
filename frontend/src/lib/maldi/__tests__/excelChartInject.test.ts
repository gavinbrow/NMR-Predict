import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { injectCharts, sanitizeDrawingXml, type ChartSpec } from "../excelChartInject";
import JSZip from "jszip";

/** Parse as XML and fail loudly on a malformed part. Excel does not report an
 *  error for these — it silently drops the drawing — so the parser is our
 *  stand-in for the validation Excel performs on open. */
function parseXml(xml: string, what: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error(`${what} is not well-formed XML: ${err.textContent}`);
  return doc;
}

/** Index of each named child inside a parent, for schema-sequence assertions. */
function childOrder(parent: Element): string[] {
  return [...parent.children].map((c) => c.nodeName);
}

/**
 * End-to-end: ExcelJS builds a workbook, we inject scatter charts into the
 * zip, and the result must (a) be a valid zip, (b) carry every chart part,
 * (c) wire the worksheet to a drawing, and (d) declare all new parts in
 * [Content_Types].xml. This is the cheapest way to catch a malformed OOXML
 * package without opening Excel.
 */
async function buildSampleWorkbook(): Promise<Uint8Array> {
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
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe("excelChartInject", () => {
  it("injects chart parts, drawing, rels and content-type overrides", async () => {
    const before = await buildSampleWorkbook();
    const specs: ChartSpec[] = [
      {
        sheetName: "Series",
        seriesName: "Series 1 — [M+Na]+",
        xRange: "A6:A9",
        yRange: "B6:B9",
        xMin: 3,
        xMax: 6,
        yMin: 600,
        yMax: 2000,
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
    // Reference chart format: no R² displayed.
    expect(chart).toContain("c:dispRSqr val=\"0\"");
    // Ranges are written absolute, the form Excel itself emits.
    // yRange now references column B (raw m/z), not D (neutral mass).
    expect(chart).toContain("'Series'!$A$6:$A$9");
    expect(chart).toContain("'Series'!$B$6:$B$9");
    expect(chart).toContain("<c:valAx");
    expect(chart).not.toContain("<c:catAx");
    // Reference chart formatting: no chart title, no legend, schemeClr tx1 axes.
    expect(chart).toContain("c:autoTitleDeleted val=\"1\"");
    expect(chart).not.toContain("<c:legend");
    expect(chart).toContain("a:schemeClr val=\"tx1\"");
    // Axis titles match reference.
    expect(chart).toContain("Repeat Units (n)");
    expect(chart).toContain(">m/z<");
    // Min/max scaling.
    expect(chart).toContain("<c:min val=\"3\"");
    expect(chart).toContain("<c:max val=\"6\"");
    expect(chart).toContain("<c:min val=\"600\"");
    expect(chart).toContain("<c:max val=\"2000\"");
    // Arial 12pt bold default font.
    expect(chart).toContain("sz=\"1200\" b=\"1\"");
    expect(chart).toContain("typeface=\"Arial\"");

    // Round-trip: ExcelJS must be able to re-open the doctored workbook
    // without choking on the injected chart parts.
    const reopened = new ExcelJS.Workbook();
    await expect(reopened.xlsx.load(after)).resolves.toBeDefined();
    expect(reopened.getWorksheet("Series")).toBeDefined();
  });

  // Every part we hand-write must be well-formed. An unclosed <c:spPr> inside
  // <c:marker> is exactly what made Excel report "Removed Part:
  // /xl/drawings/drawing2.xml" and render no charts at all.
  it("emits well-formed chart and drawing parts", async () => {
    const after = await injectCharts(await buildSampleWorkbook(), [
      { sheetName: "Series", seriesName: "S1 — [M+Na]+", xRange: "A6:A9", yRange: "B6:B9", xMin: 3, xMax: 6, yMin: 600, yMax: 2000, anchorCol: 8, anchorRow: 0 },
      { sheetName: "Series", seriesName: "S2 — [M+K]+", xRange: "A6:A9", yRange: "B6:B9", xMin: 3, xMax: 6, yMin: 600, yMax: 2000, anchorCol: 8, anchorRow: 20 },
    ]);
    const zip = await JSZip.loadAsync(after);
    for (const name of Object.keys(zip.files)) {
      if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
      parseXml(await zip.file(name)!.async("string"), name);
    }
    // Two specs on one sheet → two chart parts anchored by one drawing.
    expect(Object.keys(zip.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))).toHaveLength(2);
    expect(Object.keys(zip.files).filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))).toHaveLength(1);
    const drawing = await zip.file(
      Object.keys(zip.files).find((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))!,
    )!.async("string");
    // Distinct relationship ids and distinct shape ids, or Excel merges the frames.
    expect(drawing.match(/r:id="rId1"/g)).toHaveLength(1);
    expect(drawing.match(/r:id="rId2"/g)).toHaveLength(1);
  });

  // Excel validates the CT_ValAx / CT_Ser / CT_Trendline child sequences strictly:
  // out-of-order children make it discard the whole drawing on open.
  it("orders chart children per the OOXML schema sequences", async () => {
    const after = await injectCharts(await buildSampleWorkbook(), [
      { sheetName: "Series", seriesName: "S1", xRange: "A6:A9", yRange: "B6:B9", xMin: 3, xMax: 6, yMin: 600, yMax: 2000, anchorCol: 8, anchorRow: 0 },
    ]);
    const zip = await JSZip.loadAsync(after);
    const doc = parseXml(await zip.file("xl/charts/chart1.xml")!.async("string"), "chart1.xml");

    // scatterChart: scatterStyle is an ELEMENT (it was written as an attribute).
    const scatter = doc.getElementsByTagName("c:scatterChart")[0];
    expect(scatter).toBeTruthy();
    expect(scatter.getAttribute("c:scatterStyle")).toBeNull();
    expect(childOrder(scatter)[0]).toBe("c:scatterStyle");

    // ser: … marker, trendline, xVal, yVal, smooth — trendline BEFORE the values.
    const ser = doc.getElementsByTagName("c:ser")[0];
    const serOrder = childOrder(ser);
    expect(serOrder.indexOf("c:trendline")).toBeLessThan(serOrder.indexOf("c:xVal"));
    expect(serOrder.indexOf("c:xVal")).toBeLessThan(serOrder.indexOf("c:yVal"));

    // trendline: dispRSqr BEFORE dispEq.
    const trend = doc.getElementsByTagName("c:trendline")[0];
    const trendOrder = childOrder(trend);
    expect(trendOrder.indexOf("c:trendlineType")).toBeLessThan(trendOrder.indexOf("c:dispRSqr"));
    expect(trendOrder.indexOf("c:dispRSqr")).toBeLessThan(trendOrder.indexOf("c:dispEq"));

    // valAx: title BEFORE numFmt, crossAx last of the three.
    for (const ax of [...doc.getElementsByTagName("c:valAx")]) {
      const order = childOrder(ax);
      expect(order.indexOf("c:title")).toBeLessThan(order.indexOf("c:numFmt"));
      expect(order.indexOf("c:numFmt")).toBeLessThan(order.indexOf("c:crossAx"));
      expect(order.indexOf("c:tickLblPos")).toBeLessThan(order.indexOf("c:crossAx"));
    }

    // The two axes must not share an id, and each must cross the other.
    const ids = [...doc.getElementsByTagName("c:valAx")].map(
      (ax) => ax.getElementsByTagName("c:axId")[0].getAttribute("val"),
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("strips the editAs attribute ExcelJS puts on oneCellAnchor", () => {
    const before =
      '<xdr:wsDr><xdr:oneCellAnchor editAs="oneCell"><xdr:from/></xdr:oneCellAnchor>' +
      '<xdr:twoCellAnchor editAs="twoCell"><xdr:from/></xdr:twoCellAnchor></xdr:wsDr>';
    const after = sanitizeDrawingXml(before);
    expect(after).toContain("<xdr:oneCellAnchor>");
    // twoCellAnchor legitimately carries editAs — it must survive.
    expect(after).toContain('<xdr:twoCellAnchor editAs="twoCell">');
  });

  it("keeps the workbook intact when no specs are passed", async () => {
    const before = await buildSampleWorkbook();
    const after = await injectCharts(before, []);
    const zip = await JSZip.loadAsync(after);
    expect(Object.keys(zip.files)).toContain("xl/worksheets/sheet1.xml");
    expect(Object.keys(zip.files).some((n) => /^xl\/charts\//.test(n))).toBe(false);
    const reopened = new ExcelJS.Workbook();
    await expect(reopened.xlsx.load(after)).resolves.toBeDefined();
  });
});

/**
 * The multi-series / style / axis-title options the TGA workspace needs. These
 * are all opt-in: the MALDI cases above pin the defaults, and these pin that
 * every override actually reaches the chart XML.
 */
describe("excelChartInject — multi-series specs", () => {
  async function chartXmlFor(spec: ChartSpec): Promise<string> {
    const after = await injectCharts(await buildSampleWorkbook(), [spec]);
    const zip = await JSZip.loadAsync(after);
    return zip.file("xl/charts/chart1.xml")!.async("string");
  }

  const base = {
    sheetName: "Series",
    seriesName: "ignored",
    xRange: "",
    yRange: "",
    xMin: 0,
    xMax: 600,
    yMin: 0,
    yMax: 100,
    anchorCol: 8,
    anchorRow: 1,
  } satisfies Omit<ChartSpec, "series">;

  it("emits one c:ser per entry, indexed and ordered", async () => {
    const chart = await chartXmlFor({
      ...base,
      series: [
        { name: "Run A", xRange: "A6:A9", yRange: "B6:B9" },
        { name: "Run B", xRange: "A6:A9", yRange: "D6:D9" },
      ],
    });
    const doc = parseXml(chart, "chart1.xml");
    const sers = [...doc.getElementsByTagName("c:ser")];
    expect(sers).toHaveLength(2);
    expect(sers.map((e) => e.getElementsByTagName("c:idx")[0].getAttribute("val"))).toEqual([
      "0",
      "1",
    ]);
    expect(chart).toContain("Run A");
    expect(chart).toContain("Run B");
    // Each series keeps its own y range.
    expect(chart).toContain("'Series'!$B$6:$B$9");
    expect(chart).toContain("'Series'!$D$6:$D$9");
  });

  it("colours a series with an explicit srgbClr instead of the theme's tx1", async () => {
    const chart = await chartXmlFor({
      ...base,
      series: [{ name: "Run A", xRange: "A6:A9", yRange: "B6:B9", color: "#2563EB" }],
    });
    expect(chart).toContain('<a:srgbClr val="2563EB"/>');
  });

  it("honours the style overrides: solid line, no markers, no trendline, legend on", async () => {
    const chart = await chartXmlFor({
      ...base,
      series: [{ name: "Run A", xRange: "A6:A9", yRange: "B6:B9" }],
      style: { line: "solid", markers: false, trendline: false, legend: true },
    });
    expect(chart).not.toContain("prstDash");
    expect(chart).toContain('<c:symbol val="none"/>');
    expect(chart).not.toContain("<c:trendline>");
    expect(chart).toContain("<c:legend>");
  });

  it("uses the per-spec axis titles and number formats", async () => {
    const chart = await chartXmlFor({
      ...base,
      series: [{ name: "Run A", xRange: "A6:A9", yRange: "B6:B9" }],
      xTitle: "Temperature (°C)",
      yTitle: "Weight (%)",
      xNumFmt: "0",
      yNumFmt: "0.000",
    });
    expect(chart).toContain("Temperature (");
    expect(chart).toContain("Weight (%)");
    expect(chart).toContain('formatCode="0.000"');
    expect(chart).not.toContain("Repeat Units (n)");
  });

  it("still produces a package Excel can reopen", async () => {
    const after = await injectCharts(await buildSampleWorkbook(), [
      {
        ...base,
        series: [
          { name: "Run A", xRange: "A6:A9", yRange: "B6:B9", color: "2563EB" },
          { name: "Run B", xRange: "A6:A9", yRange: "D6:D9", color: "DC2626" },
        ],
        style: { line: "solid", markers: false, trendline: false, legend: true },
        xTitle: "Temperature (°C)",
        yTitle: "Weight (%)",
      },
    ]);
    const reopened = new ExcelJS.Workbook();
    await expect(reopened.xlsx.load(after)).resolves.toBeDefined();
  });
});

/**
 * A combined chart plots two quantities of very different magnitude together —
 * a TGA weight % over 0–100 and its derivative around 0.1 — which OOXML
 * expresses as a SECOND `c:scatterChart` group carrying its own axis pair. Get
 * that structure wrong and Excel does not complain, it silently drops the whole
 * chart, so the shape is asserted here rather than left to the eye.
 */
describe("excelChartInject — secondary axis", () => {
  async function chartDocFor(spec: ChartSpec) {
    const after = await injectCharts(await buildSampleWorkbook(), [spec]);
    const zip = await JSZip.loadAsync(after);
    const xml = await zip.file("xl/charts/chart1.xml")!.async("string");
    return { xml, doc: parseXml(xml, "chart1.xml") };
  }

  const base = {
    sheetName: "Series",
    seriesName: "ignored",
    xRange: "",
    yRange: "",
    xMin: 0,
    xMax: 600,
    yMin: 0,
    yMax: 100,
    anchorCol: 8,
    anchorRow: 1,
  } satisfies Omit<ChartSpec, "series">;

  const weight = { name: "Run A", xRange: "A6:A9", yRange: "B6:B9", color: "2563EB" };
  const deriv = {
    name: "Run A — deriv.",
    xRange: "A6:A9",
    yRange: "D6:D9",
    color: "2563EB",
    axis: "y2" as const,
    dash: true,
  };

  it("leaves a chart with no y2 series at one group and two axes", async () => {
    const { doc } = await chartDocFor({ ...base, series: [weight] });
    expect(doc.getElementsByTagName("c:scatterChart")).toHaveLength(1);
    expect(doc.getElementsByTagName("c:valAx")).toHaveLength(2);
  });

  it("splits y2 series into their own group against a right-hand axis", async () => {
    const { xml, doc } = await chartDocFor({
      ...base,
      series: [weight, deriv],
      yTitle: "Weight (%)",
      y2Title: "Deriv. weight (%/°C)",
      y2Min: -0.01,
      y2Max: 0.12,
      y2NumFmt: "0.000",
      style: { line: "solid", markers: false, trendline: false, legend: true },
    });
    const groups = [...doc.getElementsByTagName("c:scatterChart")];
    expect(groups).toHaveLength(2);
    // One series each, and the second group's idx continues the first's, since
    // idx/order are numbered across the whole chart rather than per group.
    expect(groups.map((g) => g.getElementsByTagName("c:ser").length)).toEqual([1, 1]);
    const idx = [...doc.getElementsByTagName("c:idx")].map((e) => e.getAttribute("val"));
    expect(idx).toEqual(["0", "1"]);

    // Four axes, all with distinct ids, and every crossAx resolving to one.
    const axes = [...doc.getElementsByTagName("c:valAx")];
    expect(axes).toHaveLength(4);
    const ids = axes.map((ax) => ax.getElementsByTagName("c:axId")[0].getAttribute("val"));
    expect(new Set(ids).size).toBe(4);
    for (const ax of axes) {
      expect(ids).toContain(ax.getElementsByTagName("c:crossAx")[0].getAttribute("val"));
    }
    // Each group names the pair it plots against, and the two pairs are disjoint.
    const pairs = groups.map((g) =>
      [...g.getElementsByTagName("c:axId")].map((e) => e.getAttribute("val")),
    );
    expect(pairs[0].some((v) => pairs[1].includes(v))).toBe(false);

    // The secondary y sits at the right, crossing its x at the far end; that x
    // is a hidden duplicate that exists only to complete the pair.
    const pos = (ax: Element) => ax.getElementsByTagName("c:axPos")[0].getAttribute("val");
    const del = (ax: Element) => ax.getElementsByTagName("c:delete")[0].getAttribute("val");
    expect(axes.map(pos)).toEqual(["b", "l", "r", "b"]);
    expect(axes.map(del)).toEqual(["0", "0", "0", "1"]);
    expect(axes[2].getElementsByTagName("c:crosses")[0].getAttribute("val")).toBe("max");

    // The right axis is scaled and titled independently of the left one.
    expect(xml).toContain('<c:max val="0.12"/><c:min val="-0.01"/>');
    expect(xml).toContain("Deriv. weight (");
    expect(xml).toContain("Weight (%)");
    // …and its curve is dashed, so a pair sharing one colour still reads apart.
    expect(xml).toContain('<a:prstDash val="dash"/>');
  });

  it("falls back to a single group when every series asks for the right axis", async () => {
    const { doc } = await chartDocFor({ ...base, series: [deriv, { ...deriv, name: "Run B" }] });
    // Nothing to be secondary TO — an empty primary group would be invalid XML.
    expect(doc.getElementsByTagName("c:scatterChart")).toHaveLength(1);
    expect(doc.getElementsByTagName("c:valAx")).toHaveLength(2);
    expect(doc.getElementsByTagName("c:ser")).toHaveLength(2);
  });

  it("still produces a package Excel can reopen", async () => {
    const after = await injectCharts(await buildSampleWorkbook(), [
      { ...base, series: [weight, deriv], y2Min: 0, y2Max: 1 },
    ]);
    const reopened = new ExcelJS.Workbook();
    await expect(reopened.xlsx.load(after)).resolves.toBeDefined();
    const zip = await JSZip.loadAsync(after);
    const ct = await zip.file("[Content_Types].xml")!.async("string");
    expect(ct).toContain("/xl/charts/chart1.xml");
  });
});
