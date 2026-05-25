export interface MolAtom {
  index: number;
  element: string;
  x: number;
  y: number;
}

export interface MolBond {
  from: number;
  to: number;
  order: number;
}

export interface ParsedMol {
  atoms: MolAtom[];
  bonds: MolBond[];
}

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
    if (!Number.isFinite(x) || !Number.isFinite(y) || !element) continue;
    atoms.push({ index: i, element, x, y });
  }

  const bonds: MolBond[] = [];
  for (let i = 0; i < bondCount; i += 1) {
    const line = lines[4 + atomCount + i] ?? "";
    const from = Number.parseInt(line.slice(0, 3).trim(), 10) - 1;
    const to = Number.parseInt(line.slice(3, 6).trim(), 10) - 1;
    const order = Number.parseInt(line.slice(6, 9).trim(), 10) || 1;
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    bonds.push({ from, to, order });
  }

  return { atoms, bonds };
}
