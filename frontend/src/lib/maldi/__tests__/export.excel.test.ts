import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
  ADDUCT_UNASSIGNED,
  collectEndGroupFits,
  exportReportExcel,
  reportableSeries,
  reportRepeatMasses,
  type ReportPayload,
  type ReportSeries,
} from "../export";
import type { Peak, Series, Adduct } from "../types";

/** Build a minimal but realistic payload with one 4-member series. */
function buildPayload(): ReportPayload {
  const adducts: Adduct[] = [
    { id: "na", label: "[M+Na]+", massShift: 21.9819, charge: 1, builtin: true },
  ];
  // Neutral masses ~ 100 + n*22.2; m/z = neutral + 21.9819 (Na adduct).
  const ns = [3, 4, 5, 6];
  const peaks: Peak[] = ns.map((n, i) => {
    const neutral = 100 + n * 22.2;
    const mz = neutral + 21.9819;
    return { id: `p${i}`, mz, intensity: 1000 - i * 100, centroid: mz };
  });
  const series: Series[] = [
    {
      id: "s1",
      label: "S1",
      repeatMass: 22.2,
      endGroupMass: 100,
      adductId: "na",
      members: ns.map((n, i) => ({ peakId: `p${i}`, n })),
      score: 0.95,
      r2: 0.999,
      endGroupLabel: "H/Na",
    },
  ];
  return {
    projectName: "TestProject",
    sourceName: "test.mzML",
    pointCount: 100,
    peaks,
    series,
    adducts,
    repeatMass: 22.2,
    selectedSeriesIds: ["s1"],
  };
}

/** Read a Blob into a Uint8Array via FileReader (jsdom's Blob lacks arrayBuffer). */
function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}

/** Patch URL + anchor.click to capture the xlsx blob instead of downloading. */
function captureDownload(): { restore: () => void; getBlob: () => Blob | undefined } {
  let captured: Blob | undefined;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    captured = b;
    return "blob:test";
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};
  return {
    restore: () => {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      HTMLAnchorElement.prototype.click = origClick;
    },
    getBlob: () => captured,
  };
}

/** Read the Series sheet XML out of the generated xlsx (raw, unmodified). */
async function readSeriesSheet(buffer: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const wb = await zip.file("xl/workbook.xml")!.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const ridToTarget = new Map<string, string>();
  const relRe = /<Relationship\s+Id="([^"]+)"\s+Type="[^"]*\/worksheet"\s+Target="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(rels)) !== null) ridToTarget.set(m[1], m[2]);
  const sheetTagRe = /<sheet\b[^>]*\/>/g;
  const attr = (tag: string, name: string): string | null => {
    const mm = tag.match(new RegExp(`\\s${name}="([^"]+)"`));
    return mm ? mm[1] : null;
  };
  let sheetPath: string | null = null;
  while ((m = sheetTagRe.exec(wb)) !== null) {
    if (attr(m[0], "name") === "Series") {
      const rid = attr(m[0], "r:id");
      const target = rid ? ridToTarget.get(rid) : null;
      if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    }
  }
  if (!sheetPath) throw new Error("Series sheet not found");
  return zip.file(sheetPath)!.async("string");
}

/** Run the export and hand back the raw xlsx bytes. */
async function buildWorkbook(payload: ReportPayload = buildPayload()): Promise<Uint8Array> {
  const cap = captureDownload();
  try {
    await exportReportExcel(payload);
  } finally {
    cap.restore();
  }
  const blob = cap.getBlob();
  expect(blob).toBeTruthy();
  return blobToUint8Array(blob!);
}

async function buildAndReadSheet(): Promise<string> {
  return readSeriesSheet(await buildWorkbook());
}

