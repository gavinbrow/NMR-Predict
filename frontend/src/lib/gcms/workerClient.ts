// Typed, promise-based client for the GC/MS compute worker.
//
// This is the GC/MS equivalent of the MALDI worker client (`maldi/workerClient.ts`):
// instead of HTTP requests it sends correlated messages to the Web Worker and
// resolves a promise when the matching result comes back. It owns the single
// worker instance, matches responses to requests by id, surfaces progress,
// supports cancellation via AbortSignal, and normalizes worker errors into
// {@link GcmsWorkerError}.
//
// The worker is instantiated exactly as in MALDI:
//   new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
//
// On a worker-level error every in-flight call is rejected and the worker is
// reset so the next call respawns it (singleton-with-respawn).

import type { ChromPeak, ChromTrace, MassSpectrum, MsRun } from "./types";
import type { DetectChromPeaksOpts } from "./peaks";
import type {
  WorkerOp,
  WorkerRequestMessage,
  WorkerRequestPayload,
  WorkerResponseMessage,
  WorkerResultPayload,
} from "./workerProtocol";

/** Error thrown for any failed worker call. */
export class GcmsWorkerError extends Error {
  constructor(message: string, name = "GcmsWorkerError") {
    super(message);
    this.name = name;
  }
}

/** True for the error a cancelled call rejects with — callers can ignore it. */
export function isCancelledError(error: unknown): boolean {
  return error instanceof GcmsWorkerError && error.name === "CancelledError";
}

export interface CallOptions {
  /** Abort the call; the worker is told to stop and the promise rejects. */
  signal?: AbortSignal;
  /** Receive 0..1 progress ticks for long-running ops. */
  onProgress?: (progress: number, message?: string) => void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onProgress?: (progress: number, message?: string) => void;
  cleanup: () => void;
}

let worker: Worker | null = null;
const pending = new Map<string, PendingCall>();

function nextId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function handleMessage(event: MessageEvent<WorkerResponseMessage>) {
  const message = event.data;
  const call = pending.get(message.id);
  if (!call) return;

  switch (message.kind) {
    case "progress":
      call.onProgress?.(message.progress, message.message);
      return;
    case "result":
      call.cleanup();
      pending.delete(message.id);
      call.resolve(message.result);
      return;
    case "error":
      call.cleanup();
      pending.delete(message.id);
      call.reject(new GcmsWorkerError(message.error.message, message.error.name));
      return;
  }
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = handleMessage;
    worker.onerror = (event) => {
      // A worker-level error has no request id; fail every in-flight call so no
      // promise hangs, then reset so the next call respawns the worker.
      const err = new GcmsWorkerError(event.message || "GC/MS worker crashed");
      for (const [, call] of pending) {
        call.cleanup();
        call.reject(err);
      }
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

/**
 * Run an operation in the GC/MS worker. Returns the typed result for that op.
 *
 * For `parseFile` the request `buffer` is TRANSFERRED to the worker (the
 * caller's ArrayBuffer is detached afterwards — do not reuse it).
 *
 * @example
 *   const { ok } = await callWorker("ping", {});
 *   const { run } = await callWorker("parseFile", { buffer, name, sourcePath });
 */
export function callWorker<Op extends WorkerOp>(
  op: Op,
  payload: WorkerRequestPayload<Op>,
  options: CallOptions = {},
): Promise<WorkerResultPayload<Op>> {
  const w = getWorker();
  const id = nextId();

  return new Promise<WorkerResultPayload<Op>>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GcmsWorkerError("Operation cancelled", "CancelledError"));
      return;
    }

    const onAbort = () => {
      w.postMessage({ kind: "cancel", id });
      const call = pending.get(id);
      call?.cleanup();
      pending.delete(id);
      reject(new GcmsWorkerError("Operation cancelled", "CancelledError"));
    };

    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      onProgress: options.onProgress,
      cleanup,
    });

    // Transfer the inbound ArrayBuffer for parseFile so a 300 MB mzML is not
    // structured-cloned. The caller's `buffer` is detached after this call.
    const msg: WorkerRequestMessage = { kind: "request", id, op, payload };
    if (op === "parseFile") {
      const buffer = (payload as { buffer: ArrayBuffer }).buffer;
      w.postMessage(msg, [buffer]);
    } else {
      w.postMessage(msg);
    }
  });
}

/** Liveness/echo check — confirms the worker is wired. */
export function ping(options?: CallOptions) {
  return callWorker("ping", {} as Record<string, never>, options);
}

// --- Convenience wrappers, one per compute op (all run in the worker) --------

/**
 * Parse a single file in the worker. The `buffer` is TRANSFERRED — the caller's
 * ArrayBuffer is detached afterwards, so do not reuse it.
 */
export function parseFile(
  buffer: ArrayBuffer,
  name: string,
  sourcePath: string,
  options?: CallOptions,
) {
  return callWorker("parseFile", { buffer, name, sourcePath }, options);
}

export function buildXic(
  run: MsRun,
  mzList: number[],
  tol: number,
  mode: "sum" | "max",
  options?: CallOptions,
) {
  return callWorker("buildXic", { run, mzList, tol, mode }, options);
}

/** Build one independent, sum-mode XIC per m/z in a single worker request. */
export function buildXics(run: MsRun, mzList: number[], tol: number, options?: CallOptions) {
  return callWorker("buildXics", { run, mzList, tol }, options);
}

export function sumScans(
  run: MsRun,
  rtLo: number,
  rtHi: number,
  mode: "sum" | "mean",
  binTol?: number,
  options?: CallOptions,
) {
  return callWorker("sumScans", { run, rtLo, rtHi, mode, binTol }, options);
}

export function detectChromPeaks(trace: ChromTrace, opts: DetectChromPeaksOpts, options?: CallOptions) {
  return callWorker("detectChromPeaks", { trace, opts }, options);
}

/** Tear the worker down (e.g. on workspace unmount or for tests). */
export function disposeWorker() {
  worker?.terminate();
  worker = null;
  pending.clear();
}

// Re-export the result payload types for callers that destructure the result.
export type { ChromPeak, ChromTrace, MassSpectrum, MsRun };
