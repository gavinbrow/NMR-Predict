import { describe, expect, it } from "vitest";
import { readNetcdf } from "../netcdf";
import { isAndiMs, parseAndiMs } from "../andims";

// Reuse the CDF-1 writer shape from netcdf.test.ts (kept self-contained here).

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
    const u = new Uint8Array(b);
    this.buf.push(u[0], u[1]);
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
  get buffer() {
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
  type: number;
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
      const size = vals.length * (a.type === 6 ? 8 : 4);
      w.padTo4(size);
    }
  }
}

interface DimSpec {
  name: string;
  length: number;
}
interface VarSpec {
  name: string;
  type: number;
  dimIds: number[];
  attrs?: AttrSpec[];
  data: number[] | string;
}

const TYPE_SIZE = [0, 1, 1, 2, 4, 4, 8];

function buildCdf1(dims: DimSpec[], gattrs: AttrSpec[], vars: VarSpec[]): ArrayBuffer {
  const w = new W();
  w.bytes([0x43, 0x44, 0x46, 0x01]);
  let numrecs = 0;
  const recordDimIdx = dims.findIndex((d) => d.length === 0);
  if (recordDimIdx >= 0) {
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
  w.u32(NC_DIMENSION);
  w.u32(dims.length);
  for (const d of dims) {
    writeName(w, d.name);
    w.u32(d.length);
  }
  writeAttList(w, gattrs);
  w.u32(NC_VARIABLE);
  w.u32(vars.length);
  const vsizes: number[] = [];
  for (const v of vars) {
    const typeSize = TYPE_SIZE[v.type];
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
  }
  let recsize = 0;
  for (let i = 0; i < vars.length; i += 1) {
    const v = vars[i];
    const isRec = v.dimIds.length > 0 && dims[v.dimIds[0]].length === 0;
    if (isRec) recsize += vsizes[i];
  }
  // pass 1: header with placeholder begins
  const placeholderIdx: number[] = [];
  for (let i = 0; i < vars.length; i += 1) {
    const v = vars[i];
    writeName(w, v.name);
    w.u32(v.dimIds.length);
    for (const id of v.dimIds) w.u32(id);
    writeAttList(w, v.attrs ?? []);
    w.u32(v.type);
    w.u32(vsizes[i]);
    placeholderIdx.push(w.length);
    w.u32(0);
  }
  const headerLen = w.length;
  // assign begins
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
      begins.push(-1);
    }
  }
  for (let i = 0; i < vars.length; i += 1) {
    const v = vars[i];
    const isRec = v.dimIds.length > 0 && dims[v.dimIds[0]].length === 0;
    if (isRec) begins[i] = recordSectionStart;
  }
  // patch begins (placeholderIdx points at the first byte of each begin u32)
  for (let i = 0; i < vars.length; i += 1) {
    const idx = placeholderIdx[i];
    const b = begins[i];
    w.buf[idx] = (b >>> 24) & 0xff;
    w.buf[idx + 1] = (b >>> 16) & 0xff;
    w.buf[idx + 2] = (b >>> 8) & 0xff;
    w.buf[idx + 3] = b & 0xff;
  }
  // data: non-record first, then record interleaved
  for (let i = 0; i < vars.length; i += 1) {
    const v = vars[i];
    const isRec = v.dimIds.length > 0 && dims[v.dimIds[0]].length === 0;
    if (isRec) continue;
    const typeSize = TYPE_SIZE[v.type];
    let n = 1;
    for (let j = 0; j < v.dimIds.length; j += 1) {
      const d = dims[v.dimIds[j]];
      if (d.length === 0) continue;
      n *= d.length;
    }
    if (v.type === 2) {
      const enc = Array.from(new TextEncoder().encode(v.data as string));
      for (let k = 0; k < n; k += 1) w.u8(enc[k] ?? 0);
    } else {
      const vals = v.data as number[];
      for (let k = 0; k < n; k += 1) {
        const val = vals[k] ?? 0;
        if (v.type === 1) w.u8(val);
        else if (v.type === 3) w.i16(val);
        else if (v.type === 4) w.i32(val);
        else if (v.type === 5) w.f32(val);
        else if (v.type === 6) w.f64(val);
      }
    }
    const bytes = n * typeSize;
    const r = bytes % 4;
    if (r !== 0) for (let k = 0; k < 4 - r; k += 1) w.u8(0);
  }
  for (let rec = 0; rec < numrecs; rec += 1) {
    for (let i = 0; i < vars.length; i += 1) {
      const v = vars[i];
      const isRec = v.dimIds.length > 0 && dims[v.dimIds[0]].length === 0;
      if (!isRec) continue;
      const inner = v.dimIds.slice(1).reduce((p, id) => p * dims[id].length, 1);
      const vals = v.data as number[];
      const base = rec * inner;
      const typeSize = TYPE_SIZE[v.type];
      for (let k = 0; k < inner; k += 1) {
        const val = vals[base + k] ?? 0;
        if (v.type === 1) w.u8(val);
        else if (v.type === 3) w.i16(val);
        else if (v.type === 4) w.i32(val);
        else if (v.type === 5) w.f32(val);
        else if (v.type === 6) w.f64(val);
      }
      const written = inner * typeSize;
      const r = written % 4;
      if (r !== 0) for (let k = 0; k < 4 - r; k += 1) w.u8(0);
    }
  }
  return w.buffer;
}

