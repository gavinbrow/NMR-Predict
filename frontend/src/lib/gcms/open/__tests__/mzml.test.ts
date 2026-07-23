import { describe, expect, it } from "vitest";
import { isMzml, parseMzml } from "../mzml";

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

function spectrum(
  index: number,
  msLevel: number,
  rtSeconds: number,
  mzB64: string,
  intB64: string,
  mzPrecision: 32 | 64,
  intPrecision: 32 | 64,
  extraCv = "",
  defaultArrayLength?: number,
): string {
  const dal = defaultArrayLength ?? undefined;
  const dalAttr = dal !== undefined ? ` defaultArrayLength="${dal}"` : "";
  return (
    `<spectrum index="${index}"${dalAttr}>` +
    `<cvParam accession="MS:1000511" value="${msLevel}" cvName="ms level"/>` +
    `<cvParam accession="MS:1000016" value="${rtSeconds}" unitName="second" cvName="scan start time"/>` +
    `<cvParam accession="MS:1000285" value="${rtSeconds * 100}" cvName="total ion current"/>` +
    (extraCv ? extraCv : "") +
    `<binaryDataArrayList count="2">` +
    `<binaryDataArray>` +
    `<cvParam accession="MS:10005${mzPrecision === 64 ? "23" : "21"}" cvName="${mzPrecision === 64 ? "64-bit float" : "32-bit float"}"/>` +
    `<cvParam accession="MS:1000514" cvName="m/z array"/>` +
    `<cvParam accession="MS:1000576" cvName="no compression"/>` +
    `<binary>${mzB64}</binary>` +
    `</binaryDataArray>` +
    `<binaryDataArray>` +
    `<cvParam accession="MS:10005${intPrecision === 64 ? "23" : "21"}" cvName="${intPrecision === 64 ? "64-bit float" : "32-bit float"}"/>` +
    `<cvParam accession="MS:1000515" cvName="intensity array"/>` +
    `<cvParam accession="MS:1000576" cvName="no compression"/>` +
    `<binary>${intB64}</binary>` +
    `</binaryDataArray>` +
    `</binaryDataArrayList>` +
    `</spectrum>`
  );
}

describe("isMzml", () => {
  it("detects <mzML> in the first 4 KB", () => {
    expect(isMzml(new TextEncoder().encode("<mzML xmlns="))).toBe(true);
    expect(isMzml(new TextEncoder().encode("<indexedmzML>"))).toBe(true);
    expect(isMzml(new TextEncoder().encode("not mzml"))).toBe(false);
  });
});

describe("parseMzml", () => {
  it("parses 64-bit m/z + 32-bit intensity, converts seconds->minutes, sorts ascending", async () => {
    // unsorted m/z: [300, 100, 200] -> must come out [100,200,300]
    const mzB64 = base64Floats([300, 100, 200], 64, true);
    const intB64 = base64Floats([3, 1, 2], 32, true);
    const xml =
      `<?xml version="1.0"?><mzML><run><spectrumList count="1">` +
      spectrum(0, 1, 120, mzB64, intB64, 64, 32, "", 3) +
      `</spectrumList></run></mzML>`;
    const run = await parseMzml(toBuffer(xml), { name: "s.mzml" });
    expect(run.format).toBe("mzml");
    expect(run.scanCount).toBe(1);
    expect(Array.from(run.mz)).toEqual([100, 200, 300]);
    expect(Array.from(run.intensity)).toEqual([1, 2, 3]);
    // 120 seconds -> 2 minutes
    expect(run.rtMin[0]).toBeCloseTo(2, 5);
    expect(run.scanOffset).toEqual(Uint32Array.from([0, 3]));
    expect(run.warnings.some((w) => w.includes("unsorted"))).toBe(true);
  });

  it("counts MS2 spectra in warnings and excludes them", async () => {
    const mz1 = base64Floats([100, 200], 64, true);
    const int1 = base64Floats([5, 6], 32, true);
    const mz2 = base64Floats([50], 64, true);
    const int2 = base64Floats([7], 32, true);
    const xml =
      `<?xml version="1.0"?><mzML><run><spectrumList count="2">` +
      spectrum(0, 1, 60, mz1, int1, 64, 32, "", 2) +
      spectrum(1, 2, 70, mz2, int2, 64, 32, `<cvParam accession="MS:1000744" value="123" cvName="selected ion m/z"/>`, 1) +
      `</spectrumList></run></mzML>`;
    const run = await parseMzml(toBuffer(xml));
    expect(run.scanCount).toBe(1);
    expect(run.mz.length).toBe(2);
    expect(run.warnings.some((w) => /1 MS2\+ spectra were excluded/.test(w))).toBe(true);
  });

  it("warns and skips a numpress (MS:1002312) spectrum instead of misreading", async () => {
    // Build a spectrum whose m/z array declares numpress. The bytes are random
    // garbage — they must NOT be reinterpreted as floats.
    const fakeB64 = Buffer.from(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toString("base64");
    const intB64 = base64Floats([1, 2, 3], 32, true);
    const npSpectrum =
      `<spectrum index="0" defaultArrayLength="3">` +
      `<cvParam accession="MS:1000511" value="1"/>` +
      `<cvParam accession="MS:1000016" value="60" unitName="second"/>` +
      `<binaryDataArrayList count="2">` +
      `<binaryDataArray>` +
      `<cvParam accession="MS:1002312" cvName="numpress linear"/>` +
      `<cvParam accession="MS:1000514" cvName="m/z array"/>` +
      `<binary>${fakeB64}</binary>` +
      `</binaryDataArray>` +
      `<binaryDataArray>` +
      `<cvParam accession="MS:1000521"/>` +
      `<cvParam accession="MS:1000515" cvName="intensity array"/>` +
      `<cvParam accession="MS:1000576"/>` +
      `<binary>${intB64}</binary>` +
      `</binaryDataArray>` +
      `</binaryDataArrayList>` +
      `</spectrum>`;
    const xml =
      `<?xml version="1.0"?><mzML><run><spectrumList count="1">${npSpectrum}</spectrumList></run></mzML>`;
    const run = await parseMzml(toBuffer(xml));
    expect(run.scanCount).toBe(0);
    expect(run.warnings.some((w) => w.includes("MS:1002312"))).toBe(true);
  });

  it("returns an empty valid run when there are no spectra", async () => {
    const xml = `<?xml version="1.0"?><mzML><run><spectrumList count="0"></spectrumList></run></mzML>`;
    const run = await parseMzml(toBuffer(xml));
    expect(run.scanCount).toBe(0);
    expect(run.mz.length).toBe(0);
    expect(run.scanOffset.length).toBe(1);
    expect(run.warnings.length).toBeGreaterThan(0);
  });
});