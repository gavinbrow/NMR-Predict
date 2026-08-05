/**
 * Inject native Excel scatter charts (with linear trendline + equation + R²
 * label) into an ExcelJS-produced xlsx buffer.
 *
 * ExcelJS 4.4.0 has no chart API, so we post-process the generated zip:
 * for every series block we add a chartN.xml part, anchor it on the target
 * worksheet via a new drawing, and wire up the content-types / relationships
 * that OOXML requires. Excel and LibreOffice both render the result and keep
 * the trendline / equation live against the cells.
 *
 * Each chart specification names the sheet, the n-range (x) and the
 * neutral-mass range (y). We emit a scatter plot with markers only, plus a
 * linear trendline (`c:spPr`/`c:trendline`) with `c:trendlineLbl` showing the
 * equation and R², and a chart title.
 */

export interface ChartSpec {
  /** Worksheet name the chart lives on (and the ranges reference). */
  sheetName: string;
  /** Chart title. */
  title: string;
  /** X-axis (n) range, e.g. "A27:A38". */
  xRange: string;
  /** Y-axis (neutral mass) range, e.g. "D27:D38". */
  yRange: string;
  /** Zero-based column + row of the top-left cell the chart anchors at. */
  anchorCol: number;
  anchorRow: number;
}

interface SheetInfo {
  /** Sheet name → { sheetPath: "xl/worksheets/sheetN.xml", sheetRId: "rIdK" } */
  byName: Map<string, { sheetPath: string; relsPath: string }>;
}

const NS = {
  rels: "http://schemas.openxmlformats.org/package/2006/relationships",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
  main: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  xdr: "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
};

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Build the chartN.xml body for one scatter chart with a linear trendline
 * that displays the equation and R² on the chart.
 */
