/**
 * Inject native Excel scatter charts into an ExcelJS-produced xlsx buffer.
 *
 * The chart formatting matches a reference workbook (Book1.xlsx) exactly:
 * no chart title, no legend, no chart border, no plot-area border, Arial 12pt
 * bold default font, black (`schemeClr tx1`) axis lines at 28575 EMU, black
 * dotted series line with black circle markers, invisible trendline that shows
 * only the equation (no R²), X axis titled "Repeat Units (n)", Y axis titled
 * "m/z", Y gridlines present but transparent, per-series min/max scaling.
 *
 * ExcelJS 4.4.0 has no chart API, so we post-process the generated zip:
 * for every series block we add a chartN.xml part, anchor it on the target
 * worksheet via a new drawing, and wire up the content-types / relationships
 * that OOXML requires.
 */

export interface ChartSpec {
  /** Worksheet name the chart lives on (and the ranges reference). */
  sheetName: string;
  /** Series name shown in the c:tx element (not visible — no legend — but
   *  required by the schema and useful for accessibility / object inspection). */
  seriesName: string;
  /** X-axis (n) range, e.g. "A27:A38". */
  xRange: string;
  /** Y-axis (raw m/z) range, e.g. "B27:B38". */
  yRange: string;
  /** X-axis minimum (min n value for this series). */
  xMin: number;
  /** X-axis maximum (max n value for this series). */
  xMax: number;
  /** Y-axis minimum (min raw m/z - 500). */
  yMin: number;
  /** Y-axis maximum (max raw m/z + 500). */
  yMax: number;
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

/**
 * An axis title block matching the reference: `<a:rPr lang="en-US"/>` with no
 * explicit size/bold/color so it inherits the chart-space default (Arial 12pt
 * bold).  The `c:overlay val="0"` keeps the title inside the plot area.
 */
function axisTitleXml(text: string): string {
  return (
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:pPr><a:defRPr/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${xmlEscape(text)}</a:t></a:r></a:p>` +
    `</c:rich></c:tx><c:overlay val="0"/></c:title>`
  );
}

/**
 * One value axis formatted to match the reference chart exactly:
 * - 28575 EMU (2.25pt) black (`schemeClr tx1`) axis line
 * - majorTickMark="out", minorTickMark="none", tickLblPos="nextTo"
 * - explicit min/max scaling
 * - optional transparent gridlines (Y axis) or no gridlines (X axis)
 *
 * The child order follows CT_ValAx from the OOXML schema:
 * axId, scaling, delete, axPos, majorGridlines?, title?, numFmt?,
 * majorTickMark?, minorTickMark?, tickLblPos?, spPr?, crossAx,
 * crosses?, crossBetween?, majorUnit?
 */
function valAxXml(
  axId: number,
  crossAxId: number,
  pos: "b" | "l",
  title: string,
  numFmt: string,
  sourceLinked: boolean,
  min: number,
  max: number,
  gridlines: "none" | "transparent",
): string {
  return (
    `<c:valAx><c:axId val="${axId}"/>` +
    `<c:scaling><c:orientation val="minMax"/><c:max val="${max}"/><c:min val="${min}"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="${pos}"/>` +
    (gridlines === "transparent"
      ? `<c:majorGridlines><c:spPr><a:ln><a:noFill/></a:ln></c:spPr></c:majorGridlines>`
      : "") +
    axisTitleXml(title) +
    `<c:numFmt formatCode="${xmlEscape(numFmt)}" sourceLinked="${sourceLinked ? 1 : 0}"/>` +
    `<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>` +
    `<c:spPr><a:ln w="28575"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></c:spPr>` +
    `<c:crossAx val="${crossAxId}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/>` +
    `</c:valAx>`
  );
}

/**
 * Build the chartN.xml body for one scatter chart, matching the reference
 * workbook (Book1.xlsx) exactly.
 *
 * Key formatting decisions (all from the reference):
 * - No chart title (`autoTitleDeleted val="1"`)
 * - No legend
 * - Chart space: no border (`spPr` with `noFill` line), Arial 12pt bold default font
 * - Plot area: no border (`spPr` with `noFill` line)
 * - Series: black dotted line (`schemeClr tx1`, `prstDash sysDot`), black circle markers
 * - Trendline: invisible line (`noFill`), equation shown (`dispEq=1`), R² hidden (`dispRSqr=0`)
 * - X axis: "Repeat Units (n)", General format, 28575 EMU black line, no gridlines
 * - Y axis: "m/z", integer format, 28575 EMU black line, transparent gridlines
 */
function buildChartXml(spec: ChartSpec, chartIndex: number): string {
  const sheetRef = `'${spec.sheetName.replace(/'/g, "''")}'!`;
  const xRef = xmlEscape(`${sheetRef}${absoluteRange(spec.xRange)}`);
  const yRef = xmlEscape(`${sheetRef}${absoluteRange(spec.yRange)}`);
  const xAxId = 100000000 + chartIndex * 2;
  const yAxId = 100000001 + chartIndex * 2;

  // One scatter series: black dotted line, black circle markers, invisible
  // linear trendline that shows only the equation (no R²).
  const ser =
    `<c:ser><c:idx val="0"/><c:order val="0"/>` +
    `<c:tx><c:v>${xmlEscape(spec.seriesName)}</c:v></c:tx>` +
    `<c:spPr><a:ln><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:prstDash val="sysDot"/></a:ln></c:spPr>` +
    `<c:marker><c:spPr><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:ln><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></c:spPr></c:marker>` +
    `<c:trendline><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>` +
    `<c:trendlineType val="linear"/><c:dispRSqr val="0"/><c:dispEq val="1"/>` +
    `<c:trendlineLbl><c:layout/><c:numFmt formatCode="General" sourceLinked="0"/></c:trendlineLbl></c:trendline>` +
    `<c:xVal><c:numRef><c:f>${xRef}</c:f></c:numRef></c:xVal>` +
    `<c:yVal><c:numRef><c:f>${yRef}</c:f></c:numRef></c:yVal>` +
    `<c:smooth val="0"/></c:ser>`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">` +
    `<c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/>` +
    `<c:style val="2"/>` +
    `<c:chart>` +
    `<c:autoTitleDeleted val="1"/>` +
    `<c:plotArea><c:layout/>` +
    `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>` +
    ser +
    `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>` +
    `<c:axId val="${xAxId}"/><c:axId val="${yAxId}"/></c:scatterChart>` +
    valAxXml(xAxId, yAxId, "b", "Repeat Units (n)", "General", true, spec.xMin, spec.xMax, "none") +
    valAxXml(yAxId, xAxId, "l", "m/z", "0", false, spec.yMin, spec.yMax, "transparent") +
    `<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>` +
    `</c:plotArea>` +
    `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="1"/>` +
    `</c:chart>` +
    `<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>` +
    `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"><a:latin typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:cs typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>` +
    `</c:chartSpace>`
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

  // Also ensure the charts sub-directory has a rels part pointing to nothing
  // extra (not strictly required). Excel is happy without chartN.xml.rels
  // when the chart has no embedded images.
  const out = await zip.generateAsync({
    type: "uint8array",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    compression: "DEFLATE",
  });
  return out;
}