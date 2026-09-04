// Real-fixture regression tests for the DSC auto-detection engine
// (`autoDetectFeatures` / `classifyStepCandidate` in `compute.ts`), mirroring
// `parse.realfile.test.ts`'s skip-if-absent pattern. The fixtures live in
// `DSC Examples/` at the repo root; when they are absent the whole describe
// block is skipped.
//
// This file exists because the bug these tests pin only shows up on REAL
// data: a synthetic tanh step (see `compute.test.ts`'s `COMBINED`/
// `TWO_SLOPE_STEP` fixtures) can be built either way, but the actual failure
// mode -- `detectPeakCandidates`' global baseline swallowing a real Tg whole,
// and the two follow-up bugs the step-vs-peak discriminator's guards catch
// (ramp-start/end thermal lag misread as a step; a cure-exotherm's flank
// misread as one) -- was found and is best verified against the genuine
// instrument files.
//
// The four fixtures are ~7.9 MB each. Parsing is pure (nothing below ever
// mutates a returned `DscRun`), so `runFor` below parses each file AT MOST
// ONCE per test run and caches the result -- the two sweep tests each touch
// all four files and would otherwise re-parse ones the single-file tests
// above them already paid for. This is also why the sweep tests still carry
// an explicit generous `it(...)` timeout: a cold cache (whichever test runs
// first) still has to parse up to four 7.9 MB files in one go, comfortably
// past the default 5 s vitest test timeout.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTriosTri } from "../parse/triosTri";
import { buildFromParsed } from "../store-core";
import { autoDetectFeatures, glassTransition, segmentView } from "../compute";
import { DEFAULT_PARAMS } from "../types";
import type { DscRun } from "../types";

const ROOT = resolve(__dirname, "../../../../../");
const DIR = resolve(ROOT, "DSC Examples");
const present = existsSync(DIR);

