// One-shot: generate a real xlsx file with the chart injection so a human
// can open it in Excel/LibreOffice and confirm the charts render. Run with:
//   GEN_SAMPLE=1 npx vitest run src/lib/maldi/__tests__/export.real-file.test.ts
import { describe, it, expect } from "vitest";
import { exportReportExcel, type ReportPayload } from "../export";
import type { Peak, Series, Adduct } from "../types";
import JSZip from "jszip";
import { writeFileSync } from "fs";

function buildPayload(): ReportPayload {
  const adducts: Adduct[] = [
    { id: "na", label: "[M+Na]+", massShift: 21.9819, charge: 1, builtin: true },
  ];
  const ns = [3, 4, 5, 6, 7, 8, 9, 10];
  const peaks: Peak[] = ns.map((n, i) => {
    const neutral = 100 + n * 22.2;
    const mz = neutral + 21.9819;
    return { id: `p${i}`, mz, intensity: 1000 - i * 80, centroid: mz };
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
    const buf = Buffer.from(await new Promise<ArrayBuffer>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as ArrayBuffer);
      fr.onerror = () => rej(fr.error);
      fr.readAsArrayBuffer(blob);
    }));
    const out = "_work/sample-chart-export.xlsx";
    writeFileSync(out, buf);
    console.log(`[real-file] wrote ${out} (${buf.length} bytes)`);
    // Sanity: zip must list the chart part.
    const zip = await JSZip.loadAsync(buf);
    const hasChart = Object.keys(zip.files).some((n) => /chart\d+\.xml$/.test(n));
    console.log(`[real-file] has embedded chart: ${hasChart}`);
    expect(hasChart).toBe(true);
  });
});