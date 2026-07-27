// Tests for the Agilent ChemStation .ch/.uv parser.
//
// Synthetic buffers cover edge cases and the repository's `.D` example provides
// real version-181 detector channels for end-to-end acceptance checks.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  f32be(offset: number, v: number): void {
    this.view.setFloat32(offset, v, false);
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

describe("parseChemStationCh — version 181 (modern FID double-delta)", () => {
  it("decodes a scaled second-order delta stream and modern metadata", () => {
    const DATA_START = 0x1800;
    const b = new BufferBuilder(DATA_START + 14);

    b.pascalLatin1(0x000, "181");
    b.pascalUtf16(858, "Sample B");
    b.pascalUtf16(1880, "Op2");
    b.pascalUtf16(2391, "2024-06-01");
    b.pascalUtf16(2492, "Inst2");
    b.pascalUtf16(2574, "Meth2");
    b.pascalUtf16(4213, "FID signal");
    b.u32be(264, DATA_START / 512 + 1);
    b.f32be(282, 0);
    b.f32be(286, 3 * 60_000);
    b.f64be(4724, 1);
    b.f64be(4732, 2);

    let off = DATA_START;
    b.i16be(off, 0x7fff); off += 2;
    b.i16be(off, 0); off += 2;
    b.u32be(off, 100); off += 4;
    b.i16be(off, 5); off += 2;
    b.i16be(off, 5); off += 2;
    b.i16be(off, 5);

    const run = parseChemStationCh(b.buf, { name: "sig.ch" });

    expect(run.detector).toBe("fid");
    expect(run.rtMin.length).toBe(4);
    expect(Array.from(run.tic)).toEqual([201, 211, 231, 261]);
    expect(run.rtMin[0]).toBeCloseTo(0, 6);
    expect(run.rtMin[1]).toBeCloseTo(1, 6);
    expect(run.rtMin[3]).toBeCloseTo(3, 6);
    expect(run.meta.sample).toBe("Sample B");
    expect(run.meta.operator).toBe("Op2");
    expect(run.meta.instrument).toBe("Inst2");
    expect(run.meta.method).toBe("Meth2");
    expect(hasWarning(run, "experimental")).toBe(true);
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
    b.u32be(264, 0x4000 / 512 + 1);
    b.f32be(282, 0);
    b.f32be(286, 1000);
    const run = parseChemStationCh(b.buf);
    expect(() => parseChemStationCh(b.buf)).not.toThrow();
    expect(run.rtMin.length).toBe(0);
    expect(run.tic.length).toBe(0);
    expect(hasWarning(run, "past end of buffer")).toBe(true);
    expect(hasWarning(run, "experimental")).toBe(true);
  });

  it("every successful parse carries the experimental warning", () => {
    const DATA_START = 0x1800;
    const b = new BufferBuilder(DATA_START + 10);
    b.pascalLatin1(0x000, "181");
    b.u32be(264, DATA_START / 512 + 1);
    b.f32be(282, 0);
    b.f32be(286, 60_000);
    b.f64be(4724, 0);
    b.f64be(4732, 1);
    b.i16be(DATA_START, 0x7fff);
    b.i16be(DATA_START + 2, 0);
    b.u32be(DATA_START + 4, 42);
    b.i16be(DATA_START + 8, 1);
    const run = parseChemStationCh(b.buf);
    expect(run.rtMin.length).toBe(2);
    expect(hasWarning(run, "experimental")).toBe(true);
  });
});

const REAL_RUN_DIR = resolve(
  __dirname,
  "../../../../../../GCMS Example/ACSDCPD_50_1.D",
);

describe.skipIf(!existsSync(resolve(REAL_RUN_DIR, "TST1A.CH")))(
  "real ChemStation 181 detector channels",
  () => {
    for (const [name, rtStart, rtEnd, max] of [
      ["TST1A.CH", 0.0005552, 27.0005542, 123.3125064],
      ["TST2A.CH", 0.00322187, 27.0032208, 123.3833398],
    ] as const) {
      it(`decodes ${name}`, () => {
        const buf = readFileSync(resolve(REAL_RUN_DIR, name));
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const run = parseChemStationCh(ab, { name });

        expect(run.detector).toBe("fid");
        expect(run.rtMin).toHaveLength(8100);
        expect(run.tic).toHaveLength(8100);
        expect(run.rtRange[0]).toBeCloseTo(rtStart, 6);
        expect(run.rtRange[1]).toBeCloseTo(rtEnd, 5);
        expect(run.ticRange[0]).toBe(0);
        expect(run.ticRange[1]).toBeCloseTo(max, 5);
        expect(run.meta.instrument).toBe("HP G1530A");
        expect(run.meta.method).toBe("75476.M");
        expect(run.warnings.some((warning) => /no points|past end/i.test(warning))).toBe(false);
      });
    }
  },
);
