import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { exportReportExcel, type ReportPayload } from "../export";
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

async function buildAndReadSheet(): Promise<string> {
  const cap = captureDownload();
  try {
    await exportReportExcel(buildPayload());
  } finally {
    cap.restore();
  }
  const blob = cap.getBlob();
  expect(blob).toBeTruthy();
  const buf = await blobToUint8Array(blob!);
  return readSeriesSheet(buf);
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

void ExcelJS;