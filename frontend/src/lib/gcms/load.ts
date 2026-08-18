// File loader & dispatcher for the GC/MS workspace (WP4).
//
// Everything runs in the browser: files are read into ArrayBuffers or text and
// never uploaded. Two entry points:
//   - `collectDroppedFiles` walks a drag-and-drop DataTransfer (including
//     dropped folders) via the File System Entries API, stamping
//     `webkitRelativePath` on each File. Ported as-is from `lib/gpc/load.ts`.
//   - `loadGcmsFiles` dispatches each file by extension AND by signature sniff of
//     the first 64 bytes, groups the Agilent `.D` companion files BY DIRECTORY
//     (so two `.D` folders dropped together are never cross-paired), and returns
//     one `MsRun` per data file plus a list of `"<filename>: <message>"` errors.
//
// Waters MassLynx `.raw` FOLDERS are read natively: their members are bucketed
// by directory (keyed on a direct-child `_FUNCnnn.DAT`) and handed to
// `waters/masslynx.ts`, which returns one run per acquisition function.
// The remaining Tier-4 vendor raw formats (Thermo/Sciex/Shimadzu/Bruker/
// MassHunter) are detected and explained with a "convert to mzML" message
// rather than throwing.
// `load.ts` stays on the main thread; heavy parsing is delegated to the worker
// via `callWorker("parseFile", ...)`. `collectDroppedFiles` and the worker are
// not testable under jsdom, so `loadGcmsFiles` is exercised with synthetic `File`
// objects in `__tests__/load.test.ts`.

import type { MsRun, RunChromatogram } from "./types";
import { isChemStationMs, parseChemStationMs } from "./agilent/chemstationMs";
import { parseChemStationCh, isChemStationCh } from "./agilent/chemstationCh";
import {
  mergeRunMeta,
  parseAcqMethod,
  parseCnormIni,
  parsePrePostIni,
} from "./agilent/method";
import { isMzml, parseMzml } from "./open/mzml";
import { isMzxml, parseMzxml } from "./open/mzxml";
import { isMgf, parseMgf } from "./open/mgf";
import { isNetcdf, readNetcdf } from "./open/netcdf";
import { parseAndiMs } from "./open/andims";
import { parseCsvChromatogram, parseJcamp, sniffTextual } from "./open/textual";
import {
  decodeWatersText,
  parseWatersRaw,
  type WatersParseOptions,
  type WatersRawBundle,
} from "./waters/masslynx";
import {
  callWorker,
  isCancelledError,
  parseWatersRawInWorker,
  type CallOptions,
} from "./workerClient";

// ---------------------------------------------------------------------------
// collectDroppedFiles — ported as-is from src/lib/gpc/load.ts
// ---------------------------------------------------------------------------

/**
 * Collect every File from a drag-and-drop `DataTransfer`. When a folder is
 * dropped, `dataTransfer.files` is empty and the only way to enumerate its
 * contents is the File System Entries API (`webkitGetAsEntry()`), which we
 * walk recursively. Falls back to the flat `files` list when no items carry
 * entries (e.g. dropped plain files in some browsers). Each collected File
 * keeps its `webkitRelativePath` set by the browser, so the `.D`-folder name
 * derivation works for both folder-drop and folder-picker.
 */
export async function collectDroppedFiles(dt: DataTransfer | null): Promise<File[]> {
  if (!dt) return [];
  const items = dt.items;
  if (!items || items.length === 0) return Array.from(dt.files ?? []);

  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return Array.from(dt.files ?? []);

  const out: File[] = [];
  const walk = (entry: FileSystemEntry, prefix: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (entry.isFile) {
        (entry as FileSystemFileEntry).file(
          (file) => {
            const rel = prefix ? `${prefix}/${file.name}` : file.name;
            Object.defineProperty(file, "webkitRelativePath", {
              value: rel,
              writable: false,
              configurable: true,
            });
            out.push(file);
            resolve();
          },
          (err) => reject(err),
        );
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const dirName = prefix ? `${prefix}/${entry.name}` : entry.name;
        const readBatch = (): void => {
          reader.readEntries(
            (batch) => {
              if (batch.length === 0) {
                resolve();
                return;
              }
              Promise.all(batch.map((child) => walk(child, dirName)))
                .then(() => readBatch())
                .catch(reject);
            },
            (err) => reject(err),
          );
        };
        readBatch();
      } else {
        resolve();
      }
    });

  await Promise.all(entries.map((e) => walk(e, "")));
  return out;
}

