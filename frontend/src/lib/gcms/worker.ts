/// <reference lib="webworker" />
//
// GC/MS compute Web Worker — entry point and message dispatcher (WP4).
//
// All non-trivial GC/MS parsing (DATA.MS, mzML, mzXML, MGF, ANDI-MS, textual)
// and the heavier chromatogram/spectrum computations (XIC, scan summing, peak
// detection) run here so the main thread stays responsive during large file
// imports. This file is intentionally just a router: each operation is a handler
// keyed by op name, and the heavy logic lands in sibling modules
// (agilent/*, open/*, chrom.ts, peaks.ts).
//
// Instantiated from the client with:
//   new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
//
// The worker protocol mirrors the MALDI worker's architecture: a typed
// `WorkerOpMap` contract (defined in ./workerProtocol.ts), the
// `{ kind: "request" | "cancel" | "result" | "error" | "progress" }` envelope,
// `crypto.randomUUID()` correlation ids, a cancelled-id set with cooperative
// cancellation, and a progress channel.
//
// Two improvements over the MALDI source:
//   a. TRANSFER the inbound ArrayBuffer: `postMessage(msg, [buffer])` rather
//      than structured-cloning it. A 575 KB DATA.MS is nothing, a 300 MB mzML
//      is not. NOTE: the caller's buffer is DETACHED afterwards.
//   b. ACTUALLY DRIVE `reportProgress` from the parse loops — the worker's
//      progress callback is passed into each parser's `onProgress` option.

import { parseChemStationMs } from "./agilent/chemstationMs";
import { parseChemStationCh } from "./agilent/chemstationCh";
import { isMzml, parseMzml } from "./open/mzml";
import { isMzxml, parseMzxml } from "./open/mzxml";
import { isMgf, parseMgf } from "./open/mgf";
import { isNetcdf, readNetcdf } from "./open/netcdf";
import { isAndiMs } from "./open/andims";
import { parseAndiMs } from "./open/andims";
import { parseCsvChromatogram, parseJcamp, sniffTextual } from "./open/textual";
import { parseWatersRaw } from "./waters/masslynx";
import { buildXic, buildXics } from "./chrom";
import { combineScans } from "./chrom";
import { detectChromPeaks } from "./peaks";
import type { DetectChromPeaksOpts } from "./peaks";
import type { MsRun, ChromTrace, MassSpectrum, ChromPeak } from "./types";
import type {
  WorkerOp,
  WorkerRequestMessage,
  WorkerRequestPayload,
  WorkerResponseMessage,
  WorkerResultPayload,
} from "./workerProtocol";

// The worker global. `self` is the DedicatedWorkerGlobalScope here.
const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Ids the client has asked to cancel; handlers poll this between work chunks. */
const cancelled = new Set<string>();

/** Per-request context handed to each handler. */
export interface HandlerContext {
  /** True once the client has cancelled this request. */
  isCancelled(): boolean;
  /** Report 0..1 progress for long-running ops. */
  reportProgress(progress: number, message?: string): void;
}

/** Thrown by a handler (or the dispatcher) when a request was cancelled. */
export class CancelledError extends Error {
  constructor() {
    super("Operation cancelled");
    this.name = "CancelledError";
  }
}

type Handler<Op extends WorkerOp> = (
  payload: WorkerRequestPayload<Op>,
  ctx: HandlerContext,
) => Promise<WorkerResultPayload<Op>> | WorkerResultPayload<Op>;

// ---------------------------------------------------------------------------
// parseFile — dispatch a single file by name + signature sniff of first 64 B
// ---------------------------------------------------------------------------

