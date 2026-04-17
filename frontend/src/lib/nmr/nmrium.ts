import type { NmriumState, Spectrum1DSource } from "@zakodium/nmrium-core";
import { FileCollection } from "file-collection";
import type { Mode, Nucleus, Shift } from "@/types/nmr";
import { deriveSignals } from "./signals";

const DEFAULT_DOMAIN_PPM: Record<string, [number, number]> = {
  "1H": [0, 12],
  "13C": [0, 220],
  "15N": [-50, 450],
  "19F": [-260, 80],
  "31P": [-80, 280],
};

const BASE_FREQUENCY_MHZ: Record<string, number> = {
  "1H": 400.13,
  "13C": 100.61,
  "15N": 40.56,
  "19F": 376.5,
  "31P": 161.98,
};

// FWHM of each Lorentzian line in ppm. Picked so that multiplet components
// separated by a typical J coupling (7 Hz = 0.0175 ppm at 400 MHz for 1H)
// resolve instead of blurring into a single hump.
const LINE_WIDTH_PPM: Record<string, number> = {
  "1H": 0.004,
  "13C": 0.05,
  "15N": 0.18,
  "19F": 0.02,
  "31P": 0.05,
};

const SAMPLE_POINTS: Record<string, number> = {
  "1H": 32768,
  "13C": 8192,
  "15N": 8192,
  "19F": 8192,
  "31P": 8192,
};

type SyntheticSpectrumData = {
  x: Float64Array;
  re: Float64Array;
};

export type NmriumViewerModel = {
  aggregator: FileCollection;
  state: Partial<NmriumState>;
};

const ENGINE_COLOR_HINTS: Array<{ match: RegExp; color: string }> = [
  { match: /cdk/i, color: "#0ea5e9" },
  { match: /cascade/i, color: "#10b981" },
  { match: /orca/i, color: "#f97316" },
];

const FALLBACK_ENGINE_COLORS = [
  "#0ea5e9",
  "#10b981",
  "#f97316",
  "#a855f7",
  "#ef4444",
  "#f59e0b",
];

export function getEngineColorMap(engines: string[]) {
  const unique = engines.filter((engine, index) => engines.indexOf(engine) === index);
  const used = new Set<string>();

  return unique.reduce<Record<string, string>>((colors, engine, index) => {
    const hinted = ENGINE_COLOR_HINTS.find((entry) => entry.match.test(engine))?.color;
    const fallback =
      FALLBACK_ENGINE_COLORS.find((color) => !used.has(color)) ??
      FALLBACK_ENGINE_COLORS[index % FALLBACK_ENGINE_COLORS.length];
    const color = hinted ?? fallback;
    used.add(color);
    colors[engine] = color;
    return colors;
  }, {});
}

function groupShiftsByEngine(shifts: Shift[]) {
  const grouped = new Map<string, Shift[]>();

  for (const shift of shifts) {
    const engine = shift.engine ?? "engine";
    const bucket = grouped.get(engine) ?? [];
    bucket.push(shift);
    grouped.set(engine, bucket);
  }

  return [...grouped.entries()];
}

function clamp(value: number, lower: number, upper: number) {
  return Math.min(upper, Math.max(lower, value));
}

function getSharedDomain(signals: ReturnType<typeof deriveSignals>, nucleus: Nucleus): [number, number] {
  const fallback = DEFAULT_DOMAIN_PPM[nucleus] ?? [0, 200];
  const linePositions = signals.flatMap((signal) => signal.lines.map((line) => line.shift));

  if (linePositions.length === 0) {
    return fallback;
  }

  const minLine = Math.min(...linePositions);
  const maxLine = Math.max(...linePositions);
  const margin = nucleus === "1H" ? 0.9 : 8;

  return [
    clamp(minLine - margin, fallback[0], fallback[1]),
    clamp(maxLine + margin, fallback[0], fallback[1]),
  ];
}

function makeAxis(domain: [number, number], points: number) {
  const [min, max] = domain;
  const axis = new Float64Array(points);
  const step = (max - min) / Math.max(1, points - 1);

  // NMRIUM's line renderer runs the trace through xyReduce, which binary-searches
  // data.x assuming ascending order. Emit ppm low->high; the viewer flips to RTL.
  for (let index = 0; index < points; index += 1) {
    axis[index] = min + index * step;
  }

  return axis;
}

