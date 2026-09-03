// Unit tests for the cross-run comparison builders: the fixed metric list,
// `metricValue`'s per-key extraction (including the mass `??` vs `||` trap),
// `summarize`'s ddof and non-finite filtering, and the material/run bar
// builders. Mirrors `lib/tga/__tests__/compare.test.ts` closely — inline
// fixtures, no mocking, behavioural sentences.

import { describe, expect, it } from "vitest";
import {
  buildMaterialBars,
  buildRunBars,
  buildSummaryRows,
  dscMetrics,
  metricValue,
  summarize,
} from "../compare";
import type { DscAnalysis, GlassResult, PeakResult, SegmentView } from "../compute";
import type { DscMaterial, DscMetadata, DscSegment } from "../types";
import type { DscRunAnalyzed } from "../store";

const EMPTY_VIEW: SegmentView = {
  tempC: new Float64Array(0),
  heatFlow: new Float64Array(0),
  timeMin: new Float64Array(0),
  reversed: false,
  rateCPerSec: 0,
  normMode: "wattsPerGram",
  segStart: 0,
  segEnd: 0,
  rawTimeMin: new Float64Array(0),
  smoothWindow: 21,
};

const NULL_GLASS: GlassResult = {
  onsetC: null,
  midpointC: null,
  endsetC: null,
  inflectionC: null,
  deltaCp: null,
  preLine: null,
  postLine: null,
  inflLine: null,
};

const NULL_PEAK: PeakResult = {
  peakC: null,
  onsetC: null,
  endsetC: null,
  enthalpyJPerG: null,
  areaMj: null,
  peakHeight: null,
  fwhmC: null,
  baseline: null,
};

function makeAnalysis(overrides: Partial<DscAnalysis> = {}): DscAnalysis {
  return {
    segmentId: "seg1",
    view: EMPTY_VIEW,
    deriv: new Float64Array(0),
    results: {},
    glass: null,
    melt: null,
    crystallization: null,
    coldCrystallization: null,
    cure: null,
    crystallinityPct: null,
    normDivisorMg: null,
    warnings: [],
    ...overrides,
  };
}

const DEFAULT_META: DscMetadata = {
  instrument: "DSC25",
  operator: "",
  sampleName: "sample",
  sampleMassMg: 4.4,
  panMassMg: null,
  pan: "Tzero Aluminum Hermetic",
  methodSteps: [],
  runDate: "",
  gases: "",
  cooler: "",
  cellConstant: "",
  sampleInterval: "",
  exoDirection: "up",
};

const HEAT_2: DscSegment = {
  id: "seg1",
  label: "Ramp 10.00 °C/min to 280.00 °C",
  kind: "heat",
  rateCPerMin: 10,
  ordinal: 2,
  cycle: 2,
  start: 0,
  end: 0,
  tStartC: 0,
  tEndC: 280,
  timeStartMin: 0,
  timeEndMin: 28,
};

/** A minimal analyzed run: no real curve data (compare.ts never reads it),
 *  just the fields `metricValue`/`buildSummaryRows` actually touch. */
function makeRun(
  id: string,
  color: string,
  overrides: {
    meta?: Partial<DscMetadata>;
    massOverrideMg?: number | null;
    analysis?: Partial<DscAnalysis>;
  } = {},
): DscRunAnalyzed {
  return {
    id,
    fileId: "f1",
    fileName: `${id}.tri`,
    label: id,
    color,
    meta: { ...DEFAULT_META, ...overrides.meta },
    segments: [HEAT_2],
    timeMin: new Float64Array(0),
    tempC: new Float64Array(0),
    heatFlowMw: new Float64Array(0),
    scale: 1,
    offset: 0,
    visible: true,
    materialId: null,
    activeSegmentId: null,
    massOverrideMg: overrides.massOverrideMg ?? null,
    polymerFraction: 1,
    referenceId: null,
    features: [],
    analysis: makeAnalysis(overrides.analysis),
  };
}