const handlers: { [Op in WorkerOp]: Handler<Op> } = {
  ping: () => ({ ok: true }),

  parseFile: async (payload, hctx) => {
    const { buffer, name, sourcePath } = payload;
    const bytes = new Uint8Array(buffer);
    const head = bytes.subarray(0, Math.min(64, bytes.length));

    // ChemStation MS — sniff signature for extension-less DATA.MS.
    const isCsMs =
      name.toLowerCase().endsWith(".ms") ||
      name.toLowerCase() === "data.ms" ||
      name.toLowerCase() === "msd1.ms" ||
      isChemStationMsSignature(head);
    if (isCsMs) {
      const run = parseChemStationMs(buffer, {
        name,
        sourcePath,
        onProgress: (f) => hctx.reportProgress(f),
      });
      return { run };
    }

    // ChemStation .ch / .uv
    if (name.toLowerCase().endsWith(".ch") || name.toLowerCase().endsWith(".uv")) {
      const run = parseChemStationCh(buffer, { name, sourcePath });
      return { run };
    }

    // mzML
    if (name.toLowerCase().endsWith(".mzml") || isMzml(head)) {
      const run = await parseMzml(buffer, {
        name,
        sourcePath,
        onProgress: (f) => hctx.reportProgress(f),
      });
      return { run };
    }

    // mzXML
    if (name.toLowerCase().endsWith(".mzxml") || isMzxml(head)) {
      const run = await parseMzxml(buffer, {
        name,
        sourcePath,
        onProgress: (f) => hctx.reportProgress(f),
      });
      return { run };
    }

    // MGF
    if (name.toLowerCase().endsWith(".mgf") || isMgf(head)) {
      const text = new TextDecoder("utf-8").decode(bytes);
      const run = parseMgf(text, { name, sourcePath });
      return { run };
    }

    // ANDI-MS / netCDF
    if (name.toLowerCase().endsWith(".cdf") || name.toLowerCase().endsWith(".nc") || isNetcdf(head)) {
      const file = readNetcdf(buffer);
      if (!isAndiMs(file)) {
        throw new Error(`${name}: not an ANDI-MS netCDF (required variables missing)`);
      }
      const run = parseAndiMs(buffer, { name, sourcePath });
      return { run };
    }

    // Textual
    const lower = name.toLowerCase();
    if (
      lower.endsWith(".csv") ||
      lower.endsWith(".tsv") ||
      lower.endsWith(".txt") ||
      lower.endsWith(".jdx") ||
      lower.endsWith(".dx") ||
      lower.endsWith(".jcamp")
    ) {
      const text = new TextDecoder("utf-8").decode(bytes);
      const kind = sniffTextual(text);
      if (kind === "csv") {
        const run = parseCsvChromatogram(text, { name, sourcePath });
        return { run };
      }
      if (kind === "jcamp") {
        const run = parseJcamp(text, { name, sourcePath });
        return { run };
      }
      throw new Error(`${name}: unrecognized file type`);
    }

    throw new Error(`${name}: unrecognized file type`);
  },

  parseWatersRaw: (payload, hctx) => {
    const { runs, errors } = parseWatersRaw(payload.bundle, {
      ...payload.options,
      onProgress: (frac, msg) => hctx.reportProgress(frac, msg),
    });
    return { runs, errors };
  },

  buildXic: (payload) => {
    const trace = buildXic(payload.run, payload.mzList, payload.tol, payload.mode);
    return { trace };
  },

  buildXics: (payload) => {
    const traces = buildXics(payload.run, payload.mzList, payload.tol);
    return { traces };
  },

  sumScans: (payload) => {
    const spectrum = combineScans(
      payload.run,
      payload.rtLo,
      payload.rtHi,
      payload.mode,
      payload.binTol,
    );
    return { spectrum };
  },

  detectChromPeaks: (payload) => {
    const peaks = detectChromPeaks(payload.trace, payload.opts as DetectChromPeaksOpts);
    return { peaks };
  },
};

// Inline ChemStation MS signature sniff to avoid a circular import.
// Mirrors agilent/chemstationMs.ts:isChemStationMs but is local to the worker.
function isChemStationMsSignature(bytes: Uint8Array): boolean {
  if (bytes.length >= 2) {
    const magic = (bytes[0] << 8) | bytes[1];
    if (magic === 0x0132) return true;
  }
  const head = bytes.subarray(0, Math.min(64, bytes.length));
  let s = "";
  for (let i = 0; i < head.length; i += 1) s += String.fromCharCode(head[i]);
  return s.includes("GC / MS D");
}

