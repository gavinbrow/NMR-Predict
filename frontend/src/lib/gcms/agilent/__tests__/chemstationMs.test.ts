import { describe, expect, it } from "vitest";
import { isChemStationMs, parseChemStationMs } from "../chemstationMs";

// Build a synthetic ChemStation DATA.MS buffer with a DataView. The layout
// follows the byte-for-byte spec: a fixed header, then three scan records
// (pairs stored DESCENDING in m/z), then two directories back-to-back.
//
// Golden values inside the fixture:
//   - scan 0 RT = 1000 ms, 2 pairs: mz 4022/20=201.1 (abund raw 0x4001 -> 8)
//                                 mz 2000/20=100.0 (abund raw 0x8002 -> 128)
//     -> ascending output [100.0, 201.1], TIC = 8 + 128 = 136
//   - scan 1 RT = 2000 ms, 1 pair: mz 5000/20=250.0 (abund raw 0xC003 -> 1536)
//     -> TIC = 1536
//   - scan 2 RT = 3000 ms, 1 pair: mz 5020/20=251.0 (abund raw 0x2001 -> 1*8^0... wait)
//     For a clean exponent-0 case use raw 0x0001 -> (1 & 0x3FFF) * 8^0 = 1.
//     -> TIC = 1
//
// The trailer u16 of each record is deliberately set to a WRONG value so we
// prove the decoder ignores it and uses the summed abundances instead.

const MAGIC = 0x0132;
const FILE_TYPE = "GC / MS DATA FILE";
const SAMPLE = "                AcSDCPD";
const OPERATOR = "Gavin";
const DATE = "21 Jul 26   4:40 pm";
const INSTRUMENT = "Instrumen";
const INLET = "GC";
const METHOD = "GavinMethod        ";

function writePascal(dv: DataView, off: number, s: string): number {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) bytes[i] = s.charCodeAt(i) & 0xff;
  dv.setUint8(off, s.length);
  for (let i = 0; i < s.length; i += 1) dv.setUint8(off + 1 + i, bytes[i]);
  return off + 1 + s.length;
}

interface ScanSpec {
  rtMs: number;
  pairs: { mzRaw: number; abundRaw: number }[]; // DESCENDING in mzRaw (caller order)
  basePeakMzRaw: number;
  basePeakAbundRaw: number;
}

function buildRecord(dv: DataView, off: number, spec: ScanSpec): number {
  const npairs = spec.pairs.length;
  const byteLen = 28 + 4 * npairs; // = 2 * lenWords, lenWords = 14 + 2*npairs
  const lenWords = byteLen / 2;

  dv.setUint16(off + 0, lenWords, false);
  dv.setUint32(off + 2, spec.rtMs, false);
  dv.setUint16(off + 6, 2 * npairs + 6, false);
  dv.setUint16(off + 8, 1, false);
  dv.setUint16(off + 10, 0, false);
  dv.setUint16(off + 12, npairs, false);
  dv.setUint16(off + 14, spec.basePeakMzRaw, false);
  dv.setUint16(off + 16, spec.basePeakAbundRaw, false);

  for (let i = 0; i < npairs; i += 1) {
    dv.setUint16(off + 18 + i * 4 + 0, spec.pairs[i].mzRaw, false);
    dv.setUint16(off + 18 + i * 4 + 2, spec.pairs[i].abundRaw, false);
  }

  // Trailer prefix (8 bytes) + deliberately WRONG trailer u16 (the last 2 bytes
  // of the record). The decoder must ignore it.
  const trailerStart = off + byteLen - 10;
  dv.setUint8(trailerStart + 0, 0x00);
  dv.setUint8(trailerStart + 1, 0x05);
  dv.setUint8(trailerStart + 2, 0x00);
  dv.setUint8(trailerStart + 3, 0x04);
  dv.setUint8(trailerStart + 4, 0x00);
  dv.setUint8(trailerStart + 5, 0x00);
  dv.setUint8(trailerStart + 6, 0x00);
  dv.setUint8(trailerStart + 7, 0x00);
  // Last 2 bytes = WRONG TIC trailer.
  dv.setUint16(off + byteLen - 2, 0xffff, false);

  return off + byteLen;
}