// ---------------------------------------------------------------------------
// loadGcmsFiles
// ---------------------------------------------------------------------------

/** The directory-keyed bucket for one Agilent `.D` folder. */
interface GroupBucket {
  /** Folder path (dirname of webkitRelativePath) — the Map key. */
  dir: string;
  /** The DATA.MS bytes + the File they came from (so we can name the run). */
  dataMsFile: File | null;
  dataMsBytes: ArrayBuffer | null;
  /** Companion text blobs, each null when absent. */
  acqmeth: string | null;
  prePost: string | null;
  cnorm: string | null;
  /** Direct-child `.CH` / `.UV` channels belonging to this DATA.MS run. */
  chromatograms: RunChromatogram[];
  /** The names of files we have already seen in this bucket (for progress). */
  fileNames: string[];
}

/** Per-batch import settings. Only vendor formats with a choice to make read these. */
export interface LoadGcmsOptions {
  /**
   * Reduce Waters continuum (profile) data to centroids while decoding.
   * Defaults to true: raw continuum m/z values do not match a vendor peak list
   * until the profile is centroided, and a profile LC run does not fit in
   * memory. Set false to keep the profile trace for peak-shape work.
   */
  centroid?: boolean;
  /** Drop centroided peaks below this fraction of the scan's base peak. */
  centroidRelThreshold?: number;
}

/** The members of one Waters `.raw` FOLDER, keyed by that folder's path. */
interface WatersBucket {
  dir: string;
  folderName: string;
  headerTxt: string | null;
  externInf: string | null;
  functnsInf: ArrayBuffer | null;
  functions: Map<number, { idx?: ArrayBuffer | null; dat?: ArrayBuffer | null }>;
}

/** `_FUNC001.DAT` / `_FUNC001.IDX` — the payload pair for one function. */
const WATERS_FUNC_FILE = /^_FUNC(\d+)\.(DAT|IDX)$/i;

/** dirname of a forward-slash path: everything before the last "/". */
function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** The path through the first `.D` directory segment, or null when absent. */
function vendorRunRoot(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/");
  const index = parts.findIndex((part) => /\.d$/i.test(part));
  return index < 0 ? null : parts.slice(0, index + 1).join("/");
}

function isDirectChild(path: string, directory: string): boolean {
  return dirname(path.replace(/\\/g, "/")) === directory;
}

function asRunChromatogram(run: MsRun): RunChromatogram {
  return {
    name: run.name,
    sourcePath: run.sourcePath,
    detector: run.detector === "uv" ? "uv" : "fid",
    rtMin: run.rtMin,
    intensity: run.tic,
    rtRange: run.rtRange,
    intensityRange: run.ticRange,
    meta: run.meta,
    warnings: run.warnings,
  };
}

/** basename of a forward-slash path: everything after the last "/". */
function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** The relative path of a File, falling back to its name when unset. */
function relPath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return rel && rel.length > 0 ? rel : file.name;
}

/** The `.D` folder name when the directory ends in `.d` (case-insensitive), else the file name. */
function runNameFor(file: File): string {
  const rel = relPath(file);
  const dir = dirname(rel);
  if (dir.length > 0) {
    const folder = basename(dir);
    if (/\.d$/i.test(folder)) return folder;
  }
  return file.name;
}

/** Read the first 64 bytes of a File for signature sniffing. */
async function sniffHead(file: File): Promise<Uint8Array> {
  const head = await file.slice(0, 64).arrayBuffer();
  return new Uint8Array(head);
}

/** Build the "convert to mzML" error message for a Tier-4 vendor raw file. */
function vendorRawMessage(name: string, vendor: string): string {
  if (vendor === "Waters") {
    // Waters IS supported — but only as the folder, which is what actually
    // holds the data. Something named `.raw` reaching here means the user
    // handed over a single file instead of the directory.
    return (
      `${name}: a Waters .raw is a FOLDER, not a file. Drag the whole ` +
      `${name} folder onto this panel (or use "Load run folder") so its ` +
      `_FUNC001.DAT and _FUNC001.IDX come with it.`
    );
  }
  return (
    `${name}: ${vendor} raw data is not readable in the browser. Convert it to ` +
    `mzML with ProteoWizard msconvert (msconvert --mzML "${name}") and drop the ` +
    `.mzML file here.`
  );
}

