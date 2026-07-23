import { describe, expect, it } from "vitest";
import { applyBackgroundSubtraction, assemblePanels, resolveSlots } from "../slots";
import type { MsRun, SpectrumSlot } from "../types";

// Minimal synthetic CSR MsRun builder (mirrors chrom.test.ts's `makeRun`).
interface ScanSpec {
  rt: number;
  points: Array<[number, number]>;
}

function makeRun(scans: ScanSpec[]): MsRun {
  const scanCount = scans.length;
  const rtMin = new Float64Array(scanCount);
  const tic = new Float64Array(scanCount);
  const basePeakMz = new Float64Array(scanCount);
  const basePeakIntensity = new Float64Array(scanCount);
  const msLevel = new Uint8Array(scanCount);
  const scanOffset = new Uint32Array(scanCount + 1);
  let total = 0;
  for (const s of scans) total += s.points.length;
  const mz = new Float64Array(total);
  const intensity = new Float32Array(total);
  let cursor = 0;
  for (let i = 0; i < scanCount; i += 1) {
    rtMin[i] = scans[i].rt;
    msLevel[i] = 1;
    scanOffset[i] = cursor;
    let sumTic = 0;
    let bpmz = 0;
    let bpint = -Infinity;
    for (const [m, inten] of scans[i].points) {
      mz[cursor] = m;
      intensity[cursor] = inten;
      sumTic += inten;
      if (inten > bpint) {
        bpint = inten;
        bpmz = m;
      }
      cursor += 1;
    }
    scanOffset[i + 1] = cursor;
    tic[i] = sumTic;
    basePeakMz[i] = bpmz;
    basePeakIntensity[i] = bpint;
  }
  return {
    id: "test-run",
    name: "TEST.D",
    sourcePath: "",
    format: "agilent-ms",
    detector: "ms",
    rtMin,
    tic,
    basePeakMz,
    basePeakIntensity,
    msLevel,
    scanOffset,
    mz,
    intensity,
    scanCount,
    pointCount: total,
    mzRange: total > 0 ? [Math.min(...mz), Math.max(...mz)] : [Infinity, -Infinity],
    rtRange: scanCount > 0 ? [rtMin[0], rtMin[scanCount - 1]] : [Infinity, -Infinity],
    ticRange: [0, 0],
    meta: {},
    warnings: [],
  };
}

function slot(id: string, source: SpectrumSlot["source"], mode: SpectrumSlot["mode"] = "stack"): SpectrumSlot {
  return { id, source, label: id, color: "#000", mode };
}

const run = makeRun([
  { rt: 1.0, points: [[100.0, 10], [200.0, 5]] },
  { rt: 2.0, points: [[100.0, 20], [200.0, 8]] },
  { rt: 3.0, points: [[100.0, 1], [300.0, 40]] },
]);

describe("resolveSlots", () => {
  it("resolves a cursor slot to the nearest scan at cursorRt", () => {
    const slots = [slot("live", { kind: "cursor" })];
    const out = resolveSlots(slots, run, 2.1);
    expect(out.length).toBe(1);
    expect(out[0].spectrum.label).toBe("MS scan 1 · RT 2.000");
  });

  it("omits a cursor slot when cursorRt is null", () => {
    const slots = [slot("live", { kind: "cursor" })];
    expect(resolveSlots(slots, run, null)).toEqual([]);
  });

  it("resolves a scan slot at a fixed rt regardless of cursorRt", () => {
    const slots = [slot("frozen", { kind: "scan", rt: 3.0 })];
    const out = resolveSlots(slots, run, 1.0);
    expect(out[0].spectrum.label).toBe("MS scan 2 · RT 3.000");
  });

  it("resolves a single-region range slot via combineScans", () => {
    const slots = [slot("range1", { kind: "range", regions: [[1.5, 3.5]] })];
    const out = resolveSlots(slots, run, null);
    expect(out.length).toBe(1);
    // Scans at rt 2 and 3 fall in [1.5, 3.5].
    expect(out[0].spectrum.scanCount).toBe(2);
  });

  it("sums multiple regions into one spectrum", () => {
    const slots = [
      slot("range2", {
        kind: "range",
        regions: [
          [0.5, 1.5], // scan at rt 1: mz 100 -> 10, mz 200 -> 5
          [2.5, 3.5], // scan at rt 3: mz 100 -> 1, mz 300 -> 40
        ],
      }),
    ];
    const out = resolveSlots(slots, run, null);
    expect(out.length).toBe(1);
    const spec = out[0].spectrum;
    // mz 100 should be the sum of both regions' mz-100 contributions (10 + 1).
    const idx100 = Array.from(spec.mz).findIndex((m) => Math.abs(m - 100) < 0.01);
    expect(idx100).toBeGreaterThanOrEqual(0);
    expect(spec.intensity[idx100]).toBeCloseTo(11, 6);
    // Multi-region label lists both windows.
    expect(spec.label).toContain("0.50..1.50");
    expect(spec.label).toContain("2.50..3.50");
  });

  it("omits a range slot whose regions match no scans", () => {
    const slots = [slot("empty", { kind: "range", regions: [[100, 200]] })];
    expect(resolveSlots(slots, run, null)).toEqual([]);
  });

  it("returns nothing when the run is null", () => {
    const slots = [slot("live", { kind: "cursor" })];
    expect(resolveSlots(slots, null, 1.0)).toEqual([]);
  });
});

