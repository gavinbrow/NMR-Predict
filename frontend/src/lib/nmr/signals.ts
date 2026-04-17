import type { Mode, Nucleus, Shift } from "@/types/nmr";

export interface DerivedSignalLine {
  shift: number;
  intensity: number;
}

export interface DerivedSignal {
  id: string;
  engine?: string;
  sourceId?: string;
  sourceLabel?: string;
  sourceSmiles?: string;
  center: number;
  atomIndices: number[];
  representativeAtomIndex: number;
  element?: string;
  attachedAtomIndex?: number;
  integration?: number;
  multiplicity?: string;
  couplingHz?: number;
  neighborCount?: number;
  std?: number;
  assignmentText: string;
  lines: DerivedSignalLine[];
}

type SignalSelectionTarget = Pick<DerivedSignal, "atomIndices" | "attachedAtomIndex">;

type MutableSignal = {
  id: string;
  engine?: string;
  sourceId?: string;
  sourceLabel?: string;
  sourceSmiles?: string;
  center: number;
  atomIndices: number[];
  representativeAtomIndex: number;
  element?: string;
  attachedAtomIndex?: number;
  multiplicities: string[];
  couplingValues: number[];
  neighborCounts: number[];
  stdValues: number[];
  lines: DerivedSignalLine[];
};

const GROUP_TOLERANCE_PPM: Record<string, number> = {
  "1H": 0.14,
  "13C": 0.8,
  "15N": 1.2,
  "19F": 0.8,
  "31P": 0.8,
};

const MULTIPLET_PATTERNS: Record<string, number[]> = {
  s: [1],
  d: [1, 1],
  t: [1, 2, 1],
  q: [1, 3, 3, 1],
  quint: [1, 4, 6, 4, 1],
  sext: [1, 5, 10, 10, 5, 1],
  sept: [1, 6, 15, 20, 15, 6, 1],
  m: [1, 2, 3, 2, 1],
};

function average(values: number[]) {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rangeText(indices: number[], prefix: string) {
  if (indices.length === 0) return "";
  const sorted = [...indices].sort((a, b) => a - b);
  const segments: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    segments.push(start === prev ? `${prefix}${start}` : `${prefix}${start}-${prefix}${prev}`);
    start = current;
    prev = current;
  }

  segments.push(start === prev ? `${prefix}${start}` : `${prefix}${start}-${prefix}${prev}`);
  return segments.join(", ");
}