describe("dscMetrics", () => {
  it("returns the fixed 14-metric list in the specified order", () => {
    const keys = dscMetrics().map((m) => m.key);
    expect(keys).toEqual([
      "tgOnset",
      "tgMid",
      "tgEndset",
      "deltaCp",
      "tm",
      "dHm",
      "tmOnset",
      "tc",
      "dHc",
      "tcc",
      "dHcc",
      "crystallinity",
      "dHcure",
      "massMg",
    ]);
  });

  it("gives every metric a non-empty label, a unit string and integer decimals", () => {
    for (const m of dscMetrics()) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(typeof m.unit).toBe("string");
      expect(Number.isInteger(m.decimals)).toBe(true);
    }
  });
});

describe("metricValue", () => {
  const full = makeRun("A", "#2563eb", {
    massOverrideMg: 5.5,
    analysis: {
      glass: { ...NULL_GLASS, onsetC: 60, midpointC: 65, endsetC: 70, deltaCp: 0.32 },
      melt: { ...NULL_PEAK, peakC: 150, onsetC: 145, endsetC: 155, enthalpyJPerG: -41.2 },
      crystallization: { ...NULL_PEAK, peakC: 110, onsetC: 115, endsetC: 105, enthalpyJPerG: 35.6 },
      coldCrystallization: { ...NULL_PEAK, peakC: 130, onsetC: 125, endsetC: 135, enthalpyJPerG: 12.1 },
      cure: { ...NULL_PEAK, peakC: 180, onsetC: 170, endsetC: 190, enthalpyJPerG: 88.4 },
      crystallinityPct: 28.4,
    },
  });

  it("reads every glass field off the analysis", () => {
    expect(metricValue(full, "tgOnset")).toBe(60);
    expect(metricValue(full, "tgMid")).toBe(65);
    expect(metricValue(full, "tgEndset")).toBe(70);
    expect(metricValue(full, "deltaCp")).toBeCloseTo(0.32, 6);
  });

  it("reads melt, crystallization, cold-crystallization and cure peak fields", () => {
    expect(metricValue(full, "tm")).toBe(150);
    expect(metricValue(full, "dHm")).toBeCloseTo(-41.2, 6); // signed: melt is endothermic (exo-up convention)
    expect(metricValue(full, "tmOnset")).toBe(145);
    expect(metricValue(full, "tc")).toBe(110);
    expect(metricValue(full, "dHc")).toBeCloseTo(35.6, 6);
    expect(metricValue(full, "tcc")).toBe(130);
    expect(metricValue(full, "dHcc")).toBeCloseTo(12.1, 6);
    expect(metricValue(full, "dHcure")).toBeCloseTo(88.4, 6);
  });

  it("reads % crystallinity and the sample mass override", () => {
    expect(metricValue(full, "crystallinity")).toBeCloseTo(28.4, 6);
    expect(metricValue(full, "massMg")).toBe(5.5);
  });

  it("returns NaN for every feature that was never detected", () => {
    const bare = makeRun("B", "#000", { meta: { sampleMassMg: null } });
    for (const key of ["tgOnset", "tgMid", "tgEndset", "deltaCp", "tm", "dHm", "tmOnset", "tc", "dHc", "tcc", "dHcc", "crystallinity", "dHcure", "massMg"]) {
      expect(metricValue(bare, key)).toBeNaN();
    }
  });

  it("falls back to the parsed metadata mass when there is no override", () => {
    const bare = makeRun("B", "#000");
    expect(metricValue(bare, "massMg")).toBeCloseTo(4.4, 6);
  });

  it("keeps a genuine zero mass override rather than falling back to metadata", () => {
    // Pins a `??` vs `||` bug: `0 || meta.sampleMassMg` would wrongly discard
    // an intentional zero override in favour of the parsed metadata (4.4).
    const zeroed = makeRun("C", "#000", { massOverrideMg: 0 });
    expect(metricValue(zeroed, "massMg")).toBe(0);
  });

  it("returns NaN for an unknown key rather than throwing", () => {
    expect(metricValue(full, "nonsense")).toBeNaN();
  });
});