function buildAndiMs(): ArrayBuffer {
  // 2 scans: scan 0 has 2 points (mz 50,100 int 1,2), scan 1 has 1 point (mz 75 int 3).
  // scan_index = [0, 2]; mass_values length = 3; final offset = 3.
  // scan_acquisition_time in SECONDS = [60, 120] -> rtMin [1, 2].
  // total_intensity = [3, 3].
  // point_count = [2, 1].
  // global attrs: experiment_title, operator_name, experiment_date_time_stamp,
  //   test_ionization_mode="Electron Impact", test_detector_type="MS"
  // netCDF-3 has exactly ONE record (unlimited) dimension. ANDI-MS uses it for
  // point_number (mass_values/intensity_values). scan_number is a FIXED dim.
  const dims: DimSpec[] = [
    { name: "scan_number", length: 2 }, // fixed
    { name: "point_number", length: 0 }, // record (unlimited)
  ];
  //   scan_acquisition_time  DOUBLE [scan_number]            non-record
  //   total_intensity         DOUBLE [scan_number]            non-record
  //   scan_index              DOUBLE [scan_number]            non-record
  //   point_count             DOUBLE [scan_number]            non-record
  //   mass_values             FLOAT  [point_number]           record
  //   intensity_values        FLOAT  [point_number]           record
  //   mass_range_min          DOUBLE [scan_number]            non-record
  //   mass_range_max          DOUBLE [scan_number]            non-record
  const gattrs: AttrSpec[] = [
    { name: "experiment_title", type: 2, values: "My Sample" },
    { name: "operator_name", type: 2, values: "jane" },
    { name: "experiment_date_time_stamp", type: 2, values: "2024-01-01" },
    { name: "test_ionization_mode", type: 2, values: "Electron Impact" },
    { name: "test_detector_type", type: 2, values: "MS" },
  ];
  const vars: VarSpec[] = [
    { name: "scan_acquisition_time", type: 6, dimIds: [0], data: [60, 120] },
    { name: "total_intensity", type: 6, dimIds: [0], data: [3, 3] },
    { name: "scan_index", type: 6, dimIds: [0], data: [0, 2] },
    { name: "point_count", type: 6, dimIds: [0], data: [2, 1] },
    { name: "mass_range_min", type: 6, dimIds: [0], data: [50, 75] },
    { name: "mass_range_max", type: 6, dimIds: [0], data: [100, 75] },
    { name: "mass_values", type: 5, dimIds: [1], data: [50, 100, 75] },
    { name: "intensity_values", type: 5, dimIds: [1], data: [1, 2, 3] },
  ];
  return buildCdf1(dims, gattrs, vars);
}

describe("isAndiMs", () => {
  it("detects ANDI-MS by required variables", () => {
    const buf = buildAndiMs();
    const f = readNetcdf(buf);
    expect(isAndiMs(f)).toBe(true);
  });
});

describe("parseAndiMs", () => {
  it("maps scan offsets, RT seconds->minutes, and meta", () => {
    const buf = buildAndiMs();
    const run = parseAndiMs(buf, { name: "x.cdf" });
    expect(run.format).toBe("andi");
    expect(run.scanCount).toBe(2);
    // scan offsets: [0, 2, 3]
    expect(Array.from(run.scanOffset)).toEqual([0, 2, 3]);
    // rtMin = seconds/60 -> [1, 2]
    expect(Array.from(run.rtMin)).toEqual([1, 2]);
    // tic
    expect(Array.from(run.tic)).toEqual([3, 3]);
    // mz flat (scan 0 sorted: 50,100; scan 1: 75)
    expect(Array.from(run.mz)).toEqual([50, 100, 75]);
    expect(Array.from(run.intensity)).toEqual([1, 2, 3]);
    // meta mapping
    expect(run.meta.sample).toBe("My Sample");
    expect(run.meta.operator).toBe("jane");
    expect(run.meta.acquiredDate).toBe("2024-01-01");
    expect(run.meta.ionization).toBe("EI");
    expect(run.meta.instrument).toBe("MS");
  });

  it("warns when point_count mismatches the offsets", () => {
    const dims: DimSpec[] = [
      { name: "scan_number", length: 2 },
      { name: "point_number", length: 0 },
    ];
    const gattrs: AttrSpec[] = [
      { name: "test_ionization_mode", type: 2, values: "Electron Impact" },
    ];
    const vars: VarSpec[] = [
      { name: "scan_acquisition_time", type: 6, dimIds: [0], data: [60, 120] },
      { name: "total_intensity", type: 6, dimIds: [0], data: [3, 3] },
      { name: "scan_index", type: 6, dimIds: [0], data: [0, 2] },
      // deliberately wrong point_count
      { name: "point_count", type: 6, dimIds: [0], data: [9, 1] },
      { name: "mass_values", type: 5, dimIds: [1], data: [50, 100, 75] },
      { name: "intensity_values", type: 5, dimIds: [1], data: [1, 2, 3] },
    ];
    const buf = buildCdf1(dims, gattrs, vars);
    const run = parseAndiMs(buf);
    expect(run.warnings.some((w) => w.includes("scan 0 point_count=9"))).toBe(true);
  });
});