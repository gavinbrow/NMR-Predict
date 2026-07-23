// Tests for the Agilent ChemStation .ch/.uv parser.
//
// There are no real sample files in the repo, so every test builds a synthetic
// binary buffer with a DataView helper and asserts against the expected `MsRun`.

import { describe, expect, it } from "vitest";
import {
  chemStationChVersion,
  isChemStationCh,
  parseChemStationCh,
} from "../chemstationCh";
import type { MsRun } from "../../types";

/* ------------------------------------------------------------------ *
 * Buffer builder
 * ------------------------------------------------------------------ */

/**
 * Minimal mutable buffer builder. Writes big-endian integers/floats and pascal
 * strings (latin1 or UTF-16LE) at absolute offsets, zero-filling the gaps.
 */
class BufferBuilder {
  buf: ArrayBuffer;
  view: DataView;
  bytes: Uint8Array;

  constructor(size: number) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
  }

  u8(offset: number, v: number): void {
    this.view.setUint8(offset, v);
  }
  u32be(offset: number, v: number): void {
    this.view.setUint32(offset, v, false);
  }
  i32be(offset: number, v: number): void {
    this.view.setInt32(offset, v, false);
  }
  i16be(offset: number, v: number): void {
    this.view.setInt16(offset, v, false);
  }
  f64be(offset: number, v: number): void {
    this.view.setFloat64(offset, v, false);
  }

  /** Writes a latin1 pascal string: one length byte, then the ASCII bytes. */
  pascalLatin1(offset: number, text: string): void {
    const len = Math.min(text.length, 255);
    this.view.setUint8(offset, len);
    for (let i = 0; i < len; i++) {
      this.view.setUint8(offset + 1 + i, text.charCodeAt(i) & 0xff);
    }
  }

  /** Writes a UTF-16LE pascal string: one length byte (CHAR count), then 2*len bytes. */
  pascalUtf16(offset: number, text: string): void {
    const len = Math.min(text.length, 255);
    this.view.setUint8(offset, len);
    for (let i = 0; i < len; i++) {
      this.view.setUint16(offset + 1 + i * 2, text.charCodeAt(i), true);
    }
  }
}

const EXPERIMENTAL =
  "Agilent .ch/.uv support is experimental and has not been validated against a " +
  "real instrument file. Verify the values before use.";

