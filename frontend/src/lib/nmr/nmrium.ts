import type { NmriumState, Spectrum1DSource } from "@zakodium/nmrium-core";
import { FileCollection } from "file-collection";
import type { Mode, Nucleus, Shift } from "@/types/nmr";
import { deriveSignals } from "./signals";

const DEFAULT_DOMAIN_PPM: Record<string, [number, number]> = {
  "1H": [-1, 12],
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

type NmriumDataState = NonNullable<NmriumState["data"]>;
type NmriumViewState = NonNullable<NmriumState["view"]>;

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

function getSharedDomain(signals: ReturnType<typeof deriveSignals>, nucleus: Nucleus): [number, number] {
  const fallback = DEFAULT_DOMAIN_PPM[nucleus] ?? [0, 200];
  const linePositions = signals.flatMap((signal) => signal.lines.map((line) => line.shift));

  if (linePositions.length === 0) {
    return fallback;
  }

  const minLine = Math.min(...linePositions);
  const maxLine = Math.max(...linePositions);
  const margin = nucleus === "1H" ? 0.9 : 8;

  // Always show the full default range; only expand outward if peaks fall outside it.
  return [
    Math.min(fallback[0], minLine - margin),
    Math.max(fallback[1], maxLine + margin),
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
  intensityScale = 1,
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

  if (intensityScale !== 1) {
    for (let index = 0; index < intensities.length; index += 1) {
      intensities[index] *= intensityScale;
    }
  }

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
  } as unknown as Spectrum1DSource;
}

function groupShiftsBySource(shifts: Shift[]): Array<{ id: string; label: string; shifts: Shift[] }> {
  const grouped = new Map<string, { id: string; label: string; shifts: Shift[] }>();
  for (const shift of shifts) {
    const id = shift.source_id ?? "__default__";
    const label = shift.source_label ?? "Component";
    const bucket = grouped.get(id) ?? { id, label, shifts: [] };
    bucket.shifts.push(shift);
    grouped.set(id, bucket);
  }
  return [...grouped.values()];
}

export function buildNmriumViewerModel(
  shifts: Shift[],
  nucleus: Nucleus,
  mode: Mode,
  version: number,
  options: {
    stackBySource?: boolean;
    intensityScales?: Record<string, number>;
  } = {},
): NmriumViewerModel {
  const aggregator = new FileCollection();
  const schemaVersion = version as 16;
  const emptyCorrelations = {} as NmriumDataState["correlations"];

  if (shifts.length === 0) {
    return {
      aggregator,
      state: {
        version: schemaVersion,
        data: {
          spectra: [],
          molecules: [],
          correlations: emptyCorrelations,
        } as NmriumDataState,
      },
    };
  }

  const allSignals = deriveSignals(shifts, nucleus, mode);
  const sharedDomain = getSharedDomain(allSignals, nucleus);
  const engineColors =
    mode === "individual" ? getEngineColorMap(groupShiftsByEngine(shifts).map(([engine]) => engine)) : {};

  const sources = options.stackBySource ? groupShiftsBySource(shifts) : null;
  const intensityScales = options.intensityScales ?? {};
  const scaleFor = (sourceId?: string) =>
    (sourceId && intensityScales[sourceId] != null ? intensityScales[sourceId] : 1) || 1;

  let spectra: Spectrum1DSource[];
  if (sources && sources.length > 0) {
    spectra = sources.flatMap((source) => {
      const scale = scaleFor(source.id);
      if (mode === "individual") {
        return groupShiftsByEngine(source.shifts).map(([engine, engineShifts]) =>
          createSyntheticSpectrum(
            engineShifts,
            nucleus,
            mode,
            `${source.label} - ${engine}`,
            sharedDomain,
            engineColors[engine],
            scale,
          ),
        );
      }
      return [
        createSyntheticSpectrum(
          source.shifts,
          nucleus,
          mode,
          `${source.label} consensus`,
          sharedDomain,
          "#0f172a",
          scale,
        ),
      ];
    });
  } else {
    const allSourceIds = [
      ...new Set(shifts.map((shift) => shift.source_id).filter(Boolean) as string[]),
    ];
    const uniformScale =
      allSourceIds.length === 1 ? scaleFor(allSourceIds[0]) : 1;
    spectra =
      mode === "individual"
        ? groupShiftsByEngine(shifts).map(([engine, engineShifts]) =>
            createSyntheticSpectrum(
              engineShifts,
              nucleus,
              mode,
              engine,
              sharedDomain,
              engineColors[engine],
              uniformScale,
            ),
          )
        : [
            createSyntheticSpectrum(
              shifts,
              nucleus,
              mode,
              "Consensus prediction",
              sharedDomain,
              "#0f172a",
              uniformScale,
            ),
          ];
  }
  const nmriumSpectra = spectra as unknown as NmriumDataState["spectra"];
  const spectraView = {
    activeTab: nucleus,
    showLegend: false,
  } as unknown as NmriumViewState["spectra"];

  const verticalAlign = options.stackBySource
    ? ({ [nucleus]: "stack" } as unknown as NmriumViewState["verticalAlign"])
    : undefined;

  return {
    aggregator,
    state: {
      version: schemaVersion,
      data: {
        spectra: nmriumSpectra,
        molecules: [],
        correlations: emptyCorrelations,
      } as NmriumDataState,
      view: {
        spectra: spectraView,
        ...(verticalAlign ? { verticalAlign } : {}),
      } as NmriumViewState,
    },
  };
}
