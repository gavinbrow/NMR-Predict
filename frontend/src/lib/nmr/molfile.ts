export interface MolAtom {
  index: number;
  element: string;
  x: number;
  y: number;
  charge: number;
}

export interface MolBond {
  from: number;
  to: number;
  order: number;
  stereo: number;
}

export interface ParsedMol {
  atoms: MolAtom[];
  bonds: MolBond[];
}

const CHARGE_CODE: Record<number, number> = {
  1: 3,
  2: 2,
  3: 1,
  5: -1,
  6: -2,
  7: -3,
};

const HETERO_LABEL_ELEMENTS = new Set(["B", "N", "O", "P", "S", "Se"]);

export function parseMolfile(molfile: string): ParsedMol | null {
  const lines = molfile.split(/\r?\n/);
  if (lines.length < 4) return null;

  const counts = lines[3];
  const atomCount = Number.parseInt(counts.slice(0, 3).trim(), 10);
  const bondCount = Number.parseInt(counts.slice(3, 6).trim(), 10);
  if (!Number.isFinite(atomCount) || !Number.isFinite(bondCount)) return null;

  const atoms: MolAtom[] = [];
  for (let i = 0; i < atomCount; i += 1) {
    const line = lines[4 + i] ?? "";
    const x = Number.parseFloat(line.slice(0, 10));
    const y = Number.parseFloat(line.slice(10, 20));
    const element = line.slice(31, 34).trim();
    const chargeCode = Number.parseInt(line.slice(36, 39).trim(), 10);
    const charge = CHARGE_CODE[chargeCode] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !element) continue;
    atoms.push({ index: i, element, x, y, charge });
  }

  const bonds: MolBond[] = [];
  for (let i = 0; i < bondCount; i += 1) {
    const line = lines[4 + atomCount + i] ?? "";
    const from = Number.parseInt(line.slice(0, 3).trim(), 10) - 1;
    const to = Number.parseInt(line.slice(3, 6).trim(), 10) - 1;
    const order = Number.parseInt(line.slice(6, 9).trim(), 10) || 1;
    const stereo = Number.parseInt(line.slice(9, 12).trim(), 10) || 0;
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    bonds.push({ from, to, order, stereo });
  }

  for (const line of lines.slice(4 + atomCount + bondCount)) {
    if (!line.startsWith("M  CHG")) continue;
    const parts = line.trim().split(/\s+/);
    const count = Number.parseInt(parts[2] ?? "0", 10);
    for (let i = 0; i < count; i += 1) {
      const atomIndex = Number.parseInt(parts[3 + i * 2] ?? "", 10) - 1;
      const charge = Number.parseInt(parts[4 + i * 2] ?? "", 10);
      const atom = atoms.find((candidate) => candidate.index === atomIndex);
      if (atom && Number.isFinite(charge)) atom.charge = charge;
    }
  }

  return { atoms, bonds };
}

export function bondsForAtom(parsed: ParsedMol, atomIndex: number): MolBond[] {
  return parsed.bonds.filter((bond) => bond.from === atomIndex || bond.to === atomIndex);
}

export function connectedAtom(parsed: ParsedMol, bond: MolBond, atomIndex: number): MolAtom | null {
  const otherIndex = bond.from === atomIndex ? bond.to : bond.from;
  return parsed.atoms.find((atom) => atom.index === otherIndex) ?? null;
}

function effectiveBondOrder(order: number) {
  if (order === 4) return 1.5;
  return Math.max(1, Math.min(3, order));
}

function fallbackHydrogenCount(parsed: ParsedMol, atom: MolAtom) {
  if (!HETERO_LABEL_ELEMENTS.has(atom.element)) return 0;

  const valenceByElement: Record<string, number> = {
    B: 3,
    N: atom.charge > 0 ? 4 : 3,
    O: atom.charge > 0 ? 3 : 2,
    P: atom.charge > 0 ? 4 : 3,
    S: atom.charge > 0 ? 3 : 2,
    Se: 2,
  };
  const targetValence = valenceByElement[atom.element];
  if (!targetValence) return 0;

  const usedValence = bondsForAtom(parsed, atom.index).reduce(
    (sum, bond) => sum + effectiveBondOrder(bond.order),
    0,
  );
  return Math.max(0, Math.min(4, Math.round(targetValence - usedValence)));
}

export function atomHydrogenCount(
  parsed: ParsedMol,
  atom: MolAtom,
  hydrogenCounts?: number[] | null,
) {
  const counted = hydrogenCounts?.[atom.index];
  if (Number.isFinite(counted)) return Math.max(0, counted ?? 0);
  return fallbackHydrogenCount(parsed, atom);
}

export function atomChargeText(charge: number) {
  if (charge === 0) return "";
  const magnitude = Math.abs(charge);
  const sign = charge > 0 ? "+" : "-";
  return magnitude === 1 ? sign : `${magnitude}${sign}`;
}

export function atomHydrogenPrefix(parsed: ParsedMol, atom: MolAtom) {
  const neighbors = bondsForAtom(parsed, atom.index)
    .map((bond) => connectedAtom(parsed, bond, atom.index))
    .filter((neighbor): neighbor is MolAtom => Boolean(neighbor));
  if (neighbors.length === 0) return false;
  const averageNeighborX =
    neighbors.reduce((sum, neighbor) => sum + neighbor.x, 0) / neighbors.length;
  return averageNeighborX > atom.x;
}