/** Detect Tier-4 vendor raw by extension and/or folder layout. Returns the vendor name or null. */
function detectVendorRaw(file: File, head: Uint8Array): string | null {
  const name = file.name;
  const lower = name.toLowerCase();
  const rel = relPath(file);
  const dir = dirname(rel);
  const folderName = dir.length > 0 ? basename(dir) : "";

  // Thermo .raw — a file whose first bytes are the UTF-16LE string "Finnigan".
  if (lower.endsWith(".raw")) {
    // UTF-16LE "Finnigan" = F\0i\0n\0...; sniff the head.
    if (head.length >= 18) {
      let isFinnigan = true;
      const expected = "Finnigan";
      for (let i = 0; i < expected.length; i += 1) {
        if (head[i * 2] !== expected.charCodeAt(i) || head[i * 2 + 1] !== 0) {
          isFinnigan = false;
          break;
        }
      }
      if (isFinnigan) return "Thermo";
    }
    // Not Finnigan, so this is Waters. Members of a real Waters `.raw` folder
    // never reach here — they are claimed by the `_FUNCnnn.DAT` bucket earlier
    // in the pass — so anything landing here is a lone file and gets the
    // "drop the folder" message.
    return "Waters";
  }

  // Sciex
  if (lower.endsWith(".wiff") || lower.endsWith(".wiff2") || lower.endsWith(".wiff.scan")) {
    return "Sciex";
  }

  // Shimadzu
  if (lower.endsWith(".lcd") || lower.endsWith(".qgd") || lower.endsWith(".gcd")) {
    return "Shimadzu";
  }

  // Bruker .d folder containing analysis.baf / analysis.tdf — when the dropped
  // file is itself named analysis.baf/analysis.tdf inside a .d folder.
  if ((lower === "analysis.baf" || lower === "analysis.tdf") && /\.d$/i.test(folderName)) {
    return "Bruker";
  }

  // Agilent MassHunter .d folder containing AcqData/MSScan.bin — when the
  // dropped file is MSScan.bin inside an AcqData folder inside a .d folder.
  if (lower === "msscan.bin" && /\.d$/i.test(folderName)) {
    return "Agilent MassHunter";
  }

  return null;
}

/**
 * Load a batch of dropped/picked files. Dispatches each file by extension AND
 * signature sniff, groups the Agilent `.D` companion files BY DIRECTORY (so
 * two `.D` folders dropped together never cross-pair), and returns one `MsRun`
 * per data file plus a list of `"<filename>: <message>"` errors. A bad file
 * never sinks the batch. `onProgress(msg, frac)` is called after each file and
 * each bucket, `frac` in 0..1.
 */
