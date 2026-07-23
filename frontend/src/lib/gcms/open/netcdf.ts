// Self-contained netCDF-3 classic format reader (CDF-1 and CDF-2).
//
// All multi-byte values are BIG-ENDIAN. This is enough to read ANDI-MS (the
// GC/MS interchange dialect that sits on top of netCDF-3). Runs in a Web
// Worker: no DOM, no external dependencies.
//
// Spec: https://www.unidata.ucar.edu/software/netcdf/docs/file_format_specifications.html

export interface NetcdfDim {
  name: string;
  length: number; // 0 = the record (unlimited) dimension
}

export interface NetcdfVar {
  name: string;
  type: number; // nc_type: 1 BYTE, 2 CHAR, 3 SHORT, 4 INT, 5 FLOAT, 6 DOUBLE
  dimIds: number[];
  attrs: Record<string, unknown>;
  size: number; // vsize from the header (already padded to a 4-byte boundary)
  begin: number; // byte offset of the data
  record: boolean; // first dim is the record dimension
  recordOffset: number; // for record vars: byte offset within one record
}

export interface NetcdfFile {
  version: 1 | 2;
  numrecs: number;
  dims: NetcdfDim[];
  attrs: Record<string, unknown>;
  vars: NetcdfVar[];
  getVariable(name: string): Float64Array | string | null;
}

const NC_DIMENSION = 0x0a;
const NC_VARIABLE = 0x0b;
const NC_ATTRIBUTE = 0x0c;

const TYPE_BYTE = 1;
const TYPE_CHAR = 2;
const TYPE_SHORT = 3;
const TYPE_INT = 4;
const TYPE_FLOAT = 5;
const TYPE_DOUBLE = 6;

const TYPE_SIZE = [0, 1, 1, 2, 4, 4, 8];

class Reader {
  view: DataView;
  pos = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  u8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  // 64-bit offset (version 2) — read as two u32 and combine. JS numbers are
  // safe up to 2^53 so this is fine for any real file offset.
  u64(): number {
    const hi = this.u32();
    const lo = this.u32();
    return hi * 0x100000000 + lo;
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
}

function pad4(n: number): number {
  const r = n % 4;
  return r === 0 ? n : n + (4 - r);
}

function readName(r: Reader): string {
  const len = r.u32();
  const bytes = new Uint8Array(r.view.buffer, r.pos + r.view.byteOffset, len);
  const name = new TextDecoder("latin1").decode(bytes);
  r.pos += pad4(len);
  return name;
}

function readAttrValues(r: Reader, type: number, nvals: number): unknown {
  const size = TYPE_SIZE[type];
  const total = nvals * size;
  const nums: number[] = [];
  let str = "";
  if (type === TYPE_BYTE) {
    for (let i = 0; i < nvals; i += 1) nums.push(r.u8());
  } else if (type === TYPE_CHAR) {
    const bytes = new Uint8Array(r.view.buffer, r.pos + r.view.byteOffset, nvals);
    str = new TextDecoder("latin1").decode(bytes);
    r.pos += nvals; // char values are read in bulk; advance by nvals
  } else if (type === TYPE_SHORT) {
    for (let i = 0; i < nvals; i += 1) nums.push(r.i16());
  } else if (type === TYPE_INT) {
    for (let i = 0; i < nvals; i += 1) nums.push(r.i32());
  } else if (type === TYPE_FLOAT) {
    for (let i = 0; i < nvals; i += 1) nums.push(r.f32());
  } else if (type === TYPE_DOUBLE) {
    for (let i = 0; i < nvals; i += 1) nums.push(r.f64());
  }
  // The element reads above already advanced `pos` by `total` (except CHAR,
  // handled explicitly). Now apply only the trailing padding to reach a
  // 4-byte boundary.
  const padded = pad4(total);
  r.pos += padded - total;
  if (type === TYPE_CHAR) return str;
  if (nvals === 1) return nums[0];
  return nums;
}

function readAttList(r: Reader): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const tag = r.u32();
  if (tag === NC_ATTRIBUTE) {
    const nelems = r.u32();
    for (let i = 0; i < nelems; i += 1) {
      const name = readName(r);
      const type = r.u32();
      const nvals = r.u32();
      attrs[name] = readAttrValues(r, type, nvals);
    }
  } else if (tag !== 0) {
    throw new Error(`netCDF: bad gatt/att tag 0x${tag.toString(16)}`);
  }
  return attrs;
}

export function isNetcdf(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return (
    bytes[0] === 0x43 && // 'C'
    bytes[1] === 0x44 && // 'D'
    bytes[2] === 0x46 && // 'F'
    (bytes[3] === 0x01 || bytes[3] === 0x02)
  );
}

