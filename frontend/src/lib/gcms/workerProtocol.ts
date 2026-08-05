// GC/MS worker protocol — the typed contract shared by the worker and its client.
//
// This mirrors the MALDI worker's `WorkerOpMap` pattern (see
// `src/lib/maldi/types.ts`): each operation declares its request and result
// types in one place, and both the worker dispatcher and the client are typed
// off that map. It lives in its own module (rather than `types.ts`) so the
// worker-only imports stay out of the main-thread `types.ts` barrel.
//
// The envelope shapes (`WorkerRequestMessage` / `WorkerResponseMessage`) match
// the MALDI worker exactly: `{ kind: "request" | "cancel" | "result" | "error"
// | "progress" }` with `crypto.randomUUID()` correlation ids, a cancelled-id set
// with cooperative cancellation, and a progress channel.

import type { ChromPeak, ChromTrace, MassSpectrum, MsRun } from "./types";
import type { DetectChromPeaksOpts } from "./peaks";

/**
 * Every GC/MS worker operation: `request` is the payload sent in, `result` is
 * what comes back. `ping` is a liveness check; the rest are the compute ops.
 */
export interface WorkerOpMap {
  /** Liveness/echo check — confirms the worker is wired. */
  ping: {
    request: Record<string, never>;
    result: { ok: true };
  };
  /**
   * Parse a single file into an `MsRun`. The worker TRANSFERS the inbound
   * `buffer` (it is detached on the caller side afterwards). Dispatch is by
   * extension AND by signature sniff of the first 64 bytes.
   */
  parseFile: {
    request: { buffer: ArrayBuffer; name: string; sourcePath: string };
    result: { run: MsRun };
  };
  /** Extracted-ion chromatogram. */
  buildXic: {
    request: { run: MsRun; mzList: number[]; tol: number; mode: "sum" | "max" };
    result: { trace: ChromTrace };
  };
  /** One independent, sum-mode extracted-ion chromatogram per requested m/z. */
  buildXics: {
    request: { run: MsRun; mzList: number[]; tol: number };
    result: { traces: ChromTrace[] };
  };
  /** Combine every scan in [rtLo, rtHi] into one spectrum. */
  sumScans: {
    request: {
      run: MsRun;
      rtLo: number;
      rtHi: number;
      mode: "sum" | "mean";
      binTol?: number;
    };
    result: { spectrum: MassSpectrum };
  };
  /** Detect chromatogram peaks. */
  detectChromPeaks: {
    request: { trace: ChromTrace; opts: DetectChromPeaksOpts };
    result: { peaks: ChromPeak[] };
  };
}

export type WorkerOp = keyof WorkerOpMap;
export type WorkerRequestPayload<Op extends WorkerOp> = WorkerOpMap[Op]["request"];
export type WorkerResultPayload<Op extends WorkerOp> = WorkerOpMap[Op]["result"];

/** Client → worker: a correlated request, or a cancellation of a prior id. */
export type WorkerRequestMessage =
  | {
      kind: "request";
      /** Correlation id, unique per in-flight request. */
      id: string;
      op: WorkerOp;
      payload: WorkerRequestPayload<WorkerOp>;
    }
  | { kind: "cancel"; id: string };

/** Worker → client: terminal success/error, or an interim progress tick. */
export type WorkerResponseMessage =
  | { kind: "result"; id: string; result: WorkerResultPayload<WorkerOp> }
  | { kind: "error"; id: string; error: { name: string; message: string } }
  | { kind: "progress"; id: string; progress: number; message?: string };