function buildChartXml(spec: ChartSpec, chartIndex: number): string {
  const sheetRef = `'${spec.sheetName}'!`;
  const xRef = `${sheetRef}${spec.xRange}`;
  const yRef = `${sheetRef}${spec.yRange}`;
  const titleEsc = xmlEscape(spec.title);
  // Two series: the data points (markers, no line) and an invisible helper
  // is unnecessary — a single scatter series with a trendline is the standard
  // form. We emit one scatter series with markers + a linear trendline.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr><a:latin typeface="Calibri"/><a:defRPr sz="1200" b="1"/></a:rPr><a:t>${titleEsc}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:scatterChart c:scatterStyle="lineMarker"><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Polymer series</c:v></c:tx><c:spPr><a:ln w="12700"><a:solidFill><a:srgbClr val="1F77B4"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:effectLst/></c:spPr><c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="1F77B4"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="1F77B4"/></a:solidFill></a:ln></c:marker><c:xVal><c:numRef><c:f>${xRef}</c:f></c:numRef></c:xVal><c:yVal><c:numRef><c:f>${yRef}</c:f></c:numRef></c:yVal><c:trendline><c:spPr><a:ln w="19050"><a:solidFill><a:srgbClr val="D62728"/></a:solidFill><a:prstDash val="dash"/></a:ln></c:spPr><c:trendlineType val="linear"/><c:dispEq val="1"/><c:dispRSqr val="1"/></c:trendline></c:ser><c:axId val="111111"/><c:axId val="222222"/></c:scatterChart><c:valAx><c:axId val="111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"/></a:pPr><a:r><a:rPr><a:latin typeface="Calibri"/><a:defRPr sz="1000"/></a:rPr><a:t>n (oligomer number)</a:t></a:r></a:p></c:rich></c:tx></c:title><c:crossAx val="222222"/></c:valAx><c:valAx><c:axId val="222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="0.0000" sourceLinked="0"/><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"/></a:pPr><a:r><a:rPr><a:latin typeface="Calibri"/><a:defRPr sz="1000"/></a:rPr><a:t>Neutral mass (Da)</a:t></a:r></a:p></c:rich></c:tx></c:title><c:crossAx val="111111"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

/**
 * Build the drawing XML that anchors all charts for one worksheet. Uses
 * oneCellAnchor per chart (top-left cell + fixed extent in EMUs).
 * 1 column ≈ 642000 EMU at default width; 1 row ≈ 195000 EMU at 14.4pt.
 */
function buildDrawingXml(specs: ChartSpec[]): string {
  const COL_EMU = 642000;
  const ROW_EMU = 195000;
  const WIDTH_EMU = 4 * COL_EMU; // ~4 columns wide
  const HEIGHT_EMU = 12 * ROW_EMU; // ~12 rows tall
  const parts: string[] = [];
  specs.forEach((spec, i) => {
    const cx = spec.anchorCol * COL_EMU;
    const cy = spec.anchorRow * ROW_EMU;
    const rid = `rId${i + 1}`;
    parts.push(
      `<xdr:twoCellAnchor><xdr:from><xdr:col>${spec.anchorCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${spec.anchorRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${spec.anchorCol + 8}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${spec.anchorRow + 16}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${10 + i}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="${cx}" y="${cy}"/><a:ext cx="${WIDTH_EMU}" cy="${HEIGHT_EMU}"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS.c}"><c:chart xmlns:c="${NS.c}" xmlns:r="${NS.r}" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`,
    );
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}">${parts.join("")}</xdr:wsDr>`;
}

function buildDrawingRelsXml(chartCount: number): string {
  const rels: string[] = [];
  for (let i = 0; i < chartCount; i += 1) {
    rels.push(
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${i + 1}.xml"/>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.rels}">${rels.join("")}</Relationships>`;
}

/** Extract `<sheet name="X" sheetId="N" r:id="rIdK"/>` → name → sheetPath.
 *  Attribute order varies between ExcelJS and hand-written files, so parse
 *  each <sheet/> tag as a whole and pull the attributes out individually. */
function parseSheets(workbookXml: string, relsXml: string): SheetInfo {
  const byName = new Map<string, { sheetPath: string; relsPath: string }>();
  const ridToTarget = new Map<string, string>();
  const relRe = /<Relationship\s+Id="([^"]+)"\s+Type="[^"]*\/worksheet"\s+Target="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(relsXml)) !== null) ridToTarget.set(m[1], m[2]);
  const sheetTagRe = /<sheet\b[^>]*\/>/g;
  const attr = (tag: string, name: string): string | null => {
    const re = new RegExp(`\\s${name}="([^"]+)"`);
    const mm = tag.match(re);
    return mm ? mm[1] : null;
  };
  while ((m = sheetTagRe.exec(workbookXml)) !== null) {
    const tag = m[0];
    const name = attr(tag, "name");
    const rid = attr(tag, "r:id");
    if (!name || !rid) continue;
    const target = ridToTarget.get(rid);
    if (!target) continue;
    const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const relsPath = sheetPath.replace("worksheets/", "worksheets/_rels/").replace(/\.xml$/, ".xml.rels");
    byName.set(name, { sheetPath, relsPath });
  }
  return { byName };
}

/** Add Override entries for chart + drawing parts if not already present. */
function ensureContentTypes(ctXml: string, chartCount: number, drawingName: string): string {
  let out = ctXml;
  const drawingPart = `/xl/drawings/${drawingName}`;
  if (!out.includes(`PartName="${drawingPart}"`)) {
    out = out.replace(
      "</Types>",
      `<Override PartName="${drawingPart}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
    );
  }
  for (let i = 1; i <= chartCount; i += 1) {
    const chartPart = `/xl/charts/chart${i}.xml`;
    if (!out.includes(`PartName="${chartPart}"`)) {
      out = out.replace(
        "</Types>",
        `<Override PartName="${chartPart}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
      );
    }
  }
  return out;
}

/** Inject `<drawing r:id="rIdN"/>` into the worksheet XML (before </worksheet>). */
function injectDrawingRef(sheetXml: string, drawingRId: string): string {
  // If there's already a drawing element, leave it.
  if (/<drawing\s/.test(sheetXml)) return sheetXml;
  const ref = `<drawing r:id="${drawingRId}"/>`;
  // Insert before </worksheet> but after any existing <pageMargins>/etc.
  return sheetXml.replace(/<\/worksheet>/, `${ref}</worksheet>`);
}

/** Add a drawing relationship to the worksheet rels (rId for the drawing). */
function addWorksheetRel(relsXml: string | undefined, drawingName: string): { relsXml: string; rId: string } {
  // Find max existing rId.
  const ids: number[] = [];
  if (relsXml) {
    const re = /Id="rId(\d+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(relsXml)) !== null) ids.push(parseInt(m[1], 10));
  }
  const next = ids.length ? Math.max(...ids) + 1 : 1;
  const rId = `rId${next}`;
  const rel = `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/${drawingName}"/>`;
  const open = relsXml && relsXml.includes("<Relationships")
    ? relsXml.replace(/(<Relationships[^>]*>)/, `$1${rel}`)
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.rels}">${rel}</Relationships>`;
  return { relsXml: open, rId };
}