describe("applyBackgroundSubtraction", () => {
  it("subtracts every background slot from every non-background slot, leaving background slots raw", () => {
    const slots = [
      slot("live", { kind: "cursor" }),
      slot("bg", { kind: "scan", rt: 1.0 }, "background"),
    ];
    const resolved = resolveSlots(slots, run, 2.0); // live -> scan at rt 2 (mz100=20, mz200=8)
    const out = applyBackgroundSubtraction(resolved);
    const live = out.find((r) => r.slot.id === "live")!;
    const bg = out.find((r) => r.slot.id === "bg")!;
    // bg spectrum (scan at rt 1: mz100=10, mz200=5) stays unsubtracted.
    expect(Array.from(bg.spectrum.intensity)).toEqual([10, 5]);
    // live (mz100=20, mz200=8) minus bg (mz100=10, mz200=5) -> [10, 3].
    const idx100 = Array.from(live.spectrum.mz).findIndex((m) => Math.abs(m - 100) < 0.01);
    const idx200 = Array.from(live.spectrum.mz).findIndex((m) => Math.abs(m - 200) < 0.01);
    expect(live.spectrum.intensity[idx100]).toBeCloseTo(10, 6);
    expect(live.spectrum.intensity[idx200]).toBeCloseTo(3, 6);
  });

  it("is a no-op when there are no background slots", () => {
    const slots = [slot("live", { kind: "cursor" })];
    const resolved = resolveSlots(slots, run, 2.0);
    expect(applyBackgroundSubtraction(resolved)).toBe(resolved);
  });
});

describe("assemblePanels", () => {
  it("gives stack and background slots their own panel", () => {
    const slots = [
      slot("live", { kind: "cursor" }),
      slot("frozen", { kind: "scan", rt: 3.0 }),
    ];
    const resolved = resolveSlots(slots, run, 1.0);
    const panels = assemblePanels(resolved);
    expect(panels.length).toBe(2);
    expect(panels.map((p) => p.slot.id)).toEqual(["live", "frozen"]);
    expect(panels.every((p) => p.entries.length === 1)).toBe(true);
  });

  it("folds an overlay slot into the preceding panel", () => {
    const slots = [
      slot("live", { kind: "cursor" }),
      slot("ov", { kind: "scan", rt: 3.0 }, "overlay"),
      slot("frozen", { kind: "scan", rt: 1.0 }),
    ];
    const resolved = resolveSlots(slots, run, 2.0);
    const panels = assemblePanels(resolved);
    expect(panels.length).toBe(2);
    expect(panels[0].slot.id).toBe("live");
    expect(panels[0].entries.map((e) => e.slot.id)).toEqual(["live", "ov"]);
    expect(panels[1].slot.id).toBe("frozen");
  });

  it("gives a leading overlay slot its own panel instead of dropping it", () => {
    const slots = [slot("ov", { kind: "scan", rt: 1.0 }, "overlay")];
    const resolved = resolveSlots(slots, run, null);
    const panels = assemblePanels(resolved);
    expect(panels.length).toBe(1);
    expect(panels[0].slot.id).toBe("ov");
  });
});
