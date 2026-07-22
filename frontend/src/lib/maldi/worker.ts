/// <reference lib="webworker" />
//
// MALDI compute Web Worker — entry point and message dispatcher.
//
// All non-trivial MALDI compute (parsing, baseline/smoothing, peak picking,
// repeat-unit detection, isotope sims) runs here so the main thread stays
// responsive. This file is intentionally just a router: each operation is a
// handler keyed by op name, and the heavy logic lands in sibling modules
// (parse.ts, processing.ts, peaks.ts, …) in later phases.
//
// Instantiated from the client with:
//   new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })

import { flagBackground } from "./library";
import { parseSpectrumText } from "./parse";
import { parseMsFile } from "./parseMs";
import { applyProcessing } from "./processing";
import { pickPeaks } from "./peaks";
import { assignSeries, detectCopolymer, detectRepeatUnits } from "./polymers";
import { solveEndGroups } from "./endgroups";
import { generateFormulaCandidates } from "./formula";
import type {
  WorkerOp,
  WorkerRequestMessage,
  WorkerRequestPayload,
  WorkerResponseMessage,
  WorkerResultPayload,
} from "./types";

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

// Registry of op → handler. Each delegates to a pure compute module; the worker
// itself stays a thin, cancellation-aware dispatcher.
const handlers: { [Op in WorkerOp]: Handler<Op> } = {
  ping: (payload) => ({ pong: true, echo: payload.echo, receivedAt: Date.now() }),
  parse: (payload) => parseSpectrumText(payload.text, payload.options),
  process: (payload) => ({ processed: applyProcessing(payload.raw, payload.steps) }),
  pickPeaks: (payload) => ({ peaks: pickPeaks(payload.spectrum, payload.params) }),
  flagBackground: (payload) => flagBackground(payload.peaks, undefined, payload.options),
  detectRepeatUnits: (payload) => ({
    candidates: detectRepeatUnits(payload.peaks, payload.options),
  }),
  assignSeries: (payload) => ({
    series: assignSeries(payload.peaks, payload.repeatMass, payload.adducts, payload.options),
  }),
  solveEndGroups: (payload) => ({
    candidates: solveEndGroups(
      payload.peaks,
      payload.repeatMass,
      payload.adducts,
      payload.options,
    ),
  }),
  formulaCandidates: (payload) => ({
    candidates: generateFormulaCandidates(payload.targetNeutralMass, payload.options),
  }),
  detectCopolymer: (payload) => ({
    series: detectCopolymer(payload.peaks, payload.adducts, payload.options),
  }),
  parseMs: (payload) => parseMsFile(payload.buffer, payload.fileName),
};

function post(message: WorkerResponseMessage) {
  ctx.postMessage(message);
}

async function dispatch(id: string, op: WorkerOp, payload: WorkerRequestPayload<WorkerOp>) {
  const handlerCtx: HandlerContext = {
    isCancelled: () => cancelled.has(id),
    reportProgress: (progress, message) => post({ kind: "progress", id, progress, message }),
  };

  try {
    const handler = handlers[op] as Handler<WorkerOp> | undefined;
    if (!handler) throw new Error(`Unknown MALDI worker op: ${op}`);
    const result = await handler(payload, handlerCtx);
    if (handlerCtx.isCancelled()) throw new CancelledError();
    post({ kind: "result", id, result });
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
