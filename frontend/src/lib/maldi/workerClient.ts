// Typed, promise-based client for the MALDI compute worker.
//
// This is the MALDI equivalent of the old axios `api` layer: instead of HTTP
// requests it sends correlated messages to the Web Worker and resolves a promise
// when the matching result comes back. It owns the single worker instance,
// matches responses to requests by id, surfaces progress, supports cancellation
// via AbortSignal, and normalizes worker errors into {@link MaldiWorkerError}.

import type {
  Adduct,
  Peak,
  ProcessingStep,
  SpectrumData,
  WorkerOp,
  WorkerRequestPayload,
  WorkerResponseMessage,
  WorkerResultPayload,
} from "./types";
import type { FlagOptions } from "./library";
import type { ParseOptions } from "./parse";
import type { PeakPickParams } from "./peaks";
import type { AssignOptions, CopolymerOptions, RepeatDetectOptions } from "./polymers";
import type { EndGroupOptions } from "./endgroups";
import type { FormulaCandidateOptions } from "./formula";
import type { LossDetectOptions } from "./losses";

/** Error thrown for any failed worker call (mirrors `NmrApiError`'s shape). */
export class MaldiWorkerError extends Error {
  constructor(message: string, name = "MaldiWorkerError") {
    super(message);
    this.name = name;
  }
}

/** True for the error a cancelled call rejects with — callers can ignore it. */
export function isCancelledError(error: unknown): boolean {
  return error instanceof MaldiWorkerError && error.name === "CancelledError";
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
      call.reject(new MaldiWorkerError(message.error.message, message.error.name));
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
      const err = new MaldiWorkerError(event.message || "MALDI worker crashed");
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
 * Run an operation in the MALDI worker. Returns the typed result for that op.
 *
 * @example
 *   const { pong } = await callWorker("ping", { echo: "hi" });
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
      reject(new MaldiWorkerError("Operation cancelled", "CancelledError"));
      return;
    }

    const onAbort = () => {
      w.postMessage({ kind: "cancel", id });
      const call = pending.get(id);
      call?.cleanup();
      pending.delete(id);
      reject(new MaldiWorkerError("Operation cancelled", "CancelledError"));
    };

    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      onProgress: options.onProgress,
      cleanup,
    });

    w.postMessage({ kind: "request", id, op, payload });
  });
}

/** Liveness/echo check — confirms the worker is wired and measures round-trip. */
export function ping(echo?: string, options?: CallOptions) {
  return callWorker("ping", { echo }, options);
}

// --- Convenience wrappers, one per compute op (all run in the worker) ---------

export function parse(text: string, parseOptions?: ParseOptions, options?: CallOptions) {
  return callWorker("parse", { text, options: parseOptions }, options);
}

export function process(raw: SpectrumData, steps: ProcessingStep[], options?: CallOptions) {
  return callWorker("process", { raw, steps }, options);
}

export function pickPeaks(spectrum: SpectrumData, params: PeakPickParams, options?: CallOptions) {
  return callWorker("pickPeaks", { spectrum, params }, options);
}

export function flagBackground(peaks: Peak[], flagOptions?: FlagOptions, options?: CallOptions) {
  return callWorker("flagBackground", { peaks, options: flagOptions }, options);
}

export function detectRepeatUnits(
  peaks: Peak[],
  detectOptions?: RepeatDetectOptions,
  options?: CallOptions,
) {
  return callWorker("detectRepeatUnits", { peaks, options: detectOptions }, options);
}

export function assignSeries(
  peaks: Peak[],
  repeatMass: number,
  adducts: Adduct[],
  assignOptions?: AssignOptions,
  options?: CallOptions,
) {
  return callWorker("assignSeries", { peaks, repeatMass, adducts, options: assignOptions }, options);
}

export function kendrick(peaks: Peak[], baseRepeat: number, options?: CallOptions) {
  return callWorker("kendrick", { peaks, baseRepeat }, options);
}

export function solveEndGroups(
  peaks: Peak[],
  repeatMass: number,
  adducts: Adduct[],
  endGroupOptions?: EndGroupOptions,
  options?: CallOptions,
) {
  return callWorker(
    "solveEndGroups",
    { peaks, repeatMass, adducts, options: endGroupOptions },
    options,
  );
}

export function formulaCandidates(
  targetNeutralMass: number,
  candidateOptions?: FormulaCandidateOptions,
  options?: CallOptions,
) {
  return callWorker("formulaCandidates", { targetNeutralMass, options: candidateOptions }, options);
}

export function detectLosses(peaks: Peak[], lossOptions?: LossDetectOptions, options?: CallOptions) {
  return callWorker("detectLosses", { peaks, options: lossOptions }, options);
}

export function detectCopolymer(
  peaks: Peak[],
  adducts: Adduct[],
  copolymerOptions?: CopolymerOptions,
  options?: CallOptions,
) {
  return callWorker("detectCopolymer", { peaks, adducts, options: copolymerOptions }, options);
}

export function parseMs(buffer: ArrayBuffer, fileName: string, options?: CallOptions) {
  return callWorker("parseMs", { buffer, fileName }, options);
}

/** Tear the worker down (e.g. on workspace unmount or for tests). */
export function disposeWorker() {
  worker?.terminate();
  worker = null;
  pending.clear();
}