/**
 * Post-process an ExcelJS xlsx buffer: inject one scatter chart per spec,
 * anchored on the named worksheet. Charts are grouped by sheetName — one
 * drawing per sheet holds all that sheet's charts.
 */
export async function injectCharts(buffer: Buffer, specs: ChartSpec[]): Promise<Buffer> {
  if (specs.length === 0) return buffer;
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);

  const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const { byName } = parseSheets(workbookXml, relsXml);

  // Group specs by sheet so each sheet gets one drawing with all its charts.
  const bySheet = new Map<string, ChartSpec[]>();
  for (const s of specs) {
    const arr = bySheet.get(s.sheetName) ?? [];
    arr.push(s);
    bySheet.set(s.sheetName, arr);
  }

  let chartCounter = 0;
  // Pick the next free drawing number by scanning existing entries; start
  // at 1 if there are no drawings yet (e.g. a Series-only export).
  const existingDrawings = Object.keys(zip.files).filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n));
  let drawingCounter = 1;
  for (const n of existingDrawings) {
    const m = n.match(/drawing(\d+)\.xml/);
    if (m) drawingCounter = Math.max(drawingCounter, parseInt(m[1], 10) + 1);
  }

  for (const [sheetName, sheetSpecs] of bySheet) {
    const info = byName.get(sheetName);
    if (!info) continue;
    const sheetFile = zip.file(info.sheetPath);
    if (!sheetFile) continue;
    let sheetXml = await sheetFile.async("string");

    const drawingName = `drawing${drawingCounter}.xml`;
    const drawingPath = `xl/drawings/${drawingName}`;
    const drawingRelsPath = `xl/drawings/_rels/${drawingName}.rels`;

    // Build chart parts + drawing + rels.
    const chartRels: string[] = [];
    for (const spec of sheetSpecs) {
      chartCounter += 1;
      const chartPath = `xl/charts/chart${chartCounter}.xml`;
      zip.file(chartPath, buildChartXml(spec, chartCounter));
      chartRels.push(
        `<Relationship Id="rId${chartRels.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartCounter}.xml"/>`,
      );
    }
    zip.file(drawingPath, buildDrawingXml(sheetSpecs));
    zip.file(
      drawingRelsPath,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.rels}">${chartRels.join("")}</Relationships>`,
    );

    // Link the worksheet to the drawing.
    const relsFile = zip.file(info.relsPath);
    const existingRels = relsFile ? await relsFile.async("string") : undefined;
    const { relsXml: newRels, rId } = addWorksheetRel(existingRels, drawingName);
    zip.file(info.relsPath, newRels);

    sheetXml = injectDrawingRef(sheetXml, rId);
    zip.file(info.sheetPath, sheetXml);

    drawingCounter += 1;
  }

  // Update [Content_Types].xml — add overrides for every new chart + drawing.
  const ctFile = zip.file("[Content_Types].xml")!;
  let ctXml = await ctFile.async("string");
  for (const sheetName of bySheet.keys()) {
    // Each sheet got one drawing; recompute its name is awkward here — just
    // add overrides for every chartN.xml and every drawing we created.
  }
  // Simpler: scan the zip for all chartN.xml and drawing*.xml we now hold and
  // ensure each has an Override. The Spectrum image's drawing1 is already
  // declared by ExcelJS, so skip names already present.
  const allCharts = Object.keys(zip.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n));
  const allDrawings = Object.keys(zip.files).filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n));
  for (const p of allDrawings) {
    const part = `/${p}`;
    if (!ctXml.includes(`PartName="${part}"`)) {
      ctXml = ctXml.replace(
        "</Types>",
        `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`,
      );
    }
  }
  for (const p of allCharts) {
    const part = `/${p}`;
    if (!ctXml.includes(`PartName="${part}"`)) {
      ctXml = ctXml.replace(
        "</Types>",
        `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`,
      );
    }
  }
  zip.file("[Content_Types].xml", ctXml);

  // Also ensure the charts subdirectory has a rels part pointing to nothing
  // extra (not strictly required). Excel is happy without chartN.xml.rels
  // when the chart has no embedded images.
  const out = await zip.generateAsync({
    type: "nodebuffer",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    compression: "DEFLATE",
  });
  return out as unknown as Buffer;
}