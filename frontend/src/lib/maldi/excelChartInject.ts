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

/** Absolute-ify an A1 range ("A6:A9" → "$A$6:$A$9") — the form Excel itself writes
 *  into `c:f`, and the form that survives a user inserting rows above the block. */
function absoluteRange(range: string): string {
  return range.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (_m, _d1, col, _d2, row) => `$${col}$${row}`);
}

/** A chart title / axis title block (CT_Title: tx?, layout?, overlay?, …). */
function titleXml(text: string, sizeHundredths: number, bold: boolean): string {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sizeHundredths}" b="${bold ? 1 : 0}"/></a:pPr><a:r><a:rPr lang="en-US" sz="${sizeHundredths}" b="${bold ? 1 : 0}"/><a:t>${xmlEscape(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
}

/**
 * One value axis. The child order below is the CT_ValAx sequence from the OOXML
 * schema — axId, scaling, delete, axPos, majorGridlines?, title?, numFmt?,
 * majorTickMark?, minorTickMark?, tickLblPos?, …, crossAx, crosses?, crossBetween?.
 * Excel validates the sequence strictly: getting `numFmt` and `title` the wrong way
 * round is enough for it to discard the whole drawing on open.
 */
function valAxXml(
  axId: number,
  crossAxId: number,
  pos: "b" | "l",
  title: string,
  numFmt: string,
  sourceLinked: boolean,
  gridlines: boolean,
): string {
  return (
    `<c:valAx><c:axId val="${axId}"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="${pos}"/>` +
    (gridlines ? `<c:majorGridlines/>` : "") +
    titleXml(title, 1000, false) +
    `<c:numFmt formatCode="${xmlEscape(numFmt)}" sourceLinked="${sourceLinked ? 1 : 0}"/>` +
    `<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>` +
    `<c:crossAx val="${crossAxId}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/>` +
    `</c:valAx>`
  );
}

/**
 * Build the chartN.xml body for one scatter chart with a linear trendline that
 * displays the equation and R² on the chart.
 *
 * Every element here is in schema order and every part is closed. That sounds
 * obvious, but this file is hand-written OOXML with no validator in the loop: a
 * single unclosed `c:spPr` or an out-of-sequence child makes Excel drop the
 * drawing on open ("Removed Part: /xl/drawings/drawingN.xml") rather than report
 * an error, so the charts silently vanish. `excelChartInject.test.ts` asserts the
 * well-formedness and the orderings that previously broke.
 */
function buildChartXml(spec: ChartSpec, chartIndex: number): string {
  // Sheet names are single-quoted in formulas; an apostrophe inside is doubled.
  const sheetRef = `'${spec.sheetName.replace(/'/g, "''")}'!`;
  const xRef = xmlEscape(`${sheetRef}${absoluteRange(spec.xRange)}`);
  const yRef = xmlEscape(`${sheetRef}${absoluteRange(spec.yRange)}`);
  // Distinct axis ids per chart part keep Excel from associating axes across the
  // charts it loads from one drawing.
  const xAxId = 100000000 + chartIndex * 2;
  const yAxId = 100000001 + chartIndex * 2;

  // One scatter series: markers only (the series line is switched off so the
  // dashed red trendline is the only line on the plot), plus a linear trendline
  // whose label carries the equation and R².
  const ser =
    `<c:ser><c:idx val="0"/><c:order val="0"/>` +
    `<c:tx><c:v>Neutral mass vs n</c:v></c:tx>` +
    `<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr>` +
    `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="1F77B4"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="1F77B4"/></a:solidFill></a:ln></c:spPr></c:marker>` +
    `<c:trendline><c:spPr><a:ln w="19050"><a:solidFill><a:srgbClr val="D62728"/></a:solidFill><a:prstDash val="dash"/></a:ln></c:spPr>` +
    `<c:trendlineType val="linear"/><c:dispRSqr val="1"/><c:dispEq val="1"/>` +
    `<c:trendlineLbl><c:layout/><c:numFmt formatCode="General" sourceLinked="0"/></c:trendlineLbl></c:trendline>` +
    `<c:xVal><c:numRef><c:f>${xRef}</c:f></c:numRef></c:xVal>` +
    `<c:yVal><c:numRef><c:f>${yRef}</c:f></c:numRef></c:yVal>` +
    `<c:smooth val="0"/></c:ser>`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">` +
    `<c:lang val="en-US"/><c:roundedCorners val="0"/>` +
    `<c:chart>` +
    titleXml(spec.title, 1200, true) +
    `<c:autoTitleDeleted val="0"/>` +
    `<c:plotArea><c:layout/>` +
    `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>` +
    ser +
    `<c:axId val="${xAxId}"/><c:axId val="${yAxId}"/></c:scatterChart>` +
    valAxXml(xAxId, yAxId, "b", "n (oligomer number)", "General", true, false) +
    valAxXml(yAxId, xAxId, "l", "Neutral mass (Da)", "0.0000", false, true) +
    `</c:plotArea>` +
    `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>` +
    `</c:chart></c:chartSpace>`
  );
}

