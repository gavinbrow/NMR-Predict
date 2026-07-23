import { describe, expect, it } from "vitest";
import { isNetcdf, readNetcdf } from "../netcdf";

// --- tiny CDF-1 writer ------------------------------------------------------
// All big-endian. Pads names/values to a 4-byte boundary.

const NC_DIMENSION = 0x0a;
const NC_VARIABLE = 0x0b;
const NC_ATTRIBUTE = 0x0c;

class W {
  buf: number[] = [];
  u8(v: number) {
    this.buf.push(v & 0xff);
  }
  u32(v: number) {
    this.buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  i16(v: number) {
    const b = new ArrayBuffer(2);
    new DataView(b).setInt16(0, v);
    this.buf.push(new Uint8Array(b)[0], new Uint8Array(b)[1]);
  }
  i32(v: number) {
    const b = new ArrayBuffer(4);
    new DataView(b).setInt32(0, v);
    const u = new Uint8Array(b);
    this.buf.push(u[0], u[1], u[2], u[3]);
  }
  f32(v: number) {
    const b = new ArrayBuffer(4);
    new DataView(b).setFloat32(0, v);
    const u = new Uint8Array(b);
    this.buf.push(u[0], u[1], u[2], u[3]);
  }
  f64(v: number) {
    const b = new ArrayBuffer(8);
    new DataView(b).setFloat64(0, v);
    const u = new Uint8Array(b);
    for (let i = 0; i < 8; i += 1) this.buf.push(u[i]);
  }
  bytes(arr: number[] | Uint8Array) {
    for (const v of arr) this.buf.push(v & 0xff);
  }
  padTo4(extra: number) {
    const r = extra % 4;
    if (r !== 0) for (let i = 0; i < 4 - r; i += 1) this.buf.push(0);
  }
  get buffer(): ArrayBuffer {
    return new Uint8Array(this.buf).buffer;
  }
  get length() {
    return this.buf.length;
  }
}

function writeName(w: W, name: string) {
  const enc = Array.from(new TextEncoder().encode(name));
  w.u32(enc.length);
  w.bytes(enc);
  w.padTo4(enc.length);
}

interface AttrSpec {
  name: string;
  type: number; // 2=CHAR,4=INT,5=FLOAT,6=DOUBLE
  values: number[] | string;
}

function writeAttList(w: W, attrs: AttrSpec[]) {
  if (attrs.length === 0) {
    w.u32(0);
    return;
  }
  w.u32(NC_ATTRIBUTE);
  w.u32(attrs.length);
  for (const a of attrs) {
    writeName(w, a.name);
    w.u32(a.type);
    if (a.type === 2) {
      const s = typeof a.values === "string" ? a.values : String(a.values);
      const enc = Array.from(new TextEncoder().encode(s));
      w.u32(enc.length);
      w.bytes(enc);
      w.padTo4(enc.length);
    } else {
      const vals = a.values as number[];
      w.u32(vals.length);
      for (const v of vals) {
        if (a.type === 4) w.i32(v);
        else if (a.type === 5) w.f32(v);
        else if (a.type === 6) w.f64(v);
      }
      const size = vals.length * (a.type === 6 ? 8 : a.type === 5 ? 4 : 4);
      w.padTo4(size);
    }
  }
}

interface DimSpec {
  name: string;
  length: number; // 0 = record
}

interface VarSpec {
  name: string;
  type: number;
  dimIds: number[];
  attrs?: AttrSpec[];
  data: number[] | string; // for CHAR, a string
}

function buildCdf1(dims: DimSpec[], gattrs: AttrSpec[], vars: VarSpec[]): ArrayBuffer {
  const w = new W();
  // magic
  w.bytes([0x43, 0x44, 0x46, 0x01]);
  // numrecs (compute from first record var's length if there is a record dim)
  let numrecs = 0;
  const recordDimIdx = dims.findIndex((d) => d.length === 0);
  if (recordDimIdx >= 0) {
    // find a record var and infer numrecs from its data length
    for (const v of vars) {
      if (v.dimIds[0] === recordDimIdx) {
        const inner = v.dimIds.slice(1).reduce((p, id) => p * dims[id].length, 1);
        const dataLen = typeof v.data === "string" ? v.data.length : v.data.length;
        numrecs = inner > 0 ? Math.floor(dataLen / inner) : dataLen;
        break;
      }
    }
  }
  w.u32(numrecs);

  // dim_list
  w.u32(NC_DIMENSION);
  w.u32(dims.length);
  for (const d of dims) {
    writeName(w, d.name);
    w.u32(d.length);
  }

  // gatt_list
  writeAttList(w, gattrs);

  // var_list — we need to compute begins. Header size is fixed once written;
  // vsize is the padded data size. We compute begins after the header.
  // First, write the var list header structure with placeholder begins = 0.
  w.u32(NC_VARIABLE);
  w.u32(vars.length);
  const varHeaderStart = w.length;
  for (const v of vars) {
    writeName(w, v.name);
    w.u32(v.dimIds.length);
    for (const id of v.dimIds) w.u32(id);
    writeAttList(w, v.attrs ?? []);
    w.u32(v.type);
    // vsize: product of non-record dim lengths * type_size, padded to 4.
    const typeSize = v.type === 6 ? 8 : v.type === 5 ? 4 : v.type === 4 ? 4 : v.type === 3 ? 2 : v.type === 1 || v.type === 2 ? 1 : 0;
    let n = 1;
    for (let i = 0; i < v.dimIds.length; i += 1) {
      const d = dims[v.dimIds[i]];
      if (d.length === 0) continue; // record dim handled per-record
      n *= d.length;
    }
    let vsize = n * typeSize;
    const r = vsize % 4;
    if (r !== 0) vsize += 4 - r;
    w.u32(vsize);
    w.u32(0); // begin placeholder (CDF-1 uses u32)
  }
  const headerLen = w.length;

  // recsize = sum of vsize over record variables
  let recsize = 0;
  const vsizes: number[] = [];
  for (const v of vars) {
    const typeSize = v.type === 6 ? 8 : v.type === 5 ? 4 : v.type === 4 ? 4 : v.type === 3 ? 2 : 1;
    let n = 1;
    for (let i = 0; i < v.dimIds.length; i += 1) {
      const d = dims[v.dimIds[i]];
      if (d.length === 0) continue;
      n *= d.length;
    }
    let vsize = n * typeSize;
    const r = vsize % 4;
    if (r !== 0) vsize += 4 - r;
    vsizes.push(vsize);
    if (v.dimIds.length > 0 && dims[v.dimIds[0]].length === 0) recsize += vsize;
  }

  // Assign begins. Non-record vars are contiguous right after the header.
  // Record vars begin at the start of the record section; per-record stride
  // is recsize. We lay out non-record data first, then record data.
  let cursor = headerLen;
  const begins: number[] = [];
  let recordSectionStart = headerLen;
  for (let i = 0; i < vars.length; i += 1) {
    const v = vars[i];
    const isRec = v.dimIds.length > 0 && dims[v.dimIds[0]].length === 0;
    if (!isRec) {
      begins.push(cursor);
      cursor += vsizes[i];
      recordSectionStart = cursor;
    } else {
      begins.push(-1); // fill later
    }
  }
  // record vars: each begins at recordSectionStart (per-record stride handled at read time)
  for (let i = 0; i < vars.length; i += 1) {
    const v = vars[i];
    const isRec = v.dimIds.length > 0 && dims[v.dimIds[0]].length === 0;
    if (isRec) begins[i] = recordSectionStart;
  }

  // Patch begins in the header. Each var's begin u32 sits right after its vsize.
  // Easier: rebuild the header by walking again with real begins.
  const w2 = new W();
  w2.bytes([0x43, 0x44, 0x46, 0x01]);
  w2.u32(numrecs);
  w2.u32(NC_DIMENSION);
  w2.u32(dims.length);
  for (const d of dims) {
    writeName(w2, d.name);
    w2.u32(d.length);
  }
  writeAttList(w2, gattrs);
  w2.u32(NC_VARIABLE);
  w2.u32(vars.length);
  for (let i = 0; i < vars.length; i += 1) {
    const v = vars[i];
    writeName(w2, v.name);
    w2.u32(v.dimIds.length);
    for (const id of v.dimIds) w2.u32(id);
    writeAttList(w2, v.attrs ?? []);
    w2.u32(v.type);
    w2.u32(vsizes[i]);
    w2.u32(begins[i]);
  }
  if (w2.length !== headerLen) {
    throw new Error(`header rebuild mismatch: ${w2.length} vs ${headerLen}`);
  }

  // Now append the data section in the same layout we computed begins for.
  // Non-record vars first (in declaration order), then record data interleaved.
  const dataW = new W();
  for (let i = 0; i < vars.length; i += 1) {
    const v = vars[i];
    const isRec = v.dimIds.length > 0 && dims[v.dimIds[0]].length === 0;
    if (isRec) continue;
    const typeSize = v.type === 6 ? 8 : v.type === 5 ? 4 : v.type === 4 ? 4 : v.type === 3 ? 2 : 1;
    let n = 1;
    for (let j = 0; j < v.dimIds.length; j += 1) {
      const d = dims[v.dimIds[j]];
      if (d.length === 0) continue;
      n *= d.length;
    }
    if (v.type === 2) {
      const enc = Array.from(new TextEncoder().encode(v.data as string));
      for (let k = 0; k < n; k += 1) dataW.u8(enc[k] ?? 0);
    } else {
      const vals = v.data as number[];
      for (let k = 0; k < n; k += 1) {
        const val = vals[k] ?? 0;
        if (v.type === 1) dataW.u8(val);
        else if (v.type === 3) dataW.i16(val);
        else if (v.type === 4) dataW.i32(val);
        else if (v.type === 5) dataW.f32(val);
        else if (v.type === 6) dataW.f64(val);
      }
    }
    // pad to 4
    const bytes = n * typeSize;
    const r = bytes % 4;
    if (r !== 0) for (let k = 0; k < 4 - r; k += 1) dataW.u8(0);
  }
  // Record section: for each record 0..numrecs-1, write each record var's
  // per-record block (its inner points), padded to that var's vsize.
  for (let rec = 0; rec < numrecs; rec += 1) {
    for (let i = 0; i < vars.length; i += 1) {
      const v = vars[i];
      const isRec = v.dimIds.length > 0 && dims[v.dimIds[0]].length === 0;
      if (!isRec) continue;
      const inner = v.dimIds.slice(1).reduce((p, id) => p * dims[id].length, 1);
      const vals = v.data as number[];
      const base = rec * inner;
      const typeSize = v.type === 6 ? 8 : v.type === 5 ? 4 : v.type === 4 ? 4 : v.type === 3 ? 2 : 1;
      for (let k = 0; k < inner; k += 1) {
        const val = vals[base + k] ?? 0;
        if (v.type === 1) dataW.u8(val);
        else if (v.type === 3) dataW.i16(val);
        else if (v.type === 4) dataW.i32(val);
        else if (v.type === 5) dataW.f32(val);
        else if (v.type === 6) dataW.f64(val);
      }
      // pad this record block to vsize
      const written = inner * typeSize;
      const r = written % 4;
      if (r !== 0) for (let k = 0; k < 4 - r; k += 1) dataW.u8(0);
    }
  }

  // concatenate w2 header + dataW data
  const out = new Uint8Array(w2.length + dataW.length);
  out.set(new Uint8Array(w2.buffer), 0);
  out.set(new Uint8Array(dataW.buffer), w2.length);
  return out.buffer;
}

describe("isNetcdf", () => {
  it("recognises the CDF magic", () => {
    const bytes = new Uint8Array([0x43, 0x44, 0x46, 0x01, 0, 0, 0, 0]);
    expect(isNetcdf(bytes)).toBe(true);
    expect(isNetcdf(new Uint8Array([0x43, 0x44, 0x46, 0x02]))).toBe(true);
  });
  it("rejects non-CDF bytes", () => {
    expect(isNetcdf(new Uint8Array([1, 2, 3, 4]))).toBe(false);
    expect(isNetcdf(new Uint8Array([0x43, 0x44, 0x46, 0x03]))).toBe(false);
  });
});

describe("readNetcdf — CDF-1", () => {
  it("reads a 3-record file with one non-record var and two record vars", () => {
    // dims: time (record, len 0), x (len 2)
    // vars:
    //   constvar  DOUBLE x        (non-record, 2 values) — contiguous
    //   timedata  DOUBLE time     (record, 3 records)
    //   xydata    FLOAT  time x   (record, 3 records * 2 inner)
    // global attr: title = "test"
    const dims = [
      { name: "time", length: 0 },
      { name: "x", length: 2 },
    ];
    const gattrs: AttrSpec[] = [{ name: "title", type: 2, values: "test" }];
    const vars: VarSpec[] = [
      { name: "constvar", type: 6, dimIds: [1], data: [10.0, 20.0] },
      { name: "timedata", type: 6, dimIds: [0], data: [1.0, 2.0, 3.0] },
      { name: "xydata", type: 5, dimIds: [0, 1], data: [100, 200, 300, 400, 500, 600] },
    ];
    const buf = buildCdf1(dims, gattrs, vars);
    const file = readNetcdf(buf);

    expect(file.version).toBe(1);
    expect(file.numrecs).toBe(3);
    expect(file.dims.map((d) => d.name)).toEqual(["time", "x"]);
    expect(file.dims.map((d) => d.length)).toEqual([0, 2]);

    // global attribute (CHAR)
    expect(file.attrs.title).toBe("test");

    // non-record contiguous var
    const cv = file.getVariable("constvar") as Float64Array;
    expect(Array.from(cv)).toEqual([10.0, 20.0]);

    // record var #1 (single dim = record)
    const td = file.getVariable("timedata") as Float64Array;
    expect(Array.from(td)).toEqual([1.0, 2.0, 3.0]);

    // record var #2 (record + inner dim x of length 2)
    const xy = file.getVariable("xydata") as Float64Array;
    expect(Array.from(xy)).toEqual([100, 200, 300, 400, 500, 600]);
  });

  it("reads a global numeric attribute", () => {
    const dims = [{ name: "x", length: 2 }];
    const gattrs: AttrSpec[] = [{ name: "count", type: 4, values: [42] }];
    const vars: VarSpec[] = [{ name: "v", type: 5, dimIds: [0], data: [1, 2] }];
    const file = readNetcdf(buildCdf1(dims, gattrs, vars));
    expect(file.attrs.count).toBe(42);
  });

  it("pads a 3-char variable name to a 4-byte boundary", () => {
    // name "abc" (3 bytes) must be padded to 4. We test that a subsequent
    // variable is still readable.
    const dims = [{ name: "x", length: 1 }];
    const vars: VarSpec[] = [
      { name: "abc", type: 5, dimIds: [0], data: [1] },
      { name: "longername", type: 5, dimIds: [0], data: [2] },
    ];
    const file = readNetcdf(buildCdf1(dims, [], vars));
    expect(Array.from(file.getVariable("abc") as Float64Array)).toEqual([1]);
    expect(Array.from(file.getVariable("longername") as Float64Array)).toEqual([2]);
  });
});