// --- transferable result buffers -------------------------------------------

/** Collect the ArrayBuffer-backed typed-array buffers of a run for the transfer list. */
function runTransferList(run: MsRun): ArrayBuffer[] {
  const list: ArrayBuffer[] = [];
  for (const arr of [
    run.rtMin,
    run.tic,
    run.basePeakMz,
    run.basePeakIntensity,
    run.msLevel,
    run.scanOffset,
    run.mz,
    run.intensity,
  ]) {
    if (arr && arr.buffer instanceof ArrayBuffer && arr.byteLength > 0) {
      // Only transfer buffers this worker owns (i.e. not a view onto a larger
      // buffer, and not already detached). subarray views share a buffer —
      // transfer the underlying buffer only once.
      if (!list.includes(arr.buffer)) list.push(arr.buffer);
    }
  }
  return list;
}

function traceTransferList(trace: ChromTrace): ArrayBuffer[] {
  const list: ArrayBuffer[] = [];
  for (const arr of [trace.rtMin, trace.intensity]) {
    if (arr && arr.buffer instanceof ArrayBuffer && arr.byteLength > 0) {
      if (!list.includes(arr.buffer)) list.push(arr.buffer);
    }
  }
  return list;
}

/** Collect and de-duplicate all typed-array buffers across a trace batch. */
function tracesTransferList(traces: ChromTrace[]): ArrayBuffer[] {
  const list: ArrayBuffer[] = [];
  for (const trace of traces) {
    for (const buffer of traceTransferList(trace)) {
      if (!list.includes(buffer)) list.push(buffer);
    }
  }
  return list;
}

function spectrumTransferList(spec: MassSpectrum): ArrayBuffer[] {
  const list: ArrayBuffer[] = [];
  for (const arr of [spec.mz, spec.intensity]) {
    if (arr && arr.buffer instanceof ArrayBuffer && arr.byteLength > 0) {
      if (!list.includes(arr.buffer)) list.push(arr.buffer);
    }
  }
  return list;
}

function post(message: WorkerResponseMessage, transfer?: ArrayBuffer[]): void {
  if (transfer && transfer.length > 0) ctx.postMessage(message, transfer);
  else ctx.postMessage(message);
}

async function dispatch(id: string, op: WorkerOp, payload: WorkerRequestPayload<WorkerOp>) {
  const handlerCtx: HandlerContext = {
    isCancelled: () => cancelled.has(id),
    reportProgress: (progress, message) => post({ kind: "progress", id, progress, message }),
  };

  try {
    const handler = handlers[op] as Handler<WorkerOp> | undefined;
    if (!handler) throw new Error(`Unknown GC/MS worker op: ${op}`);
    const result = await handler(payload, handlerCtx);
    if (handlerCtx.isCancelled()) throw new CancelledError();

    // Determine the transfer list from the result shape so the typed-array
    // buffers are moved, not copied, back to the main thread.
    let transfer: ArrayBuffer[] | undefined;
    if (op === "parseFile") {
      const r = result as { run: MsRun };
      transfer = runTransferList(r.run);
    } else if (op === "buildXic") {
      const r = result as { trace: ChromTrace };
      transfer = traceTransferList(r.trace);
    } else if (op === "buildXics") {
      const r = result as { traces: ChromTrace[] };
      transfer = tracesTransferList(r.traces);
    } else if (op === "sumScans") {
      const r = result as { spectrum: MassSpectrum };
      transfer = spectrumTransferList(r.spectrum);
    }
    post({ kind: "result", id, result }, transfer);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    post({ kind: "error", id, error: { name: err.name, message: err.message } });
  } finally {
    cancelled.delete(id);
  }
}

ctx.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  const message = event.data;
  if (message.kind === "cancel") {
    cancelled.add(message.id);
    return;
  }
  void dispatch(message.id, message.op, message.payload);
};