export async function loadGcmsFiles(
  files: File[],
  onProgress?: (msg: string, frac: number) => void,
  options?: LoadGcmsOptions,
): Promise<{ runs: MsRun[]; errors: string[] }> {
  const runs: MsRun[] = [];
  const errors: string[] = [];

  // Directory-keyed buckets. The implicit bucket "" holds files with no
  // relative path (e.g. picked individually from a flat directory).
  const buckets = new Map<string, GroupBucket>();
  // Waters `.raw` folders get their own buckets: their members share no naming
  // convention with the Agilent ones and they produce several runs each.
  const watersBuckets = new Map<string, WatersBucket>();

  function watersBucketFor(dir: string): WatersBucket {
    let b = watersBuckets.get(dir);
    if (!b) {
      b = {
        dir,
        // `dir` is "" when the user picked the folder's files individually
        // rather than dropping the folder, so there is no name to take.
        folderName: basename(dir) || dir || "Waters run",
        headerTxt: null,
        externInf: null,
        functnsInf: null,
        functions: new Map(),
      };
      watersBuckets.set(dir, b);
    }
    return b;
  }

  function bucketFor(dir: string): GroupBucket {
    let b = buckets.get(dir);
    if (!b) {
      b = {
        dir,
        dataMsFile: null,
        dataMsBytes: null,
        acqmeth: null,
        prePost: null,
        cnorm: null,
        chromatograms: [],
        fileNames: [],
      };
      buckets.set(dir, b);
    }
    return b;
  }

  const total = files.length;
  let done = 0;

  // A ChemStation run folder is identified by a direct-child `.MS` payload.
  // Once identified, nested method/audit files are auxiliary and must not be
  // mistaken for additional runs (for example `75476.M/acq.ms`).
  const chemStationRoots = new Set<string>();
  for (const file of files) {
    const rel = relPath(file).replace(/\\/g, "/");
    const root = vendorRunRoot(rel);
    if (
      root &&
      isDirectChild(rel, root) &&
      file.name.toLowerCase().endsWith(".ms")
    ) {
      chemStationRoots.add(root);
    }
  }

  // A Waters run folder is identified by a direct-child `_FUNCnnn.DAT` payload,
  // NOT by the `.raw` suffix: `.raw` folders are routinely nested inside a
  // same-named parent, and Thermo's unrelated `.raw` is a single FILE. Keying
  // on the payload puts the bucket on the directory that actually holds the
  // data no matter how the user dragged it in.
  const watersRoots = new Set<string>();
  for (const file of files) {
    if (/^_FUNC\d+\.DAT$/i.test(file.name)) {
      watersRoots.add(dirname(relPath(file).replace(/\\/g, "/")));
    }
  }

  // --- Pass 1: classify each file ------------------------------------------
  // Standalone-format files (mzML/mzXML/MGF/CDF/textual/.ch) are parsed
  // immediately. ChemStation MS data + the three companion texts are filed
  // into their directory bucket and combined in Pass 2. Tier-4 vendor raw
  // is detected and pushed as an error string.
  for (const file of files) {
    try {
      const lower = file.name.toLowerCase();
      const rel = relPath(file).replace(/\\/g, "/");

      // --- Waters `.raw` folder member --------------------------------------
      // Claimed BEFORE every other test: `_HEADER.TXT` would otherwise be
      // sniffed as a textual chromatogram, and the rest would be reported as
      // "unrecognized file type" one by one.
      const watersDir = dirname(rel);
      if (watersRoots.has(watersDir)) {
        const bucket = watersBucketFor(watersDir);
        const funcMatch = WATERS_FUNC_FILE.exec(file.name);
        if (funcMatch) {
          const fnNumber = Number.parseInt(funcMatch[1], 10);
          let slot = bucket.functions.get(fnNumber);
          if (!slot) {
            slot = {};
            bucket.functions.set(fnNumber, slot);
          }
          const buffer = await file.arrayBuffer();
          if (funcMatch[2].toUpperCase() === "DAT") slot.dat = buffer;
          else slot.idx = buffer;
        } else if (lower === "_header.txt") {
          bucket.headerTxt = decodeWatersText(await file.arrayBuffer());
        } else if (lower === "_extern.inf") {
          bucket.externInf = decodeWatersText(await file.arrayBuffer());
        } else if (lower === "_functns.inf") {
          bucket.functnsInf = await file.arrayBuffer();
        }
        // Anything else in the folder (_INLET.INF, _FUNCnnn.STS, audit trails)
        // is not needed and is skipped without an error.
        done += 1;
        if (onProgress) onProgress(`read ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }

      const root = vendorRunRoot(rel);
      const isChemStationFolder = root !== null && chemStationRoots.has(root);
      const directRunChild = isChemStationFolder && isDirectChild(rel, root!);
      const dir = isChemStationFolder ? root! : dirname(rel);

      if (isChemStationFolder && !directRunChild) {
        done += 1;
        if (onProgress) onProgress(`ignored ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }

      // --- companion text files (case-insensitive) -------------------------
      if (lower === "acqmeth.txt") {
        bucketFor(dir).acqmeth = await file.text();
        done += 1;
        if (onProgress) onProgress(`read ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }
      if (lower === "pre_post.ini") {
        bucketFor(dir).prePost = await file.text();
        done += 1;
        if (onProgress) onProgress(`read ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }
      if (lower === "cnorm.ini") {
        bucketFor(dir).cnorm = await file.text();
        done += 1;
        if (onProgress) onProgress(`read ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }

      // --- Tier-4 vendor raw (detect BEFORE signature sniff) ---------------
      // Read the head once; several branches below reuse it.
      const head = await sniffHead(file);
      const vendor = detectVendorRaw(file, head);
      if (vendor) {
        errors.push(vendorRawMessage(file.name, vendor));
        done += 1;
        if (onProgress) onProgress(`skipped ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }

      // --- ChemStation MS: .ms extension OR signature ----------------------
      if (lower.endsWith(".ms") || isChemStationMs(head)) {
        // A file literally named DATA.MS / MSD1.MS, or with no extension at
        // all, is still recognised by signature.
        const buffer = await file.arrayBuffer();
        bucketFor(dir).dataMsFile = file;
        bucketFor(dir).dataMsBytes = buffer;
        done += 1;
        if (onProgress) onProgress(`read ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }

      // --- ChemStation chromatogram: .ch / .uv OR signature ----------------
      if (lower.endsWith(".ch") || lower.endsWith(".uv") || isChemStationCh(head)) {
        const buffer = await file.arrayBuffer();
        const run = parseChemStationCh(buffer, {
          name: file.name,
          sourcePath: rel,
        });
        if (isChemStationFolder) {
          if (run.rtMin.length >= 2) {
            bucketFor(dir).chromatograms.push(asRunChromatogram(run));
          } else {
            errors.push(`${file.name}: no chromatogram points could be decoded`);
          }
        } else {
          runs.push(run);
        }
        done += 1;
        if (onProgress) onProgress(`parsed ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }

      // --- mzML ------------------------------------------------------------
      if (lower.endsWith(".mzml") || isMzml(head)) {
        const buffer = await file.arrayBuffer();
        const run = await parseMzml(buffer, {
          name: file.name,
          sourcePath: rel,
        });
        runs.push(run);
        done += 1;
        if (onProgress) onProgress(`parsed ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }

      // --- mzXML -----------------------------------------------------------
      if (lower.endsWith(".mzxml") || isMzxml(head)) {
        const buffer = await file.arrayBuffer();
        const run = await parseMzxml(buffer, {
          name: file.name,
          sourcePath: rel,
        });
        runs.push(run);
        done += 1;
        if (onProgress) onProgress(`parsed ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }

      // --- MGF -------------------------------------------------------------
      if (lower.endsWith(".mgf") || isMgf(head)) {
        const text = await file.text();
        const run = parseMgf(text, { name: file.name, sourcePath: rel });
        runs.push(run);
        done += 1;
        if (onProgress) onProgress(`parsed ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }

      // --- ANDI-MS / netCDF ------------------------------------------------
      if (lower.endsWith(".cdf") || lower.endsWith(".nc") || isNetcdf(head)) {
        const buffer = await file.arrayBuffer();
        const run = parseAndiMs(buffer, { name: file.name, sourcePath: rel });
        runs.push(run);
        done += 1;
        if (onProgress) onProgress(`parsed ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }

      // --- textual: csv/tsv/txt/jdx/dx/jcamp -------------------------------
      if (
        lower.endsWith(".csv") ||
        lower.endsWith(".tsv") ||
        lower.endsWith(".txt") ||
        lower.endsWith(".jdx") ||
        lower.endsWith(".dx") ||
        lower.endsWith(".jcamp")
      ) {
        const text = await file.text();
        const kind = sniffTextual(text);
        if (kind === "csv") {
          const run = parseCsvChromatogram(text, { name: file.name, sourcePath: rel });
          runs.push(run);
        } else if (kind === "jcamp") {
          const run = parseJcamp(text, { name: file.name, sourcePath: rel });
          runs.push(run);
        } else {
          errors.push(`${file.name}: unrecognized file type`);
        }
        done += 1;
        if (onProgress) onProgress(`parsed ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }

      // --- unrecognized -----------------------------------------------------
      if (isChemStationFolder) {
        done += 1;
        if (onProgress) onProgress(`ignored ${file.name}`, total > 0 ? done / total : 0);
        continue;
      }
      errors.push(`${file.name}: unrecognized file type`);
      done += 1;
      if (onProgress) onProgress(`skipped ${file.name}`, total > 0 ? done / total : 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${file.name}: ${message}`);
      done += 1;
      if (onProgress) onProgress(`error ${file.name}`, total > 0 ? done / total : 0);
    }
  }

  // --- Pass 2: combine the Agilent `.D` buckets ----------------------------
  // One bucket per directory => one run. The DATA.MS header values (sample,
  // operator, method, instrument, inlet, acquiredDate) MUST WIN over the
  // method file, so `run.meta` is passed LAST to mergeRunMeta.
  const bucketList = Array.from(buckets.values());
  // Only buckets that actually have a DATA.MS produce a run.
  const withData = bucketList.filter((b) => b.dataMsBytes != null && b.dataMsFile != null);
  const bucketsTotal = withData.length;
  let bucketsDone = 0;

  for (const bucket of withData) {
    try {
      const file = bucket.dataMsFile!;
      const buffer = bucket.dataMsBytes!;
      const name = runNameFor(file);
      const sourcePath = relPath(file);

      const run = parseChemStationMs(buffer, { name, sourcePath });

      // Merge the companion metadata into the run's meta. `run.meta` (the
      // DATA.MS header) is passed LAST so its values win.
      const acqMeta = bucket.acqmeth ? parseAcqMethod(bucket.acqmeth) : {};
      const prePostMeta = bucket.prePost ? parsePrePostIni(bucket.prePost) : {};
      run.meta = mergeRunMeta(acqMeta, prePostMeta, run.meta);

      // Attach the tune info and the three raw texts.
      if (bucket.cnorm) {
        run.meta.tune = parseCnormIni(bucket.cnorm);
      }
      run.meta.raw = {
        acqmeth: bucket.acqmeth ?? undefined,
        prePost: bucket.prePost ?? undefined,
        cnorm: bucket.cnorm ?? undefined,
      };
      if (bucket.chromatograms.length > 0) {
        run.chromatograms = bucket.chromatograms;
      }

      runs.push(run);
      bucketsDone += 1;
      if (onProgress) {
        const frac =
          total + bucketsTotal > 0 ? (done + bucketsDone) / (total + bucketsTotal) : 0;
        onProgress(`combined ${name}`, frac);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${bucket.dataMsFile?.name ?? bucket.dir}: ${message}`);
      bucketsDone += 1;
      if (onProgress) {
        const frac =
          total + bucketsTotal > 0 ? (done + bucketsDone) / (total + bucketsTotal) : 0;
        onProgress(`error combining bucket`, frac);
      }
    }
  }

  // --- Pass 3: decode the Waters `.raw` folders ----------------------------
  // Each folder yields ONE RUN PER ACQUISITION FUNCTION, so this pass appends
  // rather than pushing a single run. A continuum `_FUNC001.DAT` is tens of MB
  // and decoding it blocks whatever thread it runs on, so it goes to the worker
  // whenever one exists; under jsdom (tests) it falls back to this thread.
  const watersList = Array.from(watersBuckets.values()).filter((b) => b.functions.size > 0);
  for (const bucket of watersList) {
    const bundle: WatersRawBundle = {
      folderName: bucket.folderName,
      sourcePath: bucket.dir,
      headerTxt: bucket.headerTxt,
      externInf: bucket.externInf,
      functnsInf: bucket.functnsInf,
      functions: bucket.functions,
    };
    const parseOptions: Omit<WatersParseOptions, "onProgress"> = {
      centroid: options?.centroid ?? true,
      centroidRelThreshold: options?.centroidRelThreshold,
    };
    const decodeHere = () =>
      parseWatersRaw(bundle, {
        ...parseOptions,
        onProgress: (frac) => onProgress?.(`decoding ${bucket.folderName}`, frac),
      });
    /** True while the bundle's buffers are still ours — a transferred one reads 0. */
    const buffersIntact = () =>
      [...bundle.functions.values()].every((f) => (f.dat?.byteLength ?? 0) > 0);

    try {
      if (typeof Worker === "undefined") {
        // No worker in this environment (jsdom under test).
        const result = decodeHere();
        runs.push(...result.runs);
        errors.push(...result.errors);
      } else {
        try {
          const result = await parseWatersRawInWorker(bundle, parseOptions, {
            onProgress: (frac) => onProgress?.(`decoding ${bucket.folderName}`, frac),
          });
          runs.push(...result.runs);
          errors.push(...result.errors);
        } catch (workerErr) {
          if (isCancelledError(workerErr)) throw workerErr;
          // The worker failed to spawn or crashed. If it never got as far as
          // transferring the buffers they are still readable, so decode on this
          // thread rather than losing the import — the same main-thread
          // fallback the rest of the workspace uses when the worker is down.
          if (!buffersIntact()) throw workerErr;
          const result = decodeHere();
          runs.push(...result.runs);
          errors.push(...result.errors);
        }
      }
    } catch (err) {
      if (isCancelledError(err)) throw err;
      errors.push(
        `${bucket.folderName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (onProgress) onProgress(`loaded ${bucket.folderName}`, 1);
  }

  return { runs, errors };
}

// ---------------------------------------------------------------------------
// Worker-backed single-file parse (optional convenience)
// ---------------------------------------------------------------------------

/**
 * Parse a single file in the GC/MS worker. The worker transfers the inbound
 * ArrayBuffer (`postMessage(msg, [buffer])`) so the caller's `buffer` is
 * DETACHED afterwards — do not reuse it. Returns one `MsRun` or rejects with a
 * `GcmsWorkerError`.
 */
export async function parseFileInWorker(
  buffer: ArrayBuffer,
  name: string,
  sourcePath: string,
  options?: CallOptions,
): Promise<MsRun> {
  try {
    const { run } = await callWorker("parseFile", { buffer, name, sourcePath }, options);
    return run;
  } catch (err) {
    if (isCancelledError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${name}: ${message}`);
  }
}