function addLorentzianLine(
  axis: Float64Array,
  output: Float64Array,
  center: number,
  amplitude: number,
  width: number,
) {
  const gamma = width / 2;
  const gammaSquared = gamma * gamma;

  for (let index = 0; index < axis.length; index += 1) {
    const delta = axis[index] - center;
    output[index] += amplitude * (gammaSquared / (delta * delta + gammaSquared));
  }
}

function normalizeTrace(trace: Float64Array) {
  let maxValue = 0;

  for (const value of trace) {
    if (value > maxValue) {
      maxValue = value;
    }
  }

  if (maxValue <= 0) {
    return trace;
  }

  for (let index = 0; index < trace.length; index += 1) {
    trace[index] /= maxValue;
  }

  return trace;
}

function createSyntheticSpectrum(
  shifts: Shift[],
  nucleus: Nucleus,
  mode: Mode,
  title: string,
  sharedDomain: [number, number],
  color?: string,
): Spectrum1DSource {
  const signals = deriveSignals(shifts, nucleus, mode);
  const points = SAMPLE_POINTS[nucleus] ?? 4096;
  const lineWidth = LINE_WIDTH_PPM[nucleus] ?? 0.12;
  const axis = makeAxis(sharedDomain, points);
  const intensities = new Float64Array(points);

  for (const signal of signals) {
    const signalWidth = signal.std != null ? Math.max(lineWidth, lineWidth + signal.std * 0.35) : lineWidth;

    for (const line of signal.lines) {
      addLorentzianLine(axis, intensities, line.shift, line.intensity, signalWidth);
    }
  }

  normalizeTrace(intensities);

  const frequency = BASE_FREQUENCY_MHZ[nucleus] ?? 100;
  const first = axis[0] ?? sharedDomain[1];
  const last = axis[axis.length - 1] ?? sharedDomain[0];
  const frequencyOffset = ((first + last) * frequency) / 2;

  return {
    id: crypto.randomUUID(),
    data: { x: axis, re: intensities } satisfies SyntheticSpectrumData,
    display: { name: title, color },
    info: {
      name: title,
      title,
      nucleus,
      dimension: 1,
      isFid: false,
      isComplex: false,
      experiment: nucleus === "1H" ? "proton" : "carbon",
      baseFrequency: frequency,
      originFrequency: frequency,
      frequencyOffset,
      observeFrequency: frequency,
      spectralWidth: sharedDomain[1] - sharedDomain[0],
      solvent: "Predicted",
      pulseSequence: "prediction",
      isFt: true,
    },
    meta: {
      source: "nmr-predict",
      synthetic: true,
    },
    customInfo: {},
    filters: [],
  } as Spectrum1DSource;
}

export function buildNmriumViewerModel(
  shifts: Shift[],
  nucleus: Nucleus,
  mode: Mode,
  version: number,
): NmriumViewerModel {
  const aggregator = new FileCollection();

  if (shifts.length === 0) {
    return {
      aggregator,
      state: {
        version,
        data: {
          spectra: [],
          molecules: [],
          correlations: {},
        },
      },
    };
  }

  const allSignals = deriveSignals(shifts, nucleus, mode);
  const sharedDomain = getSharedDomain(allSignals, nucleus);
  const engineColors =
    mode === "individual" ? getEngineColorMap(groupShiftsByEngine(shifts).map(([engine]) => engine)) : {};
  const spectra =
    mode === "individual"
      ? groupShiftsByEngine(shifts).map(([engine, engineShifts]) =>
          createSyntheticSpectrum(
            engineShifts,
            nucleus,
            mode,
            engine,
            sharedDomain,
            engineColors[engine],
          ),
        )
      : [createSyntheticSpectrum(shifts, nucleus, mode, "Consensus prediction", sharedDomain, "#0f172a")];

  return {
    aggregator,
    state: {
      version,
      data: {
        spectra,
        molecules: [],
        correlations: {},
      },
      view: {
        spectra: {
          activeTab: nucleus,
          showLegend: false,
        },
      },
    },
  };
}
