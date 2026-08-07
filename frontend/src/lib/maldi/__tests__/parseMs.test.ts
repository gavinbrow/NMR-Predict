import { describe, expect, it } from "vitest";
import { parseMsFile } from "../parseMs";

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function base64Floats(pairs: number[], precision: 32 | 64, littleEndian: boolean): string {
  const size = precision === 64 ? 8 : 4;
  const buf = new ArrayBuffer(pairs.length * size);
  const view = new DataView(buf);
  pairs.forEach((v, i) => {
    if (precision === 64) view.setFloat64(i * size, v, littleEndian);
    else view.setFloat32(i * size, v, littleEndian);
  });
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

describe("parseMsFile — MGF", () => {
  it("parses a peak list", async () => {
    const text = ["BEGIN IONS", "TITLE=test", "PEPMASS=500", "100.5 5", "200.25 10", "300.0 2", "END IONS"].join("\n");
    const result = await parseMsFile(toBuffer(text), "sample.mgf");
    expect(result.meta.format).toBe("mgf");
    expect(Array.from(result.spectrum.mz)).toEqual([100.5, 200.25, 300.0]);
    expect(Array.from(result.spectrum.intensity)).toEqual([5, 10, 2]);
  });
});

describe("parseMsFile — mzXML", () => {
  it("decodes interleaved big-endian float32 peaks", async () => {
    const b64 = base64Floats([100, 50, 200, 75], 32, false); // network = big-endian
    const xml = `<?xml version="1.0"?><mzXML><msRun><scan num="1" msLevel="1" peaksCount="2">` +
      `<peaks precision="32" byteOrder="network" compressionType="none">${b64}</peaks>` +
      `</scan></msRun></mzXML>`;
    const result = await parseMsFile(toBuffer(xml), "sample.mzXML");
    expect(result.meta.format).toBe("mzxml");
    expect(Array.from(result.spectrum.mz)).toEqual([100, 200]);
    expect(Array.from(result.spectrum.intensity)).toEqual([50, 75]);
  });
});

describe("parseMsFile — mzML", () => {
  it("pairs the m/z and intensity little-endian float64 arrays", async () => {
    const mzB64 = base64Floats([100, 200, 300], 64, true);
    const intB64 = base64Floats([9, 8, 7], 64, true);
    const xml = `<?xml version="1.0"?><mzML><run><spectrumList count="1"><spectrum index="0">` +
      `<binaryDataArrayList count="2">` +
      `<binaryDataArray><cvParam accession="MS:1000523"/><cvParam accession="MS:1000514"/><binary>${mzB64}</binary></binaryDataArray>` +
      `<binaryDataArray><cvParam accession="MS:1000523"/><cvParam accession="MS:1000515"/><binary>${intB64}</binary></binaryDataArray>` +
      `</binaryDataArrayList></spectrum></spectrumList></run></mzML>`;
    const result = await parseMsFile(toBuffer(xml), "sample.mzML");
    expect(result.meta.format).toBe("mzml");
    expect(Array.from(result.spectrum.mz)).toEqual([100, 200, 300]);
    expect(Array.from(result.spectrum.intensity)).toEqual([9, 8, 7]);
  });

  it("rejects an unknown file", async () => {
    await expect(parseMsFile(toBuffer("just text"), "x.dat")).rejects.toThrow(/Unrecognized/);
  });
});