interface BuiltFile {
  buffer: ArrayBuffer;
  scans: ScanSpec[];
  scanCount: number;
  dataStartBytes: number;
  dirStartBytes: number;
}

function buildFile(scans: ScanSpec[], truncateLastRecord: boolean): BuiltFile {
  const headerBytes = 0x12a; // minimum header length the parser requires
  const scanCount = scans.length;

  const dataStartBytes = 0x400; // place records well past the header
  let recordsBytes = 0;
  for (const s of scans) recordsBytes += 28 + 4 * s.pairs.length;
  if (truncateLastRecord) {
    // Truncate the last record by chopping off its final pair (4 bytes) so the
    // record's declared length runs past the buffer end.
    recordsBytes -= 4;
  }
  const dirStartBytes = dataStartBytes + recordsBytes;
  const dirBytes = scanCount * 12 * 2;
  // When truncating, end the buffer right after the (shortened) records area so
  // the final record's declared length runs past the end. Otherwise include the
  // two directory blocks.
  const totalBytes = truncateLastRecord
    ? Math.max(headerBytes, dirStartBytes)
    : Math.max(headerBytes, dirStartBytes + dirBytes + 4);

  const buffer = new ArrayBuffer(totalBytes);
  const dv = new DataView(buffer);

  // Header.
  dv.setUint16(0x000, MAGIC, false);
  writePascal(dv, 0x004, FILE_TYPE);
  writePascal(dv, 0x018, SAMPLE);
  // 0x056 description, 16 spaces — optional, skip.
  writePascal(dv, 0x094, OPERATOR);
  writePascal(dv, 0x0b2, DATE);
  writePascal(dv, 0x0d0, INSTRUMENT);
  writePascal(dv, 0x0da, INLET);
  writePascal(dv, 0x0e4, METHOD);

  // Word offsets (1-based): byteOffset = 2*words - 2.
  const dirWords = dirStartBytes / 2 + 1;
  const dataWords = dataStartBytes / 2 + 1;
  dv.setUint32(0x104, dirWords, false);
  dv.setUint32(0x108, dataWords, false);
  dv.setUint16(0x118, scanCount, false);
  dv.setUint32(0x11a, scans[0].rtMs, false);
  dv.setUint32(0x11e, scans[scans.length - 1].rtMs, false);

  // Records.
  let off = dataStartBytes;
  const starts: number[] = [];
  for (let i = 0; i < scans.length; i += 1) {
    starts.push(off);
    // When truncating, the last record is written with its FULL declared
    // length header but the buffer is shorter, so the walk stops.
    if (truncateLastRecord && i === scans.length - 1) {
      const s = scans[i];
      const npairs = s.pairs.length;
      const fullByteLen = 28 + 4 * npairs;
      const lenWords = fullByteLen / 2;
      dv.setUint16(off + 0, lenWords, false);
      dv.setUint32(off + 2, s.rtMs, false);
      dv.setUint16(off + 6, 2 * npairs + 6, false);
      dv.setUint16(off + 8, 1, false);
      dv.setUint16(off + 10, 0, false);
      dv.setUint16(off + 12, npairs, false);
      dv.setUint16(off + 14, s.basePeakMzRaw, false);
      dv.setUint16(off + 16, s.basePeakAbundRaw, false);
      // Only write npairs-1 pairs; the buffer ends here.
      for (let p = 0; p < npairs - 1; p += 1) {
        dv.setUint16(off + 18 + p * 4 + 0, s.pairs[p].mzRaw, false);
        dv.setUint16(off + 18 + p * 4 + 2, s.pairs[p].abundRaw, false);
      }
      break;
    }
    off = buildRecord(dv, off, scans[i]);
  }

  // Directory A: { offsetWords, rtMs, tic } per scan. Skip when truncated
  // (the buffer ends before the directory area).
  if (!truncateLastRecord) {
    for (let i = 0; i < scanCount; i += 1) {
      const startBytes = starts[i];
      const offsetWords = startBytes / 2 + 1;
      const base = dirStartBytes + i * 12;
      dv.setUint32(base + 0, offsetWords, false);
      dv.setUint32(base + 4, scans[i].rtMs, false);
      // TIC value here is the directory's value; the parser cross-checks it but
      // uses its own summed TIC. Set it to match the summed TIC so no warning.
      let dirTic = 0;
      for (const p of scans[i].pairs) dirTic += (p.abundRaw & 0x3fff) * 8 ** (p.abundRaw >>> 14);
      dv.setUint32(base + 8, dirTic, false);
    }
    // Directory B: { offsetWords, rtMs, basePeakAbund } per scan.
    for (let i = 0; i < scanCount; i += 1) {
      const startBytes = starts[i];
      const offsetWords = startBytes / 2 + 1;
      const base = dirStartBytes + scanCount * 12 + i * 12;
      dv.setUint32(base + 0, offsetWords, false);
      dv.setUint32(base + 4, scans[i].rtMs, false);
      // basePeakAbund from the packed u16 at +16, decoded.
      const abRaw = scans[i].basePeakAbundRaw;
      dv.setUint32(base + 8, (abRaw & 0x3fff) * 8 ** (abRaw >>> 14), false);
    }
  }

  return { buffer, scans, scanCount, dataStartBytes, dirStartBytes };
}