/** A two-polymer sample: a 22.2 Da ladder and a 44.4 Da one, each its own series. */
function buildTwoPolymerPayload(): ReportPayload {
  const base = buildPayload();
  const ns = [3, 4, 5, 6];
  const peaks2: Peak[] = ns.map((n, i) => {
    const neutral = 250 + n * 44.4;
    const mz = neutral + 21.9819;
    return { id: `q${i}`, mz, intensity: 800 - i * 50, centroid: mz };
  });
  const series2: Series = {
    id: "s2",
    label: "S2",
    repeatMass: 44.4,
    endGroupMass: 250,
    adductId: "na",
    members: ns.map((n, i) => ({ peakId: `q${i}`, n })),
    score: 0.9,
    r2: 0.998,
  };
  return {
    ...base,
    peaks: [...base.peaks, ...peaks2],
    series: [...base.series, series2],
    repeatMass: 22.2,
    repeatMasses: [22.2, 44.4],
    selectedSeriesIds: [],
  };
}

/** Pull every formula cell out of the sheet XML: { cell: "E26", formula: "..." }. */
function extractFormulas(sheetXml: string): { cell: string; formula: string }[] {
  const out: { cell: string; formula: string }[] = [];
  const rowRe = /<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(sheetXml)) !== null) {
    const rowXml = rm[2];
    const cellRe = /<c r="([A-Z]+\d+)"[^>]*>(?:<f[^>]*>([^<]*)<\/f>)?/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowXml)) !== null) {
      if (cm[2] !== undefined) out.push({ cell: cm[1], formula: cm[2] });
    }
  }
  return out;
}

describe("exportReportExcel — series block formulas", () => {
  it("points slope/intercept at the value cells (C/E), not the label cells (B/D)", async () => {
    const sheetXml = await buildAndReadSheet();
    const formulas = extractFormulas(sheetXml);
    const byCell = new Map(formulas.map((f) => [f.cell, f.formula]));

    const slopeCell = [...byCell.entries()].find(([, f]) => f.startsWith("SLOPE("));
    const interceptCell = [...byCell.entries()].find(([, f]) => f.startsWith("INTERCEPT("));
    expect(slopeCell).toBeTruthy();
    expect(interceptCell).toBeTruthy();
    const slopeRef = slopeCell![0];
    const interceptRef = interceptCell![0];
    expect(slopeRef.startsWith("C")).toBe(true);
    expect(interceptRef.startsWith("E")).toBe(true);

    const predictedFormulas = formulas.filter((f) => /\$\w+\$\d+\*\w\d+\+\$\w+\$\d+/.test(f.formula));
    expect(predictedFormulas.length).toBeGreaterThan(0);
    for (const f of predictedFormulas) {
      expect(f.formula).toContain(`$C$`);
      expect(f.formula).toContain(`$E$`);
    }
  });

  it("SLOPE/INTERCEPT ranges cover only data rows, not the column-header row", async () => {
    const sheetXml = await buildAndReadSheet();
    const formulas = extractFormulas(sheetXml);

    const slopeFormula = formulas.find((f) => f.formula.startsWith("SLOPE("))!.formula;
    const m = slopeFormula.match(/SLOPE\(([A-Z]+\d+):([A-Z]+\d+),([A-Z]+\d+):([A-Z]+\d+)\)/);
    expect(m).toBeTruthy();
    const [, yStart, yEnd, xStart, xEnd] = m!;
    const yRows = parseInt(yEnd.replace(/[A-Z]/g, ""), 10) - parseInt(yStart.replace(/[A-Z]/g, ""), 10) + 1;
    const xRows = parseInt(xEnd.replace(/[A-Z]/g, ""), 10) - parseInt(xStart.replace(/[A-Z]/g, ""), 10) + 1;
    expect(yRows).toBe(4);
    expect(xRows).toBe(4);
    expect(yStart.startsWith("D")).toBe(true);
    expect(xStart.startsWith("A")).toBe(true);
  });
});

