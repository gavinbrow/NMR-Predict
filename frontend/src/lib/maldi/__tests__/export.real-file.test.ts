// One-shot: generate a real xlsx file with the chart injection so a human
// can open it in Excel/LibreOffice and confirm the charts render. Run with:
//   GEN_SAMPLE=1 npx vitest run src/lib/maldi/__tests__/export.real-file.test.ts
import { describe, it, expect } from "vitest";
import { exportReportExcel, type ReportPayload } from "../export";
import type { Peak, Series, Adduct } from "../types";
import JSZip from "jszip";
import { writeFileSync } from "fs";

/** A 1x1 PNG standing in for the captured spectrum, so the workbook exercises the
 *  ExcelJS image drawing alongside the injected charts (that combination is what
 *  produced the "repaired / removed part" dialog). */
const SPECTRUM_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A two-polymer sample: a 44.0262 Da ladder and a 74.0368 Da one, each with its
 *  own end group, both read as [M+Na]+ — the multi-repeat case. */
function buildPayload(): ReportPayload {
  const adducts: Adduct[] = [
    { id: "na", label: "[M+Na]+", massShift: 21.9819, charge: 1, builtin: true },
  ];
  const peaks: Peak[] = [];
  const series: Series[] = [];
  const polymers = [
    { id: "s1", label: "PEG", repeat: 44.026215, end: 18.0106, ns: [6, 7, 8, 9, 10, 11, 12, 13] },
    { id: "s2", label: "PPG", repeat: 74.0368, end: 62.0368, ns: [5, 6, 7, 8, 9, 10] },
  ];
  for (const p of polymers) {
    const members = p.ns.map((n, i) => {
      const neutral = p.end + n * p.repeat;
      const mz = neutral + 21.9819;
      const id = `${p.id}-p${i}`;
      peaks.push({ id, mz, intensity: 1000 - i * 70, centroid: mz });
      return { peakId: id, n };
    });
    series.push({
      id: p.id,
      label: p.label,
      repeatMass: p.repeat,
      endGroupMass: p.end,
      adductId: "na",
      members,
      score: 0.95,
      r2: 0.999,
      endGroupLabel: "H/OH",
      endGroupLocked: true,
    });
  }
  peaks.sort((a, b) => a.mz - b.mz);
  return {
    projectName: "TwoPolymerSample",
    sourceName: "two-polymers.csv",
    pointCount: 43000,
    peaks,
    series,
    adducts,
    repeatMass: 44.026215,
    repeatMasses: [44.026215, 74.0368],
    spectrumPng: SPECTRUM_PNG,
    selectedSeriesIds: [],
  };
}

describe.skipIf(!process.env.GEN_SAMPLE)("real-file generation (manual verification)", () => {
  it("writes a sample xlsx with embedded charts to _work/", async () => {
    const blobs: Blob[] = [];
    const origCreate = URL.createObjectURL;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      blobs.push(b);
      return "blob:x";
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    try {
      await exportReportExcel(buildPayload());
    } finally {
      URL.createObjectURL = origCreate;
      HTMLAnchorElement.prototype.click = origClick;
    }
    const blob = blobs[0];
    const buf = new Uint8Array(await new Promise<ArrayBuffer>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as ArrayBuffer);
      fr.onerror = () => rej(fr.error);
      fr.readAsArrayBuffer(blob);
    }));
    const out = "_work/sample-chart-export.xlsx";
    writeFileSync(out, buf);
    console.log(`[real-file] wrote ${out} (${buf.length} bytes)`);
    // Sanity: one chart per series, and no drawing carries the invalid attribute
    // that made Excel repair the file.
    const zip = await JSZip.loadAsync(buf);
    const charts = Object.keys(zip.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n));
    console.log(`[real-file] embedded charts: ${charts.length}`);
    expect(charts).toHaveLength(2);
    for (const n of Object.keys(zip.files).filter((x) => /^xl\/drawings\/drawing\d+\.xml$/.test(x))) {
      expect(await zip.file(n)!.async("string")).not.toContain("<xdr:oneCellAnchor editAs=");
    }
  });
});