describe("summarize", () => {
  it("returns the mean and the sample SD (ddof = 1)", () => {
    const { mean, sd, n } = summarize([1, 2, 3]);
    expect(mean).toBeCloseTo(2, 10);
    expect(sd).toBeCloseTo(1, 10); // sample SD of [1,2,3]: sqrt(2/(3-1)) = 1
    expect(n).toBe(3);
  });

  it("has no SD for a single value (n < 2)", () => {
    const r = summarize([4]);
    expect(r.mean).toBe(4);
    expect(r.sd).toBeNaN();
    expect(r.n).toBe(1);
  });

  it("reports NaN mean/sd and n=0 for an empty or all-non-finite input", () => {
    expect(summarize([])).toEqual({ mean: NaN, sd: NaN, n: 0 });
    expect(summarize([NaN, Infinity, -Infinity])).toEqual({ mean: NaN, sd: NaN, n: 0 });
  });

  it("ignores non-finite values rather than propagating NaN through the mean", () => {
    // A single stray NaN (e.g. an undetected feature on one replicate) must
    // not poison the whole material's mean.
    const { mean, n } = summarize([1, NaN, 3]);
    expect(n).toBe(2);
    expect(mean).toBeCloseTo(2, 10);
  });
});

describe("buildSummaryRows", () => {
  it("names each run's material and segment and fills every metric column", () => {
    const a = makeRun("A", "#2563eb", { analysis: { glass: { ...NULL_GLASS, onsetC: 60 } } });
    const b = makeRun("B", "#dc2626", { analysis: { glass: { ...NULL_GLASS, onsetC: 58 } } });
    const materials: DscMaterial[] = [{ id: "m1", name: "Blend 1", runIds: ["A", "B"] }];
    const metrics = dscMetrics();
    const rows = buildSummaryRows([a, b], materials, metrics);
    expect(rows).toHaveLength(2);
    expect(rows[0].materialName).toBe("Blend 1");
    expect(rows[0].segmentLabel).toBe("Ramp 10.00 °C/min to 280.00 °C");
    for (const m of metrics) expect(rows[0].values).toHaveProperty(m.key);
    expect(rows[0].values.tgOnset).toBe(60);
  });

  it("shows an em dash placeholder material for an ungrouped run", () => {
    const rows = buildSummaryRows([makeRun("A", "#000")], [], dscMetrics());
    expect(rows[0].materialName).toBe("—");
  });
});

describe("buildMaterialBars", () => {
  const a = makeRun("A", "#2563eb", { analysis: { cure: { ...NULL_PEAK, enthalpyJPerG: 60 } } });
  const b = makeRun("B", "#dc2626", { analysis: { cure: { ...NULL_PEAK, enthalpyJPerG: 40 } } });

  it("averages the metric over a material's member runs", () => {
    const materials: DscMaterial[] = [{ id: "m1", name: "Blend", runIds: ["A", "B"] }];
    const bars = buildMaterialBars([a, b], materials, "dHcure");
    expect(bars).toHaveLength(1);
    expect(bars[0].n).toBe(2);
    expect(bars[0].mean).toBeCloseTo(50, 3); // (60 + 40) / 2
    expect(bars[0].sd).toBeGreaterThan(0);
    expect(bars[0].color).toBe("#2563eb"); // the first member's colour
  });

  it("drops a material whose runs are all gone", () => {
    const materials: DscMaterial[] = [{ id: "m1", name: "Ghost", runIds: ["missing"] }];
    expect(buildMaterialBars([a], materials, "dHcure")).toEqual([]);
  });

  it("drops a material whose runs never detected the metric", () => {
    // Every member's value is NaN (no cure peak) — the bar must be omitted
    // rather than plotted as a mean-of-nothing.
    const noCure = makeRun("C", "#16a34a");
    const materials: DscMaterial[] = [{ id: "m2", name: "No cure", runIds: ["C"] }];
    expect(buildMaterialBars([noCure], materials, "dHcure")).toEqual([]);
  });
});

describe("buildRunBars", () => {
  it("emits one zero-spread bar per run and skips runs with no value", () => {
    const a = makeRun("A", "#2563eb", { analysis: { cure: { ...NULL_PEAK, enthalpyJPerG: 60 } } });
    const bars = buildRunBars([a], "dHcure");
    expect(bars).toHaveLength(1);
    expect(bars[0].sd).toBe(0);
    expect(bars[0].n).toBe(1);
    expect(buildRunBars([a], "tgOnset")).toEqual([]); // no glass feature on this run
  });
});
