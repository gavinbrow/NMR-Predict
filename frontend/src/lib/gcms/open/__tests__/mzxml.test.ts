import { describe, expect, it } from "vitest";
import { isMzxml, parseMzxml } from "../mzxml";

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function base64Floats(values: number[], precision: 32 | 64, littleEndian: boolean): string {
  const size = precision === 64 ? 8 : 4;
  const buf = new ArrayBuffer(values.length * size);
  const view = new DataView(buf);
  values.forEach((v, i) => {
    if (precision === 64) view.setFloat64(i * size, v, littleEndian);
    else view.setFloat32(i * size, v, littleEndian);
  });
  return Buffer.from(new Uint8Array(buf)).toString("base64");
}

describe("isMzxml", () => {
  it("detects <mzXML> in the first 4 KB", () => {
    expect(isMzxml(new TextEncoder().encode("<mzXML"))).toBe(true);
    expect(isMzxml(new TextEncoder().encode("not mzxml"))).toBe(false);
  });
});

describe("parseMzxml", () => {
  it("structurally pairs each nested <scan> with its own <peaks> (MS2 inside MS1)", async () => {
    // MS1 scan at RT PT60S (1 min) with peaks [100,5; 200,10] (big-endian float32)
    // Inside it, an MS2 scan at PT70S with peaks [50,1; 75,2]
    // The old index-pairing bug would pair the MS2 <peaks> with the MS1 attrs.
    const ms1B64 = base64Floats([100, 5, 200, 10], 32, false); // big-endian network
    const ms2B64 = base64Floats([50, 1, 75, 2], 32, false);
    const xml =
      `<?xml version="1.0"?><mzXML><msRun>` +
      `<scan num="1" msLevel="1" retentionTime="PT60S" peaksCount="2" totIonCurrent="15">` +
      `<peaks precision="32" byteOrder="network" compressionType="none">${ms1B64}</peaks>` +
      `<scan num="2" msLevel="2" retentionTime="PT70S" peaksCount="2">` +
      `<peaks precision="32" byteOrder="network" compressionType="none">${ms2B64}</peaks>` +
      `</scan>` +
      `</scan>` +
      `</msRun></mzXML>`;
    const run = await parseMzxml(toBuffer(xml), { name: "s.mzxml" });
    expect(run.format).toBe("mzxml");
    expect(run.scanCount).toBe(2);
    // scan 0 = MS1
    expect(run.msLevel[0]).toBe(1);
    expect(run.rtMin[0]).toBeCloseTo(1, 5);
    expect(Array.from(run.mz.subarray(run.scanOffset[0], run.scanOffset[1]))).toEqual([100, 200]);
    expect(Array.from(run.intensity.subarray(run.scanOffset[0], run.scanOffset[1]))).toEqual([5, 10]);
    // scan 1 = MS2 (nested) — proves structural pairing
    expect(run.msLevel[1]).toBe(2);
    expect(run.rtMin[1]).toBeCloseTo(70 / 60, 5);
    expect(Array.from(run.mz.subarray(run.scanOffset[1], run.scanOffset[2]))).toEqual([50, 75]);
    expect(Array.from(run.intensity.subarray(run.scanOffset[1], run.scanOffset[2]))).toEqual([1, 2]);
  });

  it("decodes byteOrder network (big-endian) float64 peaks", async () => {
    const b64 = base64Floats([100, 50, 200, 75], 64, false); // big-endian
    const xml =
      `<?xml version="1.0"?><mzXML><msRun>` +
      `<scan num="1" msLevel="1" retentionTime="PT123.45S"><peaks precision="64" byteOrder="network" compressionType="none">${b64}</peaks></scan>` +
      `</msRun></mzXML>`;
    const run = await parseMzxml(toBuffer(xml));
    expect(run.scanCount).toBe(1);
    expect(Array.from(run.mz)).toEqual([100, 200]);
    expect(Array.from(run.intensity)).toEqual([50, 75]);
    expect(run.rtMin[0]).toBeCloseTo(123.45 / 60, 5);
  });

  it("returns an empty valid run when there are no scans", async () => {
    const xml = `<?xml version="1.0"?><mzXML><msRun></msRun></mzXML>`;
    const run = await parseMzxml(toBuffer(xml));
    expect(run.scanCount).toBe(0);
    expect(run.scanOffset.length).toBe(1);
    expect(run.warnings.length).toBeGreaterThan(0);
  });

  it("parses ISO-8601 retentionTime in seconds (PT123.45S)", async () => {
    const b64 = base64Floats([100, 5], 32, false);
    const xml =
      `<?xml version="1.0"?><mzXML><msRun>` +
      `<scan num="1" msLevel="1" retentionTime="PT123.45S"><peaks precision="32" byteOrder="network" compressionType="none">${b64}</peaks></scan>` +
      `</msRun></mzXML>`;
    const run = await parseMzxml(toBuffer(xml));
    expect(run.scanCount).toBe(1);
    expect(run.rtMin[0]).toBeCloseTo(123.45 / 60, 5);
    // No "assumed minutes" warning for a proper ISO-8601 duration.
    expect(run.warnings.some((w) => w.includes("assumed minutes"))).toBe(false);
  });

  it("parses ISO-8601 retentionTime in minutes (PT2.5M)", async () => {
    const b64 = base64Floats([100, 5], 32, false);
    const xml =
      `<?xml version="1.0"?><mzXML><msRun>` +
      `<scan num="1" msLevel="1" retentionTime="PT2.5M"><peaks precision="32" byteOrder="network" compressionType="none">${b64}</peaks></scan>` +
      `</msRun></mzXML>`;
    const run = await parseMzxml(toBuffer(xml));
    expect(run.scanCount).toBe(1);
    expect(run.rtMin[0]).toBeCloseTo(2.5, 5);
    expect(run.warnings.some((w) => w.includes("assumed minutes"))).toBe(false);
  });

  it("treats a bare retentionTime number as MINUTES and warns once", async () => {
    const b64 = base64Floats([100, 5], 32, false);
    // Two scans (one nested inside the other, as the parser walks a single
    // root <scan> tree) both with bare-number retentionTime, to verify the
    // "assumed minutes" warning is deduplicated to exactly one.
    const xml =
      `<?xml version="1.0"?><mzXML><msRun>` +
      `<scan num="1" msLevel="1" retentionTime="5.23">` +
      `<peaks precision="32" byteOrder="network" compressionType="none">${b64}</peaks>` +
      `<scan num="2" msLevel="2" retentionTime="6.23"><peaks precision="32" byteOrder="network" compressionType="none">${b64}</peaks></scan>` +
      `</scan>` +
      `</msRun></mzXML>`;
    const run = await parseMzxml(toBuffer(xml));
    expect(run.scanCount).toBe(2);
    // Bare numbers are treated as minutes (not seconds / 60).
    expect(run.rtMin[0]).toBeCloseTo(5.23, 5);
    expect(run.rtMin[1]).toBeCloseTo(6.23, 5);
    // Exactly one "assumed minutes" warning, even though two bare-number scans.
    const assumed = run.warnings.filter((w) => w.includes("assumed minutes"));
    expect(assumed.length).toBe(1);
  });
});