describe("exportReportExcel — multiple repeat units", () => {
  it("collects every repeat unit in play, de-duplicated and ascending", () => {
    expect(reportRepeatMasses(buildTwoPolymerPayload())).toEqual([22.2, 44.4]);
    // No explicit list: fall back to the active repeat plus the series' own.
    const p = buildTwoPolymerPayload();
    expect(reportRepeatMasses({ ...p, repeatMasses: undefined })).toEqual([22.2, 44.4]);
    // A payload with neither still reports what the series carry.
    expect(reportRepeatMasses({ ...p, repeatMasses: undefined, repeatMass: undefined })).toEqual([
      22.2, 44.4,
    ]);
  });

  it("names both repeat units on the Summary sheet", async () => {
    const buf = await buildWorkbook(buildTwoPolymerPayload());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const summary = wb.getWorksheet("Summary")!;
    let found = "";
    summary.eachRow((r) => {
      if (String(r.getCell(1).value ?? "").startsWith("Repeat unit")) {
        found = String(r.getCell(2).value ?? "");
      }
    });
    expect(found).toContain("22.2000");
    expect(found).toContain("44.4000");
  });

  it("embeds one chart per exported series, each with its repeat in the title", async () => {
    const buf = await buildWorkbook(buildTwoPolymerPayload());
    const zip = await JSZip.loadAsync(buf);
    const charts = Object.keys(zip.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n));
    expect(charts).toHaveLength(2);
    const titles = await Promise.all(
      charts.map(async (n) => (await zip.file(n)!.async("string")).match(/<a:t>([^<]*)<\/a:t>/)![1]),
    );
    expect(titles.some((t) => t.includes("22.20 Da"))).toBe(true);
    expect(titles.some((t) => t.includes("44.40 Da"))).toBe(true);
  });

  it("anchors the charts so they do not overlap each other", async () => {
    const buf = await buildWorkbook(buildTwoPolymerPayload());
    const zip = await JSZip.loadAsync(buf);
    const drawing = await zip.file(
      Object.keys(zip.files).find((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))!,
    )!.async("string");
    const froms = [...drawing.matchAll(/<xdr:from>.*?<xdr:row>(\d+)<\/xdr:row>/g)].map((m) =>
      parseInt(m[1], 10),
    );
    const tos = [...drawing.matchAll(/<xdr:to>.*?<xdr:row>(\d+)<\/xdr:row>/g)].map((m) =>
      parseInt(m[1], 10),
    );
    expect(froms).toHaveLength(2);
    expect(froms[1]).toBeGreaterThanOrEqual(tos[0]);
  });
});
describe("reportableSeries", () => {
  /** A bare series carrying only what the filter looks at. */
  const s = (id: string, supersededBy?: string): Series => ({
    id,
    repeatMass: 44,
    endGroupMass: 18,
    adductId: "na",
    members: [],
    score: 1,
    ...(supersededBy ? { supersededBy } : {}),
  });

  it("drops readings folded into another ladder, keeping the survivor", () => {
    // The shape `assignSeries` + confirm leaves behind: one confirmed [M+Na]+
    // ladder and its [M+H]+/[M+K]+ readings of the same peaks pointing at it.
    const out = reportableSeries([s("na"), s("h", "na"), s("k", "na")]);
    expect(out.map((x) => x.id)).toEqual(["na"]);
  });

  it("drops the parts absorbed by a combine, keeping the combined ladder", () => {
    const out = reportableSeries([s("merged"), s("partA", "merged"), s("partB", "merged")]);
    expect(out.map((x) => x.id)).toEqual(["merged"]);
  });

  it("leaves an untouched list alone", () => {
    const all = [s("a"), s("b")];
    expect(reportableSeries(all).map((x) => x.id)).toEqual(["a", "b"]);
  });

  /** A ladder over the given peak ids, as `assignSeries` emits one per adduct. */
  const ladder = (id: string, adductId: string, peakIds: string[], extra: Partial<Series> = {}): Series => ({
    id,
    repeatMass: 44,
    endGroupMass: 18,
    adductId,
    members: peakIds.map((peakId, n) => ({ peakId, n })),
    score: 1,
    ...extra,
  });

  it("collapses never-confirmed adduct readings of one ladder into a single entry", () => {
    // What the user sees before confirming anything: the SAME peaks assigned
    // three times over, which used to print three blocks and three charts.
    const peaks = ["p0", "p1", "p2", "p3"];
    const out = reportableSeries([
      ladder("h", "h", peaks, { score: 0.7 }),
      ladder("na", "na", peaks, { score: 0.9 }),
      ladder("k", "k", peaks, { score: 0.5 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("na"); // best-scoring reading stands in for the group
    expect(out[0].adductUnassigned).toBe(true);
  });

  it("keeps the confirmed reading, unflagged, when one exists", () => {
    const peaks = ["p0", "p1", "p2", "p3"];
    const out = reportableSeries([
      ladder("h", "h", peaks, { score: 0.9 }),
      ladder("na", "na", peaks, { endGroupLocked: true, score: 0.4 }),
    ]);
    expect(out.map((x) => x.id)).toEqual(["na"]);
    expect(out[0].adductUnassigned).toBeUndefined();
  });

  it("does not collapse ladders that describe different peaks", () => {
    const out = reportableSeries([
      ladder("a", "na", ["p0", "p1", "p2", "p3"]),
      ladder("b", "na", ["q0", "q1", "q2", "q3"]),
    ]);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
    expect(out.every((x) => !x.adductUnassigned)).toBe(true);
  });

  it("leaves a lone unconfirmed ladder unflagged", () => {
    // Nothing to disambiguate against, so the report can still name its adduct.
    const out = reportableSeries([ladder("solo", "na", ["p0", "p1", "p2"])]);
    expect(out.map((x) => x.id)).toEqual(["solo"]);
    expect(out[0].adductUnassigned).toBeUndefined();
  });

  it("keeps the app's ordering", () => {
    const first = ["p0", "p1", "p2", "p3"];
    const second = ["q0", "q1", "q2", "q3"];
    const out = reportableSeries([
      ladder("a-h", "h", first, { score: 0.9 }),
      ladder("b-na", "na", second, { score: 0.9 }),
      ladder("a-na", "na", first, { score: 0.5 }),
      ladder("b-h", "h", second, { score: 0.5 }),
    ]);
    expect(out.map((x) => x.id)).toEqual(["a-h", "b-na"]);
  });
});

describe("collectEndGroupFits", () => {
  const peak = (id: string, mz: number): Peak => ({ id, mz, intensity: 100 });
  const NA: Adduct = { id: "na", label: "[M+Na]+", massShift: 22.9892, charge: 1, builtin: true };

  /** A clean PEG-like ladder: m/z = 18.011 + n·44.026 + Na. */
  const ladderPeaks = [5, 6, 7, 8].map((n) => peak(`p${n}`, 18.0106 + n * 44.02621 + 22.9892));

  const base = (series: ReportSeries[]): ReportPayload => ({
    projectName: "p",
    sourceName: "s",
    pointCount: 0,
    peaks: ladderPeaks,
    series,
    adducts: [NA],
  });

  const ladder = (extra: Partial<Series> = {}): Series => ({
    id: "s1",
    repeatMass: 44.02621,
    endGroupMass: 18.0106,
    adductId: "na",
    members: [5, 6, 7, 8].map((n) => ({ peakId: `p${n}`, n })),
    score: 1,
    ...extra,
  });

  it("fits neutral mass when the adduct is known", () => {
    const [fit] = collectEndGroupFits(base([ladder()]));
    expect(fit.massBasis).toBe("neutral");
    expect(fit.adductLabel).toBe("[M+Na]+");
    expect(fit.repeatFit).toBeCloseTo(44.02621, 4);
    expect(fit.endGroupFit).toBeCloseTo(18.0106, 3);
  });

  it("falls back to observed m/z when no adduct was assigned", () => {
    // Same ladder, no confirmed adduct: the slope still recovers the repeat unit,
    // but the intercept carries the adduct along with the end group — so it must
    // NOT be reported as an end-group mass.
    const [fit] = collectEndGroupFits(base([{ ...ladder(), adductUnassigned: true }]));
    expect(fit.massBasis).toBe("m/z");
    expect(fit.adductLabel).toBe(ADDUCT_UNASSIGNED);
    expect(fit.repeatFit).toBeCloseTo(44.02621, 4);
    expect(fit.endGroupFit).toBeCloseTo(18.0106 + 22.9892, 3);
  });
});