const SCANS: ScanSpec[] = [
  {
    rtMs: 1000,
    // DESCENDING in mzRaw: 4022 (201.1) then 2000 (100.0).
    pairs: [
      { mzRaw: 4022, abundRaw: 0x4001 }, // mz 201.1, abund 1*8 = 8
      { mzRaw: 2000, abundRaw: 0x8002 }, // mz 100.0, abund 2*64 = 128
    ],
    basePeakMzRaw: 4022,
    basePeakAbundRaw: 0x8002, // 128 (the base peak)
  },
  {
    rtMs: 2000,
    pairs: [{ mzRaw: 5000, abundRaw: 0xc003 }], // mz 250.0, abund 3*512 = 1536
    basePeakMzRaw: 5000,
    basePeakAbundRaw: 0xc003,
  },
  {
    rtMs: 3000,
    pairs: [{ mzRaw: 5020, abundRaw: 0x0001 }], // mz 251.0, abund 1
    basePeakMzRaw: 5020,
    basePeakAbundRaw: 0x0001,
  },
];

describe("isChemStationMs", () => {
  it("recognises the synthetic header", () => {
    const { buffer } = buildFile(SCANS, false);
    expect(isChemStationMs(new Uint8Array(buffer))).toBe(true);
  });

  it("rejects random bytes", () => {
    const bytes = new Uint8Array(128);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37) & 0xff;
    expect(isChemStationMs(bytes)).toBe(false);
  });

  it("recognises the banner even without the magic", () => {
    const bytes = new Uint8Array(64);
    const banner = "GC / MS DATA FILE";
    for (let i = 0; i < banner.length; i += 1) bytes[4 + i] = banner.charCodeAt(i);
    expect(isChemStationMs(bytes)).toBe(true);
  });
});