/**
 * Build the `<xdr:twoCellAnchor>` frames that place one chart each on a worksheet
 * (top-left cell → bottom-right cell). Returns just the anchors so they can either
 * open a fresh drawing part or be appended to one the workbook already has.
 * `rIds[i]` is the drawing relationship pointing at spec `i`'s chart part, and
 * `shapeIdBase` offsets the shape ids so they stay unique alongside existing shapes.
 * 1 column ≈ 642000 EMU at default width; 1 row ≈ 195000 EMU at 14.4pt.
 */
function buildDrawingXml(specs: ChartSpec[], rIds: string[], shapeIdBase = 0): string {
  const COL_EMU = 642000;
  const ROW_EMU = 195000;
  const WIDTH_EMU = 8 * COL_EMU;
  const HEIGHT_EMU = 16 * ROW_EMU;
  return specs
    .map((spec, i) => {
      const cx = spec.anchorCol * COL_EMU;
      const cy = spec.anchorRow * ROW_EMU;
      const id = shapeIdBase + 10 + i;
      return (
        `<xdr:twoCellAnchor>` +
        `<xdr:from><xdr:col>${spec.anchorCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${spec.anchorRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:to><xdr:col>${spec.anchorCol + 8}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${spec.anchorRow + 16}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
        `<xdr:graphicFrame macro="">` +
        `<xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="Chart ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
        `<xdr:xfrm><a:off x="${cx}" y="${cy}"/><a:ext cx="${WIDTH_EMU}" cy="${HEIGHT_EMU}"/></xdr:xfrm>` +
        `<a:graphic><a:graphicData uri="${NS.c}"><c:chart xmlns:c="${NS.c}" xmlns:r="${NS.r}" r:id="${rIds[i]}"/></a:graphicData></a:graphic>` +
        `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
      );
    })
    .join("");
}

/** Highest `rIdN` in a relationships part (0 when there are none). */
function maxRelId(relsXml: string | undefined): number {
  if (!relsXml) return 0;
  let max = 0;
  const re = /Id="rId(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(relsXml)) !== null) max = Math.max(max, parseInt(m[1], 10));
  return max;
}

/** The file name of the drawing a worksheet already references, if any. */
function resolveExistingDrawing(sheetXml: string, sheetRelsXml: string | undefined): string | null {
  const ref = sheetXml.match(/<drawing\s+r:id="([^"]+)"\s*\/>/);
  if (!ref || !sheetRelsXml) return null;
  const rel = sheetRelsXml.match(new RegExp(`<Relationship[^>]*Id="${ref[1]}"[^>]*>`));
  if (!rel) return null;
  const target = rel[0].match(/Target="([^"]+)"/);
  return target ? target[1].split("/").pop() ?? null : null;
}

/** Highest `<xdr:cNvPr id="N">` in a drawing part (0 when there are none). */
function maxShapeId(drawingXml: string): number {
  let max = 0;
  const re = /<xdr:cNvPr\s+id="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(drawingXml)) !== null) max = Math.max(max, parseInt(m[1], 10));
  return max;
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

/**
 * Strip the `editAs` attribute ExcelJS writes onto `<xdr:oneCellAnchor>` — the
 * anchor it uses for every embedded image.
 *
 * `CT_OneCellAnchor` has no attributes in the OOXML schema (only `CT_TwoCellAnchor`
 * carries `editAs`), so Excel flags the part and reports "Repaired Records: Drawing
 * from /xl/drawings/drawing1.xml part (Drawing shape)" on open. The attribute
 * carries no information Excel needs — a one-cell anchor already means "move but
 * don't size with cells" — so dropping it is lossless.
 */
export function sanitizeDrawingXml(xml: string): string {
  return xml.replace(/(<xdr:oneCellAnchor)\s+editAs="[^"]*"/g, "$1");
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
 * Post-process an ExcelJS xlsx buffer: repair the drawings ExcelJS wrote (see
 * {@link sanitizeDrawingXml}) and inject one scatter chart per spec, anchored on
 * the named worksheet. Charts are grouped by sheetName — one drawing per sheet
 * holds all that sheet's charts.
 *
 * Always worth running even with no specs: a workbook that embeds the spectrum
 * image still needs the drawing fix, or Excel reports a repair on open.
 */
export async function injectCharts(
  buffer: Uint8Array | ArrayBuffer,
  specs: ChartSpec[],
): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);

  // Repair every drawing ExcelJS produced before adding ours.
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/drawings\/drawing\d+\.xml$/.test(name)) continue;
    const xml = await zip.file(name)!.async("string");
    const fixed = sanitizeDrawingXml(xml);
    if (fixed !== xml) zip.file(name, fixed);
  }

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
    const relsFile = zip.file(info.relsPath);
    const sheetRelsXml = relsFile ? await relsFile.async("string") : undefined;

    // A worksheet can reference exactly one drawing. If it already has one (an
    // embedded image, say) our chart frames are appended to that part; adding a
    // second drawing would leave an orphan the charts never render from.
    const existing = resolveExistingDrawing(sheetXml, sheetRelsXml);
    const drawingName = existing ?? `drawing${drawingCounter}.xml`;
    const drawingPath = `xl/drawings/${drawingName}`;
    const drawingRelsPath = `xl/drawings/_rels/${drawingName}.rels`;

    // Build the chart parts, and one drawing relationship per chart. Relationship
    // ids continue past whatever the existing drawing already uses.
    const existingDrawingRelsFile = zip.file(drawingRelsPath);
    const existingDrawingRels = existingDrawingRelsFile
      ? await existingDrawingRelsFile.async("string")
      : undefined;
    let nextRelId = maxRelId(existingDrawingRels) + 1;
    const chartRels: string[] = [];
    const rIds: string[] = [];
    for (const spec of sheetSpecs) {
      chartCounter += 1;
      zip.file(`xl/charts/chart${chartCounter}.xml`, buildChartXml(spec, chartCounter));
      const rId = `rId${nextRelId}`;
      nextRelId += 1;
      rIds.push(rId);
      chartRels.push(
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartCounter}.xml"/>`,
      );
    }

    const existingXml = existing ? await zip.file(drawingPath)?.async("string") : undefined;
    const anchors = buildDrawingXml(sheetSpecs, rIds, existingXml ? maxShapeId(existingXml) : 0);
    if (existingXml != null) {
      zip.file(drawingPath, existingXml.replace(/<\/xdr:wsDr>\s*$/, `${anchors}</xdr:wsDr>`));
      zip.file(
        drawingRelsPath,
        existingDrawingRels
          ? existingDrawingRels.replace(/(<Relationships[^>]*>)/, `$1${chartRels.join("")}`)
          : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.rels}">${chartRels.join("")}</Relationships>`,
      );
    } else {
      zip.file(
        drawingPath,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}">${anchors}</xdr:wsDr>`,
      );
      zip.file(
        drawingRelsPath,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.rels}">${chartRels.join("")}</Relationships>`,
      );
      // Link the worksheet to the new drawing.
      const { relsXml: newRels, rId } = addWorksheetRel(sheetRelsXml, drawingName);
      zip.file(info.relsPath, newRels);
      sheetXml = injectDrawingRef(sheetXml, rId);
      zip.file(info.sheetPath, sheetXml);
      drawingCounter += 1;
    }
  }

  // Update [Content_Types].xml — scan the zip for every chartN.xml and drawingN.xml
  // it now holds and ensure each has an Override. The Spectrum image's drawing is
  // already declared by ExcelJS, so names already present are skipped.
  const ctFile = zip.file("[Content_Types].xml")!;
  let ctXml = await ctFile.async("string");
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
    type: "uint8array",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    compression: "DEFLATE",
  });
  return out;
}