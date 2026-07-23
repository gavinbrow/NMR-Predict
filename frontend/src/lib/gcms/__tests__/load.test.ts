import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDroppedFiles, loadGcmsFiles } from "../load";

// The real Agilent DATA.MS fixture lives at the repo root in "GCMS Example/".
// From this test directory that is five `..` segments up
// (this dir -> gcms -> lib -> src -> frontend -> root).
const ROOT = resolve(__dirname, "../../../../../");
const FIXTURE_DIR = resolve(ROOT, "GCMS Example");
const FIXTURE_PRESENT = existsSync(resolve(FIXTURE_DIR, "DATA.MS"));

function readFixture(name: string): ArrayBuffer {
  const buf = readFileSync(resolve(FIXTURE_DIR, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Build a minimal valid ChemStation DATA.MS buffer with one scan. */
function makeMinimalDataMs(): ArrayBuffer {
  // The parser requires >= 0x12a bytes. We build a buffer with a valid header,
  // one directory entry each (A/B), and one scan record with one point.
  const buf = new ArrayBuffer(0x400);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // Magic: 0x0132 at offset 0.
  dv.setUint16(0x000, 0x0132, false);

  // Header scan count at 0x118.
  dv.setUint16(0x118, 1, false);
  // dirWords at 0x104 (directory byte offset = 2*dirWords - 2). Put the
  // directory right after the header at 0x12a => dirWords = (0x12a + 2) / 2 = 0x96.
  dv.setUint32(0x104, 0x96, false);
  // dataWords at 0x108 (data byte offset = 2*dataWords - 2). The data starts
  // after the two directory entries (each 12 bytes) => 0x12a + 24 = 0x142.
  // dataWords = (0x142 + 2) / 2 = 0xa2.
  dv.setUint32(0x108, 0xa2, false);

  // Directory A at 0x12a: { offsetWords, rtMs, tic } per scan (12 bytes).
  const dirAOff = 0x12a;
  // rtMs = 60000 (1.0 min). tic = 100.
  dv.setUint32(dirAOff + 4, 60000, false);
  dv.setUint32(dirAOff + 8, 100, false);

  // Directory B at 0x12a + 12: { offsetWords, rtMs, basePeakAbund }.
  const dirBOff = dirAOff + 12;
  dv.setUint32(dirBOff + 8, 50, false);

  // Data record at 0x142. Each record: lenWords (u16), then 14 bytes of header,
  // then npairs * 4 bytes of (mzRaw u16, abRaw u16) pairs DESCENDING in mz.
  const dataOff = 0x142;
  // One pair: mz = 100*20 = 2000, abundance = 100 (mantissa 100, exp 0).
  const npairs = 1;
  const byteLen = 18 + npairs * 4; // 22
  const lenWords = byteLen / 2; // 11
  dv.setUint16(dataOff, lenWords, false);
  dv.setUint16(dataOff + 12, npairs, false);
  // base-peak mz raw at +14.
  dv.setUint16(dataOff + 14, 2000, false);
  // base-peak abundance raw at +16.
  dv.setUint16(dataOff + 16, 100, false);
  // The single pair at +18: mz raw 2000, abundance raw 100.
  dv.setUint16(dataOff + 18, 2000, false);
  dv.setUint16(dataOff + 20, 100, false);

  return buf;
}

/**
 * A minimal File stand-in for the loader tests. jsdom's File does not
 * implement `.arrayBuffer()` or `.text()`, so we build a thin class that holds
 * the content as an ArrayBuffer and implements the three methods the loader
 * uses (`arrayBuffer`, `text`, `slice` + the sliced blob's `arrayBuffer`).
 * `webkitRelativePath` is set as a regular property (the loader reads it via
 * a bracket access, so it does not need to be non-enumerable).
 */
class FakeFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
  readonly webkitRelativePath: string;
  private readonly _buffer: ArrayBuffer;

  constructor(content: ArrayBuffer | string, name: string, relativePath: string = name) {
    this.name = name;
    this.webkitRelativePath = relativePath;
    this.type = "";
    this.lastModified = Date.now();
    if (typeof content === "string") {
      const encoded = new TextEncoder().encode(content);
      this._buffer = encoded.buffer.slice(0, encoded.byteLength) as ArrayBuffer;
    } else {
      this._buffer = content;
    }
    this.size = this._buffer.byteLength;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    // Return a copy so callers can detach without breaking subsequent reads.
    return this._buffer.slice(0);
  }

  async text(): Promise<string> {
    return new TextDecoder("utf-8").decode(new Uint8Array(this._buffer));
  }

  slice(start: number, end?: number): FakeBlob {
    const len = this._buffer.byteLength;
    const s = Math.max(0, Math.min(start, len));
    const e = end == null ? len : Math.max(0, Math.min(end, len));
    const copy = this._buffer.slice(s, Math.max(s, e));
    return new FakeBlob(copy);
  }
}

/** A Blob stand-in returned by `FakeFile.slice` — implements `arrayBuffer`/`text`. */
class FakeBlob {
  readonly size: number;
  readonly type: string;
  private readonly _buffer: ArrayBuffer;

  constructor(buffer: ArrayBuffer) {
    this._buffer = buffer;
    this.size = buffer.byteLength;
    this.type = "";
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this._buffer.slice(0);
  }

  async text(): Promise<string> {
    return new TextDecoder("utf-8").decode(new Uint8Array(this._buffer));
  }
}

function makeFile(
  content: ArrayBuffer | string,
  name: string,
  relativePath: string = name,
): File {
  // Cast to File — the loader only uses name/webkitRelativePath/arrayBuffer/text/slice.
  return new FakeFile(content, name, relativePath) as unknown as File;
}

describe("collectDroppedFiles", () => {
  it("returns the flat files list when there are no entries", async () => {
    // jsdom DataTransfer is minimal; this just confirms the null/empty path.
    expect(await collectDroppedFiles(null)).toEqual([]);
  });
});

describe("loadGcmsFiles — grouping & regression", () => {
  it.skipIf(!FIXTURE_PRESENT)(
    "two different .D folders dropped together produce two runs each paired with its own acqmeth.txt",
    async () => {
      // Two copies of the real fixture, in two different .D folders, each
      // with its OWN acqmeth.txt carrying a different method name. This is the
      // regression test for the last-write-wins bug in the old gpc/load.ts.
      const dataMsA = readFixture("DATA.MS");
      const dataMsB = readFixture("DATA.MS");
      const acqA =
        "Run time: 10.00 min\nLow Mass: 50\nHigh Mass: 550\nTune File: METHOD_A\n";
      const acqB =
        "Run time: 20.00 min\nLow Mass: 60\nHigh Mass: 650\nTune File: METHOD_B\n";

      const files = [
        makeFile(dataMsA, "DATA.MS", "RUN_A.D/DATA.MS"),
        makeFile(acqA, "acqmeth.txt", "RUN_A.D/acqmeth.txt"),
        makeFile(dataMsB, "DATA.MS", "RUN_B.D/DATA.MS"),
        makeFile(acqB, "acqmeth.txt", "RUN_B.D/acqmeth.txt"),
      ];

      const { runs, errors } = await loadGcmsFiles(files);
      expect(errors).toEqual([]);
      expect(runs).toHaveLength(2);
      const byName = new Map(runs.map((r) => [r.name, r] as const));
      expect(byName.has("RUN_A.D")).toBe(true);
      expect(byName.has("RUN_B.D")).toBe(true);
      const runA = byName.get("RUN_A.D")!;
      const runB = byName.get("RUN_B.D")!;
      // Each run is paired with ITS OWN acqmeth.txt: the tuneFile / highMass
      // differ. This is the assertion the old last-write-wins loader failed.
      expect(runA.meta.tuneFile).toBe("METHOD_A");
      expect(runB.meta.tuneFile).toBe("METHOD_B");
      expect(runA.meta.highMass).toBe(550);
      expect(runB.meta.highMass).toBe(650);
      // The DATA.MS header (sample/operator/method/instrument/inlet/acquiredDate)
      // must WIN over the method file — both runs share the same DATA.MS so
      // the method name from the header is identical, not the acqmeth value.
      expect(runA.meta.sample).toBe(runB.meta.sample);
    },
  );

  it("a file named DATA.MS with no matching extension case is still recognised by signature", async () => {
    // A file literally named "DATA.MS" is caught by the .ms branch; but a
    // signature-only file named "DATA" (no extension) must still parse.
    const buffer = makeMinimalDataMs();
    const file = makeFile(buffer, "DATA", "SAMPLE.D/DATA");
    const { runs, errors } = await loadGcmsFiles([file]);
    expect(errors).toEqual([]);
    expect(runs).toHaveLength(1);
    expect(runs[0].format).toBe("agilent-ms");
    expect(runs[0].scanCount).toBeGreaterThan(0);
  });

  it("a Thermo .raw (UTF-16LE \"Finnigan\") produces an error containing \"msconvert\" and no thrown exception", async () => {
    // Build a buffer whose first bytes are the UTF-16LE string "Finnigan".
    const thermo = new Uint8Array(64);
    const str = "Finnigan";
    for (let i = 0; i < str.length; i += 1) {
      thermo[i * 2] = str.charCodeAt(i);
      thermo[i * 2 + 1] = 0;
    }
    const file = makeFile(thermo.buffer, "sample.raw", "sample.raw");
    const { runs, errors } = await loadGcmsFiles([file]);
    expect(runs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("msconvert");
    expect(errors[0]).toContain("Thermo");
  });

  it("a garbage file produces exactly one error and does not prevent a good file in the same batch from loading", async () => {
    const garbage = new Uint8Array(64);
    for (let i = 0; i < garbage.length; i += 1) garbage[i] = i;
    const good = makeMinimalDataMs();
    const files = [
      makeFile(garbage.buffer, "junk.dat", "junk.dat"),
      makeFile(good, "DATA.MS", "SAMPLE.D/DATA.MS"),
    ];
    const { runs, errors } = await loadGcmsFiles(files);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("junk.dat");
    expect(runs).toHaveLength(1);
    expect(runs[0].format).toBe("agilent-ms");
  });
});