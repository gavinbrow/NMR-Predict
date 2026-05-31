// Berkeley DB Hash (on-disk) reader for Shimadzu `.ispd` files — pure byte math
// over an ArrayBuffer via DataView, no native library. This is load-bearing:
// the scientific payload (spectra, axis descriptors) lives as key/data records
// inside a BDB hash database, which we walk page by page here.
//
// IMPORTANT: every read in THIS file uses the database's detected byte order.
// The scientific-payload doubles parsed downstream (spectrum.ts) are ALWAYS
// little-endian regardless of this order — do not apply the detected order to
// those. See the §1 / §2 spec notes.

/** Meta-page magic for a BDB hash database, at byte offset 12. */
const META_MAGIC = 0x00061561;

/** Page header is 26 bytes; the page type lives in byte 25. */
const PAGE_HEADER = 26;

/** Page types we care about. */
const PAGE_HASH_DATA = 2;
const PAGE_HASH_DATA_ALT = 13;
const PAGE_OVERFLOW = 7;

/** Item types within a hash data page. */
const ITEM_INLINE = 1;
const ITEM_OFFPAGE = 3;

export interface BdbDatabase {
  byteOrder: "LE" | "BE";
  pageSize: number;
  /**
   * key → data. The key is the raw key bytes encoded 1:1 into a latin1 string
   * (lossless for bytes 0–255), so it round-trips and is safe to use as a Map
   * key. The data is the raw value bytes. Pairing/decoding into spectra happens
   * in spectrum.ts.
   */
  records: Map<string, Uint8Array>;
}

/** Encode raw bytes 1:1 into a latin1 string (used only as a Map key). */
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Parse a `.ispd` (BDB hash) file into its key/data records. Throws
 * "not a BDB hash file" if the magic, byte order, or page size don't check out.
 */
export function parseBdb(buffer: ArrayBuffer): BdbDatabase {
  const fileLength = buffer.byteLength;
  if (fileLength < PAGE_HEADER) throw new Error("not a BDB hash file");

  const view = new DataView(buffer);

  // Detect byte order from the meta-page magic at offset 12 (LE first, then BE).
  let littleEndian: boolean;
  if (view.getUint32(12, true) === META_MAGIC) littleEndian = true;
  else if (view.getUint32(12, false) === META_MAGIC) littleEndian = false;
  else throw new Error("not a BDB hash file");

  const u16 = (off: number) => view.getUint16(off, littleEndian);
  const u32 = (off: number) => view.getUint32(off, littleEndian);

  // Page size at offset 20, in {512…65536} and an exact divisor of the file.
  const pageSize = u32(20);
  if (pageSize < 512 || pageSize > 65536 || fileLength % pageSize !== 0) {
    throw new Error("not a BDB hash file");
  }
  const npages = fileLength / pageSize;

  const bytes = new Uint8Array(buffer);

  // Follow an off-page overflow chain from `startPage`, collecting up to
  // `totalLen` bytes. Stops on page 0, out-of-range page, a cycle, a non-overflow
  // page, or once enough bytes are read. Returns null if nothing was collected.
  const readOverflow = (startPage: number, totalLen: number): Uint8Array | null => {
    if (totalLen <= 0) return null;
    const out = new Uint8Array(totalLen);
    let written = 0;
    let pgno = startPage;
    const seen = new Set<number>();
    while (pgno !== 0 && written < totalLen) {
      if (pgno < 0 || pgno >= npages || seen.has(pgno)) break;
      seen.add(pgno);
      const base = pgno * pageSize;
      if (bytes[base + 25] !== PAGE_OVERFLOW) break;
      const onPage = u16(base + 22); // bytes of payload on this page
      const take = Math.min(onPage, totalLen - written);
      out.set(bytes.subarray(base + PAGE_HEADER, base + PAGE_HEADER + take), written);
      written += take;
      pgno = u32(base + 16); // next page in the chain (0 = end)
    }
    if (written === 0) return null;
    return written === totalLen ? out : out.subarray(0, written);
  };

  const records = new Map<string, Uint8Array>();

  for (let pg = 0; pg < npages; pg += 1) {
    const base = pg * pageSize;
    const pageType = bytes[base + 25];
    if (pageType !== PAGE_HASH_DATA && pageType !== PAGE_HASH_DATA_ALT) continue;

    const entryCount = u16(base + 20);

    // The `inp` offset array: entryCount u16 offsets starting at base+26. Each is
    // a page-relative offset to one item.
    const inp: number[] = [];
    for (let i = 0; i < entryCount; i += 1) inp.push(u16(base + PAGE_HEADER + 2 * i));

    // An item ends at the next-higher valid offset on the page (or at pageSize).
    const sortedValid = inp
      .filter((o) => o >= PAGE_HEADER && o < pageSize)
      .slice()
      .sort((a, b) => a - b);

    // Decode each item to its raw bytes (or null when the type is unrecognized).
    const vals: (Uint8Array | null)[] = [];
    for (let i = 0; i < entryCount; i += 1) {
      const off = inp[i];
      if (off < PAGE_HEADER || off >= pageSize) {
        vals.push(null);
        continue;
      }
      // itemEnd = smallest valid offset strictly greater than `off`, else pageSize.
      let end = pageSize;
      for (const o of sortedValid) {
        if (o > off) {
          end = o;
          break;
        }
      }
      const absOff = base + off;
      const itemType = bytes[absOff];
      if (itemType === ITEM_INLINE) {
        // Inline payload: bytes (off+1 .. itemEnd).
        vals.push(bytes.slice(absOff + 1, base + end));
      } else if (itemType === ITEM_OFFPAGE) {
        const firstPage = u32(absOff + 4);
        const totalLen = u32(absOff + 8);
        vals.push(readOverflow(firstPage, totalLen));
      } else {
        vals.push(null);
      }
    }

    // Items alternate key, data, key, data… — pair them when both are non-null.
    for (let k = 0; 2 * k + 1 < vals.length; k += 1) {
      const key = vals[2 * k];
      const data = vals[2 * k + 1];
      if (key && data) records.set(latin1(key), data);
    }
  }

  return { byteOrder: littleEndian ? "LE" : "BE", pageSize, records };
}