describe("parseChemStationMs synthetic 3-scan file", () => {
  const { buffer } = buildFile(SCANS, false);

  it("parses scanCount and RTs", () => {
    const run = parseChemStationMs(buffer);
    expect(run.scanCount).toBe(3);
    expect(run.rtMin[0]).toBeCloseTo(1000 / 60000, 6);
    expect(run.rtMin[1]).toBeCloseTo(2000 / 60000, 6);
    expect(run.rtMin[2]).toBeCloseTo(3000 / 60000, 6);
  });

  it("returns mz ASCENDING even though stored DESCENDING", () => {
    const run = parseChemStationMs(buffer);
    // Scan 0: stored [201.1, 100.0] descending -> output [100.0, 201.1].
    const lo = run.scanOffset[0];
    const hi = run.scanOffset[1];
    expect(run.mz[lo]).toBeCloseTo(100.0, 6);
    expect(run.mz[lo + 1]).toBeCloseTo(201.1, 6);
    for (let i = 0; i < run.scanCount; i += 1) {
      const s = run.scanOffset[i];
      const e = run.scanOffset[i + 1];
      for (let p = s + 1; p < e; p += 1) {
        expect(run.mz[p]).toBeGreaterThanOrEqual(run.mz[p - 1]);
      }
    }
  });

  it("decodes exponent-packed abundances", () => {
    const run = parseChemStationMs(buffer);
    // Scan 0: abund 8 (raw 0x4001) and 128 (raw 0x8002).
    const s0 = run.scanOffset[0];
    expect(run.intensity[s0]).toBeCloseTo(128, 6); // base peak (mz 100.0 is first)
    expect(run.intensity[s0 + 1]).toBeCloseTo(8, 6);
    // Scan 1: abund 1536 (raw 0xC003).
    const s1 = run.scanOffset[1];
    expect(run.intensity[s1]).toBeCloseTo(1536, 6);
    // Scan 2: abund 1 (raw 0x0001).
    const s2 = run.scanOffset[2];
    expect(run.intensity[s2]).toBeCloseTo(1, 6);
  });

  it("decodes m/z with the constant divisor 20 (4022 -> 201.1)", () => {
    const run = parseChemStationMs(buffer);
    const s0 = run.scanOffset[0];
    expect(run.mz[s0 + 1]).toBeCloseTo(201.1, 6);
  });

  it("computes TIC as the SUM of decoded abundances, ignoring the trailer u16", () => {
    const run = parseChemStationMs(buffer);
    // The trailer u16 of every record is 0xffff; prove it is ignored.
    expect(run.tic[0]).toBeCloseTo(8 + 128, 6); // 136, not 0xffff
    expect(run.tic[1]).toBeCloseTo(1536, 6);
    expect(run.tic[2]).toBeCloseTo(1, 6);
    expect(run.ticRange[0]).toBeCloseTo(1, 6);
    expect(run.ticRange[1]).toBeCloseTo(1536, 6);
  });

  it("populates meta from the header pascal strings, trimmed", () => {
    const run = parseChemStationMs(buffer);
    expect(run.meta.sample).toBe("AcSDCPD");
    expect(run.meta.operator).toBe("Gavin");
    expect(run.meta.method).toBe("GavinMethod");
    expect(run.meta.inlet).toBe("GC");
    expect(run.meta.instrument).toBe("Instrumen");
    expect(run.meta.acquiredDate).toBe("21 Jul 26   4:40 pm");
  });

  it("computes mzRange, pointCount, scanCount from decoded data", () => {
    const run = parseChemStationMs(buffer);
    expect(run.pointCount).toBe(2 + 1 + 1);
    expect(run.mzRange[0]).toBeCloseTo(100.0, 6);
    expect(run.mzRange[1]).toBeCloseTo(251.0, 6);
    expect(run.rtRange[0]).toBeCloseTo(1000 / 60000, 6);
    expect(run.rtRange[1]).toBeCloseTo(3000 / 60000, 6);
  });

  it("sets msLevel=1 and basePeakMz from the record +14 field", () => {
    const run = parseChemStationMs(buffer);
    for (let i = 0; i < run.scanCount; i += 1) expect(run.msLevel[i]).toBe(1);
    expect(run.basePeakMz[0]).toBeCloseTo(201.1, 6);
    expect(run.basePeakMz[1]).toBeCloseTo(250.0, 6);
    expect(run.basePeakMz[2]).toBeCloseTo(251.0, 6);
  });

  it("sets basePeakIntensity from Directory B", () => {
    const run = parseChemStationMs(buffer);
    expect(run.basePeakIntensity[0]).toBeCloseTo(128, 6);
    expect(run.basePeakIntensity[1]).toBeCloseTo(1536, 6);
    expect(run.basePeakIntensity[2]).toBeCloseTo(1, 6);
  });

  it("does not throw on a buffer shorter than 0x12A", () => {
    const tiny = new ArrayBuffer(0x80);
    const run = parseChemStationMs(tiny);
    expect(run.scanCount).toBe(0);
    expect(run.warnings.length).toBeGreaterThan(0);
  });

  it("returns the first two scans + a warning on a truncated final record", () => {
    const { buffer } = buildFile(SCANS, true);
    const run = parseChemStationMs(buffer);
    expect(run.scanCount).toBe(2);
    expect(run.warnings.length).toBeGreaterThan(0);
    expect(run.warnings.some((w) => /scan 2/.test(w))).toBe(true);
    expect(run.tic[0]).toBeCloseTo(136, 6);
    expect(run.tic[1]).toBeCloseTo(1536, 6);
  });

  it("calls onProgress with fractions in [0,1]", () => {
    const seen: number[] = [];
    const { buffer } = buildFile(SCANS, false);
    parseChemStationMs(buffer, { onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(0);
    for (const f of seen) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});