function readAb(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Lazy per-file parse cache, keyed by filename -- see the file header. Every
 *  caller gets the SAME `DscRun` object back; safe only because
 *  `segmentView`/`autoDetectFeatures`/`glassTransition` are pure readers that
 *  never mutate their `run` argument. */
const runCache = new Map<string, DscRun>();
function runFor(fname: string): DscRun {
  const cached = runCache.get(fname);
  if (cached) return cached;
  const parsed = parseTriosTri(readAb(resolve(DIR, fname)), fname);
  const run = buildFromParsed(parsed).runs[0];
  runCache.set(fname, run);
  return run;
}

/** `max(10, 5% * span)`, matching `compute.ts`'s own `STEP_EDGE_MARGIN_MIN_C`/
 *  `STEP_EDGE_MARGIN_FRACTION` -- kept as a literal duplicate here rather than
 *  imported (both constants are module-private) so this test independently
 *  re-derives the margin instead of trusting the same constant it is
 *  checking against. */
function edgeMarginC(tempLo: number, tempHi: number): number {
  return Math.max(10, 0.05 * (tempHi - tempLo));
}

/** Matches `compute.ts`'s own module-private `MAX_PEAK_SPAN_FRACTION` --
 *  kept as a literal duplicate here for the same reason as `edgeMarginC`
 *  above: this test re-derives the gate rather than trusting the constant
 *  it exists to check. */
const MAX_PEAK_SPAN_FRACTION = 0.75;

/** Generous headroom above the ~5-6 s a cold-cache four-file sweep actually
 *  takes locally (`runFor`'s doc comment) -- a slower CI machine parsing all
 *  four 7.9 MB fixtures from scratch should still clear this comfortably. */
const SWEEP_TIMEOUT_MS = 30_000;

describe.skipIf(!present)("DSC auto-detection on real files", () => {
  it("DAC1.tri segment 2 (2nd heat): auto-detects glass with midpoint 66-70 C, no full-span melt", () => {
    const run = runFor("DAC1.tri");
    const seg = run.segments[2];
    expect(seg.kind).toBe("heat");
    const view = segmentView(run, seg, DEFAULT_PARAMS);
    const features = autoDetectFeatures(view, seg, DEFAULT_PARAMS);

    // The bug this pins: before the step-vs-peak discriminator, this
    // segment's entire ramp was reported as a single "Melt" spanning
    // [1.1, 253.1] C with a bogus dH of -207.6 J/g -- a glass transition
    // read as a melt because `detectPeakCandidates`' global baseline
    // absorbed the whole step.
    expect(features.some((f) => f.kind === "melt")).toBe(false);
    const glass = features.find((f) => f.kind === "glass");
    expect(glass).toBeDefined();
    const g = glassTransition(view, glass!.window);
    expect(g.midpointC).not.toBeNull();
    expect(g.midpointC!).toBeGreaterThan(66);
    expect(g.midpointC!).toBeLessThan(70);
  });

  it("DAC3.tri segment 2 (2nd heat): auto-detects glass with midpoint 30-45 C, no full-span melt", () => {
    const run = runFor("DAC3.tri");
    const seg = run.segments[2];
    expect(seg.kind).toBe("heat");
    const view = segmentView(run, seg, DEFAULT_PARAMS);
    const features = autoDetectFeatures(view, seg, DEFAULT_PARAMS);

    expect(features.some((f) => f.kind === "melt")).toBe(false);
    const glass = features.find((f) => f.kind === "glass");
    expect(glass).toBeDefined();
    const g = glassTransition(view, glass!.window);
    expect(g.midpointC).not.toBeNull();
    expect(g.midpointC!).toBeGreaterThan(30);
    expect(g.midpointC!).toBeLessThan(45);
  });

  // The bug this pins: a DSC ramp's start (and, on a cooling segment whose
  // ascending `SegmentView` is reversed, its acquisition END) is instrument
  // thermal lag settling into rate, not a transition. Before
  // `isNearSegmentTempEdge` existed, EVERY cooling segment in this fixture
  // set reported a bogus "glass" with midpoint ~277.7 C (the ramp's
  // acquisition start at 280 C, landing at the HIGH-temperature end of the
  // ascending view), and `DAC2.tri`/`1-2 S1.tri`'s 2nd heats each reported
  // one at ~2-3 C (the ramp-start artifact) -- neither is a real Tg.
  it(
    "never auto-detects a glass feature whose midpoint falls within the ramp-start/end temperature margin, on any segment of any real file",
    () => {
      const files = ["DAC1.tri", "DAC2.tri", "DAC3.tri", "1-2 S1.tri"];
      let checked = 0;
      for (const fname of files) {
        const run = runFor(fname);
        for (const seg of run.segments) {
          const view = segmentView(run, seg, DEFAULT_PARAMS);
          if (view.tempC.length < 10) continue;
          const features = autoDetectFeatures(view, seg, DEFAULT_PARAMS);
          const glass = features.find((f) => f.kind === "glass");
          if (!glass) continue;
          const g = glassTransition(view, glass.window);
          if (g.midpointC == null) continue;
          checked += 1;
          const tempLo = view.tempC[0];
          const tempHi = view.tempC[view.tempC.length - 1];
          const margin = edgeMarginC(tempLo, tempHi);
          expect(g.midpointC).toBeGreaterThanOrEqual(tempLo + margin);
          expect(g.midpointC).toBeLessThanOrEqual(tempHi - margin);
        }
      }
      // Sanity: the sweep actually exercised at least one real glass
      // detection (DAC1/DAC3 segment 2, at minimum) rather than vacuously
      // passing because nothing was ever found.
      expect(checked).toBeGreaterThan(0);
    },
    SWEEP_TIMEOUT_MS,
  );

  // The bug this pins: before the full-span gate (`MAX_PEAK_SPAN_FRACTION` in
  // `compute.ts`) existed, a straight two-point global baseline could not
  // represent a gently-curved real DSC baseline, so every COOL segment in
  // this fixture set reported a bogus "crystallization" spanning 87-97% of
  // its ramp, and several HEAT segments (whose real Tg the step-vs-peak
  // discriminator had not yet claimed) reported a bogus "melt" spanning
  // 77-91% -- e.g. DAC2.tri's 2nd heat read as melt[1.1, 249.7] on a
  // 277.9 C-wide segment (approx 89%). None of them were real transitions.
  it(
    "no auto-detected feature's window ever covers more than 75% of its own segment's temperature span, on any segment of any real file",
    () => {
      const files = ["DAC1.tri", "DAC2.tri", "DAC3.tri", "1-2 S1.tri"];
      let checked = 0;
      for (const fname of files) {
        const run = runFor(fname);
        for (const seg of run.segments) {
          const view = segmentView(run, seg, DEFAULT_PARAMS);
          if (view.tempC.length < 10) continue;
          const features = autoDetectFeatures(view, seg, DEFAULT_PARAMS);
          const tempLo = view.tempC[0];
          const tempHi = view.tempC[view.tempC.length - 1];
          const segSpanC = Math.abs(tempHi - tempLo);
          for (const f of features) {
            checked += 1;
            const windowSpanC = Math.abs(f.window[1] - f.window[0]);
            expect(windowSpanC).toBeLessThanOrEqual(MAX_PEAK_SPAN_FRACTION * segSpanC);
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    },
    SWEEP_TIMEOUT_MS,
  );
});