function primaryMultiplicity(values: string[]) {
  if (values.length === 0) return undefined;
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function ppmSpacing(nucleus: Nucleus, couplingHz?: number) {
  if (nucleus !== "1H") return 0;
  return (couplingHz ?? 7) / 400;
}

function lineHeightScale(nucleus: Nucleus, integration?: number) {
  if (nucleus !== "1H") return 1;
  return 0.8 + Math.min(0.45, ((integration ?? 1) - 1) * 0.12);
}

function displayLinesForSignal(
  nucleus: Nucleus,
  center: number,
  multiplicity: string | undefined,
  couplingHz: number | undefined,
  integration: number | undefined,
): DerivedSignalLine[] {
  const baseHeight = lineHeightScale(nucleus, integration);
  if (nucleus !== "1H") {
    return [{ shift: center, intensity: baseHeight }];
  }

  const pattern = MULTIPLET_PATTERNS[multiplicity ?? "s"] ?? MULTIPLET_PATTERNS.m;
  const spacing = ppmSpacing(nucleus, couplingHz) || 0.016;
  const midpoint = (pattern.length - 1) / 2;
  const maxCoeff = Math.max(...pattern);

  return pattern.map((coefficient, index) => ({
    shift: center + (index - midpoint) * spacing,
    intensity: baseHeight * (coefficient / maxCoeff),
  }));
}

function signalAssignment(signal: MutableSignal, nucleus: Nucleus) {
  if (nucleus === "1H") {
    const protonText = rangeText(signal.atomIndices, "H");
    if (signal.attachedAtomIndex != null) {
      return `${protonText} on atom #${signal.attachedAtomIndex}`;
    }
    return protonText;
  }

  const prefix = signal.element ?? "atom";
  return `${prefix} #${signal.representativeAtomIndex}`;
}

export function signalSelectionAtomIndices(
  signal: SignalSelectionTarget,
  nucleus: Nucleus,
): number[] {
  if (nucleus === "1H" && signal.attachedAtomIndex != null) {
    return [signal.attachedAtomIndex];
  }

  return [...new Set(signal.atomIndices)].sort((a, b) => a - b);
}

export function describeSplitting(signal: DerivedSignal): string | undefined {
  const label = multiplicityLabel(signal.multiplicity);
  if (!label) return undefined;

  const parts: string[] = [];
  const neighbors = signal.neighborCount;
  if (typeof neighbors === "number" && neighbors > 0) {
    const rounded = Math.round(neighbors);
    parts.push(`${rounded} neighbor${rounded === 1 ? "" : "s"} (n+1 = ${rounded + 1} lines)`);
  } else if (signal.multiplicity === "s") {
    parts.push("no 1H neighbors");
  }

  if (signal.couplingHz != null) {
    parts.push(`J ≈ ${signal.couplingHz.toFixed(1)} Hz`);
  } else if (signal.multiplicity === "m") {
    parts.push("complex pattern (unresolved)");
  }

  if (parts.length === 0) return undefined;
  return `${label}: ${parts.join(" · ")}`;
}

export function multiplicityLabel(multiplicity?: string) {
  switch (multiplicity) {
    case "s":
      return "singlet";
    case "d":
      return "doublet";
    case "t":
      return "triplet";
    case "q":
      return "quartet";
    case "quint":
      return "quintet";
    case "sext":
      return "sextet";
    case "sept":
      return "septet";
    case "m":
      return "multiplet";
    default:
      return undefined;
  }
}

export function deriveSignals(shifts: Shift[], nucleus: Nucleus, mode: Mode): DerivedSignal[] {
  if (shifts.length === 0) return [];

  const tolerance = GROUP_TOLERANCE_PPM[nucleus] ?? 0.25;
  const grouped = new Map<string, MutableSignal[]>();

  const sorted = [...shifts].sort((a, b) => {
    const engineA = mode === "individual" ? a.engine ?? "" : "";
    const engineB = mode === "individual" ? b.engine ?? "" : "";
    if (engineA !== engineB) return engineA.localeCompare(engineB);
    const sourceA = a.source_id ?? "";
    const sourceB = b.source_id ?? "";
    if (sourceA !== sourceB) return sourceA.localeCompare(sourceB);
    return b.shift - a.shift;
  });

  sorted.forEach((shift) => {
    const engineKey = mode === "individual" ? (shift.engine ?? "engine") : "consensus";
    const sourceKey = shift.source_id ?? "default";
    const baseKey =
      nucleus === "1H"
        ? `${sourceKey}:${engineKey}:${shift.assignment_group ?? `atom:${shift.atom_index}`}`
        : `${sourceKey}:${engineKey}:atom:${shift.atom_index}`;

    const bucket = grouped.get(baseKey) ?? [];
    const candidate =
      nucleus === "1H"
        ? [...bucket].reverse().find((group) => Math.abs(group.center - shift.shift) <= tolerance)
        : bucket[0];

    if (candidate) {
      if (!candidate.atomIndices.includes(shift.atom_index)) {
        candidate.atomIndices.push(shift.atom_index);
      }
      candidate.center =
        (candidate.center * (candidate.atomIndices.length - 1) + shift.shift) /
        candidate.atomIndices.length;
      if (shift.multiplicity) candidate.multiplicities.push(shift.multiplicity);
      if (shift.coupling_hz != null) candidate.couplingValues.push(shift.coupling_hz);
      if (shift.neighbor_count != null) candidate.neighborCounts.push(shift.neighbor_count);
      if (shift.std != null) candidate.stdValues.push(shift.std);
    } else {
      bucket.push({
        id: `${baseKey}:${bucket.length}`,
        engine: mode === "individual" ? shift.engine : undefined,
        sourceId: shift.source_id,
        sourceLabel: shift.source_label,
        sourceSmiles: shift.source_smiles,
        center: shift.shift,
        atomIndices: [shift.atom_index],
        representativeAtomIndex: shift.atom_index,
        element: shift.element,
        attachedAtomIndex: shift.attached_atom_index,
        multiplicities: shift.multiplicity ? [shift.multiplicity] : [],
        couplingValues: shift.coupling_hz != null ? [shift.coupling_hz] : [],
        neighborCounts: shift.neighbor_count != null ? [shift.neighbor_count] : [],
        stdValues: shift.std != null ? [shift.std] : [],
        lines: [],
      });
      grouped.set(baseKey, bucket);
    }
  });

  const signals = [...grouped.values()]
    .flat()
    .map((group) => {
      const integration = nucleus === "1H" ? group.atomIndices.length : undefined;
      const multiplicity = primaryMultiplicity(group.multiplicities);
      const couplingHz = average(group.couplingValues);
      const std = average(group.stdValues);

      return {
        id: group.id,
        engine: group.engine,
        sourceId: group.sourceId,
        sourceLabel: group.sourceLabel,
        sourceSmiles: group.sourceSmiles,
        center: group.center,
        atomIndices: [...group.atomIndices].sort((a, b) => a - b),
        representativeAtomIndex: group.representativeAtomIndex,
        element: group.element,
        attachedAtomIndex: group.attachedAtomIndex,
        integration,
        multiplicity,
        couplingHz,
        neighborCount: average(group.neighborCounts),
        std,
        assignmentText: signalAssignment(group, nucleus),
        lines: displayLinesForSignal(nucleus, group.center, multiplicity, couplingHz, integration),
      } satisfies DerivedSignal;
    })
    .sort((a, b) => b.center - a.center);

  return signals;
}

export function buildIntegralCurve(signals: DerivedSignal[], range: [number, number]) {
  const protonSignals = signals.filter((signal) => typeof signal.integration === "number");
  if (protonSignals.length === 0) return null;

  const total = protonSignals.reduce((sum, signal) => sum + (signal.integration ?? 0), 0);
  if (total <= 0) return null;

  const baseline = 0.08;
  const amplitude = 0.28;
  const shoulder = 0.14;
  const x: number[] = [range[1]];
  const y: number[] = [baseline];
  let current = baseline;

  protonSignals
    .slice()
    .sort((a, b) => b.center - a.center)
    .forEach((signal) => {
      const left = Math.min(range[1], signal.center + shoulder);
      const right = Math.max(range[0], signal.center - shoulder);
      x.push(left, signal.center);
      y.push(current, current);
      current += ((signal.integration ?? 0) / total) * amplitude;
      x.push(signal.center, right);
      y.push(current, current);
    });

  x.push(range[0]);
  y.push(current);
  return { x, y };
}