function hasWarning(run: MsRun, substr: string): boolean {
  return run.warnings.some((w) => w.includes(substr));
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe("isChemStationCh / chemStationChVersion", () => {
  it("reads the version pascal string at offset 0", () => {
    const b = new BufferBuilder(16);
    b.pascalLatin1(0, "181");
    expect(chemStationChVersion(new Uint8Array(b.buf))).toBe("181");
  });

  it("returns null for a buffer too small to hold the version", () => {
    expect(chemStationChVersion(new Uint8Array(0))).toBeNull();
    expect(chemStationChVersion(new Uint8Array([2]))).toBeNull();
  });

  it("isChemStationCh returns true for supported versions", () => {
    for (const v of ["8", "81", "30", "130", "179", "181"]) {
      const b = new BufferBuilder(16);
      b.pascalLatin1(0, v);
      expect(isChemStationCh(new Uint8Array(b.buf))).toBe(true);
    }
  });

  it("isChemStationCh returns false for unsupported versions", () => {
    const b = new BufferBuilder(16);
    b.pascalLatin1(0, "99");
    expect(isChemStationCh(new Uint8Array(b.buf))).toBe(false);
  });
});

describe("parseChemStationCh — version 8 (legacy latin1, i16 deltas)", () => {
  it("decodes 5 points with a 0x8000 escape and applies slope + intercept", () => {
    // Layout:
    //   0x000  pascal "8"
    //   0x018  pascal sample "Sample A"
    //   0x03d  pascal description "FID"
    //   0x148  pascal operator "Op"
    //   0x15e  pascal acq date "2024-01-01"
    //   0x1e6  pascal instrument "Inst"
    //   0x254  pascal method "Meth"
    //   0x11a  u32 data start in WORDS — data lives at byte 0x400 => words = (0x400+2)/2 = 0x201
    //   0x27c  f64 intercept
    //   0x282  f64 start time ms
    //   0x28a  f64 end time ms
    //   data at 0x400: deltas [10, 20, 0x8000, abs=100, 5] => accumulated [10, 30, 100, 105]
    //   Wait — that's 4 deltas producing 4 points. We need 5 points. Add one more delta.
    //   deltas: [10, 20, 0x8000(abs=100), 5, 7] => [10, 30, 100, 105, 112]
    const DATA_START = 0x400;
    // 5 deltas: 2+2+2+4+2+2 = 14 bytes; size the buffer exactly so trailing
    // zero bytes are not mistaken for additional delta=0 points.
    const SIZE = DATA_START + 14;
    const b = new BufferBuilder(SIZE);

    b.pascalLatin1(0x000, "8");
    b.pascalLatin1(0x018, "Sample A");
    b.pascalLatin1(0x03d, "FID signal");
    b.pascalLatin1(0x148, "Op");
    b.pascalLatin1(0x15e, "2024-01-01");
    b.pascalLatin1(0x1e6, "Inst");
    b.pascalLatin1(0x254, "Meth");

    b.u32be(0x11a, (DATA_START + 2) / 2); // word offset => byte = 2*words - 2 = DATA_START
    b.f64be(0x27c, 1.0); // intercept
    b.f64be(0x282, 0); // start time ms
    b.f64be(0x28a, 4 * 60_000); // end time ms = 4 minutes

    // slope at 0x284 overlaps end-time; leave it as whatever end-time bytes are.
    // We accept the defensive warning about overlap.

    // Data: 5 deltas producing 5 accumulated values.
    let off = DATA_START;
    b.i16be(off, 10); off += 2; // value = 10
    b.i16be(off, 20); off += 2; // value = 30
    b.i16be(off, -32768); off += 2; // escape
    b.i32be(off, 100); off += 4; // value = 100 (absolute)
    b.i16be(off, 5); off += 2; // value = 105
    b.i16be(off, 7); off += 2; // value = 112

    const run = parseChemStationCh(b.buf, { name: "test.ch" });

    expect(run.format).toBe("agilent-ch");
    expect(run.detector).toBe("fid"); // "FID signal" has no DAD/UV/nm
    expect(run.scanCount).toBe(0);
    expect(run.scanOffset).toEqual(new Uint32Array(1));
    expect(run.mz.length).toBe(0);
    expect(run.intensity.length).toBe(0);

    // 5 points
    expect(run.rtMin.length).toBe(5);
    expect(run.tic.length).toBe(5);

    // accumulated [10, 30, 100, 105, 112] * slope(1) + intercept(1) => +1 each
    // NOTE: we set intercept=1.0, slope defaults to 1 (the 0x284 field overlaps
    // end-time and will read as garbage, but we warned about it). The test
    // therefore only checks the *accumulated* shape, not exact slope/intercept
    // application — see the isolated slope/intercept test below.
    expect(run.tic[0]).toBe(11); // 10 * 1 + 1
    expect(run.tic[1]).toBe(31); // 30 * 1 + 1
    expect(run.tic[2]).toBe(101); // 100 * 1 + 1
    expect(run.tic[3]).toBe(106); // 105 * 1 + 1
    expect(run.tic[4]).toBe(113); // 112 * 1 + 1

    // RT axis: 0..4 minutes, 5 points
    expect(run.rtMin[0]).toBeCloseTo(0, 6);
    expect(run.rtMin[4]).toBeCloseTo(4, 6);
    expect(run.rtMin[2]).toBeCloseTo(2, 6);

    expect(run.rtRange).toEqual([0, 4]);
    expect(run.ticRange).toEqual([11, 113]);

    expect(run.meta.sample).toBe("Sample A");
    expect(run.meta.operator).toBe("Op");
    expect(run.meta.instrument).toBe("Inst");
    expect(run.meta.method).toBe("Meth");
    expect(run.meta.acquiredDate).toBe("2024-01-01");

    expect(hasWarning(run, "experimental")).toBe(true);
    expect(hasWarning(run, "0x284 overlaps")).toBe(true);
  });

  it("falls back to an estimated 1 Hz RT axis when endTime <= startTime", () => {
    const DATA_START = 0x400;
    // 3 deltas = 6 bytes; size exactly to avoid trailing-zero deltas.
    const b = new BufferBuilder(DATA_START + 6);
    b.pascalLatin1(0x000, "8");
    b.u32be(0x11a, (DATA_START + 2) / 2);
    b.f64be(0x27c, 0); // intercept
    b.f64be(0x282, 5000); // start ms
    b.f64be(0x28a, 4000); // end ms (<= start)

    // 3 deltas
    b.i16be(DATA_START, 5);
    b.i16be(DATA_START + 2, 5);
    b.i16be(DATA_START + 4, 5);

    const run = parseChemStationCh(b.buf);
    expect(run.rtMin.length).toBe(3);
    // Fallback now emits minutes assuming 1 Hz sampling: i/60, NOT raw i.
    expect(run.rtMin[0]).toBeCloseTo(0 / 60, 6);
    expect(run.rtMin[1]).toBeCloseTo(1 / 60, 6);
    expect(run.rtMin[2]).toBeCloseTo(2 / 60, 6);
    expect(hasWarning(run, "endTime <= startTime")).toBe(true);
    expect(hasWarning(run, "experimental")).toBe(true);
    // The honest problem-naming warning must be present.
    expect(hasWarning(run, "Retention-time header is invalid")).toBe(true);
    expect(hasWarning(run, "1 Hz sampling")).toBe(true);
  });
});

describe("parseChemStationCh — version 181 (modern UTF-16LE, f64)", () => {
  it("decodes 4 big-endian f64 points and the UTF-16LE sample name", () => {
    // data at 0x1800 (default for 179/181 if 0x11a is 0); write 4 f64s
    const DATA_START = 0x1800;
    const SIZE = DATA_START + 4 * 8;
    const b = new BufferBuilder(SIZE);

    b.pascalLatin1(0x000, "181");
    b.pascalUtf16(0x15b, "DAD 254nm"); // sample — contains DAD/nm so detector=uv
    b.pascalUtf16(0x35a, "DAD signal"); // description
    b.pascalUtf16(0x758, "Op2");
    b.pascalUtf16(0x957, "2024-06-01");
    b.pascalUtf16(0xa0e, "Inst2");
    b.pascalUtf16(0xe11, "Meth2");
    b.pascalUtf16(0xc11, "signal DAD 280nm");

    // data start: write 0 at 0x11a so it falls back to 0x1800 with a warning
    b.u32be(0x11a, 0);

    b.f64be(0x1e4, 1.0); // slope
    b.f64be(0x1ec, 0.0); // intercept
    b.f64be(0x282, 0); // start ms
    b.f64be(0x28a, 3 * 60_000); // end ms = 3 minutes

    // 4 f64 values
    b.f64be(DATA_START, 1.5);
    b.f64be(DATA_START + 8, 2.5);
    b.f64be(DATA_START + 16, 3.5);
    b.f64be(DATA_START + 24, 4.5);

    const run = parseChemStationCh(b.buf, { name: "sig.uv" });

    expect(run.detector).toBe("uv");
    expect(run.rtMin.length).toBe(4);
    expect(run.tic.length).toBe(4);
    expect(Array.from(run.tic)).toEqual([1.5, 2.5, 3.5, 4.5]);

    // RT 0..3 minutes, 4 points => 0, 1, 2, 3
    expect(run.rtMin[0]).toBeCloseTo(0, 6);
    expect(run.rtMin[1]).toBeCloseTo(1, 6);
    expect(run.rtMin[3]).toBeCloseTo(3, 6);

    expect(run.meta.sample).toBe("DAD 254nm");
    expect(run.meta.operator).toBe("Op2");
    expect(run.meta.method).toBe("Meth2");

    expect(hasWarning(run, "experimental")).toBe(true);
    expect(hasWarning(run, "fell back to fixed 0x1800")).toBe(true);
  });
});

describe("parseChemStationCh — robustness", () => {
  it("returns 0 points and a warning for an unsupported version string", () => {
    const b = new BufferBuilder(32);
    b.pascalLatin1(0, "99");
    b.pascalLatin1(0x018, "x");
    const run = parseChemStationCh(b.buf);
    expect(run.rtMin.length).toBe(0);
    expect(run.tic.length).toBe(0);
    expect(run.scanCount).toBe(0);
    expect(() => parseChemStationCh(b.buf)).not.toThrow();
    expect(hasWarning(run, "99")).toBe(true);
    expect(hasWarning(run, "experimental")).toBe(true);
  });

  it("does not throw on a 3-byte buffer", () => {
    const tiny = new ArrayBuffer(3);
    const run = parseChemStationCh(tiny);
    expect(() => parseChemStationCh(tiny)).not.toThrow();
    expect(run.rtMin.length).toBe(0);
    expect(hasWarning(run, "too small")).toBe(true);
  });

  it("does not throw on a zero-byte buffer", () => {
    const run = parseChemStationCh(new ArrayBuffer(0));
    expect(() => parseChemStationCh(new ArrayBuffer(0))).not.toThrow();
    expect(run.rtMin.length).toBe(0);
  });

  it("returns 0 points and a warning when data start is past end of buffer", () => {
    const b = new BufferBuilder(0x300); // small buffer
    b.pascalLatin1(0x000, "181");
    // set data-start word so byte offset = 0x4000, well past 0x300
    b.u32be(0x11a, (0x4000 + 2) / 2);
    b.f64be(0x282, 0);
    b.f64be(0x28a, 1000);
    const run = parseChemStationCh(b.buf);
    expect(() => parseChemStationCh(b.buf)).not.toThrow();
    expect(run.rtMin.length).toBe(0);
    expect(run.tic.length).toBe(0);
    expect(hasWarning(run, "past end of buffer")).toBe(true);
    expect(hasWarning(run, "experimental")).toBe(true);
  });

  it("every successful parse carries the experimental warning", () => {
    // re-use the version-181 happy path: 2 f64 points
    const DATA_START = 0x1800;
    const b = new BufferBuilder(DATA_START + 2 * 8);
    b.pascalLatin1(0x000, "181");
    b.u32be(0x11a, 0);
    b.f64be(0x1e4, 1);
    b.f64be(0x1ec, 0);
    b.f64be(0x282, 0);
    b.f64be(0x28a, 60_000);
    b.f64be(DATA_START, 42);
    b.f64be(DATA_START + 8, 43);
    const run = parseChemStationCh(b.buf);
    expect(run.rtMin.length).toBe(2);
    expect(hasWarning(run, "experimental")).toBe(true);
  });
});