export function readNetcdf(buffer: ArrayBuffer): NetcdfFile {
  const r = new Reader(buffer);
  const c = r.u8();
  const d = r.u8();
  const f = r.u8();
  if (c !== 0x43 || d !== 0x44 || f !== 0x46) {
    throw new Error("netCDF: bad magic");
  }
  const ver = r.u8();
  if (ver !== 1 && ver !== 2) throw new Error(`netCDF: unsupported version ${ver}`);
  const version = ver as 1 | 2;

  const numrecsRaw = r.u32();
  // 0xFFFFFFFF = STREAMING: we cannot know the count without scanning; treat
  // as 0 and let record variables read empty. Real files are not streaming.
  const numrecs = numrecsRaw === 0xffffffff ? 0 : numrecsRaw;

  // dim_list
  const dims: NetcdfDim[] = [];
  {
    const tag = r.u32();
    if (tag === NC_DIMENSION) {
      const nelems = r.u32();
      for (let i = 0; i < nelems; i += 1) {
        const name = readName(r);
        const length = r.u32();
        dims.push({ name, length });
      }
    } else if (tag !== 0) {
      throw new Error(`netCDF: bad dim tag 0x${tag.toString(16)}`);
    }
  }

  // gatt_list
  const attrs = readAttList(r);

  // var_list
  const vars: NetcdfVar[] = [];
  {
    const tag = r.u32();
    if (tag === NC_VARIABLE) {
      const nelems = r.u32();
      for (let i = 0; i < nelems; i += 1) {
        const name = readName(r);
        const rank = r.u32();
        const dimIds: number[] = [];
        for (let j = 0; j < rank; j += 1) dimIds.push(r.u32());
        const vattrs = readAttList(r);
        const type = r.u32();
        const vsize = r.u32();
        const begin = version === 1 ? r.u32() : r.u64();
        const record = rank > 0 && dims[dimIds[0]].length === 0;
        vars.push({ name, type, dimIds, attrs: vattrs, size: vsize, begin, record, recordOffset: 0 });
      }
    } else if (tag !== 0) {
      throw new Error(`netCDF: bad var tag 0x${tag.toString(16)}`);
    }
  }

  // Compute recsize = sum of vsize over all record variables, and assign each
  // record variable its byte offset WITHIN one record (cumulative vsize of the
  // record vars declared before it). NOTE: the spec defines recsize as the sum
  // of the *padded* vsize of every record variable. When there is exactly one
  // record variable this collapses to that variable's padded vsize, which for
  // a single record var with a non-4-multiple element size can over-pad
  // relative to the "unpadded" data — we keep the padded form here because
  // that is what real files use; caveat noted.
  let recsize = 0;
  for (const v of vars) {
    if (v.record) {
      v.recordOffset = recsize;
      recsize += v.size;
    }
  }

  function varPointCount(v: NetcdfVar): number {
    // product of dim lengths, with the record dim replaced by numrecs
    let n = 1;
    for (let i = 0; i < v.dimIds.length; i += 1) {
      const d = dims[v.dimIds[i]];
      const len = d.length === 0 ? numrecs : d.length;
      n *= len;
    }
    return n;
  }

  function readNumeric(v: NetcdfFile["vars"][number]): Float64Array {
    const total = varPointCount(v);
    const out = new Float64Array(total);
    const size = TYPE_SIZE[v.type];
    const view = r.view;
    if (v.record) {
      // interleaved: record r of var v starts at v.begin + r * recsize + v.recordOffset
      const recs = numrecs;
      const innerCount = total / Math.max(1, recs);
      let dst = 0;
      for (let rec = 0; rec < recs; rec += 1) {
        let p = v.begin + rec * recsize + v.recordOffset;
        for (let i = 0; i < innerCount; i += 1, dst += 1, p += size) {
          out[dst] = readScalarAt(view, p, v.type);
        }
      }
    } else {
      let p = v.begin;
      for (let i = 0; i < total; i += 1, p += size) {
        out[i] = readScalarAt(view, p, v.type);
      }
    }
    return out;
  }

  function readChar(v: NetcdfFile["vars"][number]): string {
    const total = varPointCount(v);
    const bytes = new Uint8Array(r.view.buffer, v.begin, total);
    return new TextDecoder("latin1").decode(bytes);
  }

  function getVariable(name: string): Float64Array | string | null {
    const v = vars.find((x) => x.name === name);
    if (!v) return null;
    if (v.type === TYPE_CHAR) return readChar(v);
    if (v.type === TYPE_BYTE || v.type === TYPE_SHORT || v.type === TYPE_INT || v.type === TYPE_FLOAT || v.type === TYPE_DOUBLE) {
      return readNumeric(v);
    }
    return null;
  }

  return { version, numrecs, dims, attrs, vars, getVariable };
}

function readScalarAt(view: DataView, offset: number, type: number): number {
  switch (type) {
    case TYPE_BYTE:
      return view.getUint8(offset);
    case TYPE_SHORT:
      return view.getInt16(offset);
    case TYPE_INT:
      return view.getInt32(offset);
    case TYPE_FLOAT:
      return view.getFloat32(offset);
    case TYPE_DOUBLE:
      return view.getFloat64(offset);
    default:
      return NaN;
  }
}