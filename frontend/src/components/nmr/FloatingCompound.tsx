import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  atomChargeText,
  atomHydrogenCount,
  atomHydrogenPrefix,
  bondsForAtom,
  connectedAtom,
  parseMolfile,
  type MolAtom,
  type MolBond,
  type ParsedMol,
} from "@/lib/nmr/molfile";

interface FloatingCompoundProps {
  id: string;
  label: string;
  smiles: string;
  imageDataUrl?: string | null;
  molfile?: string | null;
  hydrogenCounts?: number[];
  highlightedAtoms?: number[] | null;
  initialX: number;
  initialY: number;
  onAtomHover?: (atomIndex: number | null) => void;
  onAtomClick?: (atomIndex: number) => void;
  onClose: () => void;
}

type Point = { x: number; y: number };
type AtomDrawing = {
  atom: MolAtom;
  point: Point;
  highlighted: boolean;
  hovered: boolean;
  label: AtomLabel | null;
};
type HydrogenDrawing = {
  id: string;
  parentIndex: number;
  point: Point;
  bondStart: Point;
  bondEnd: Point;
  highlighted: boolean;
  hovered: boolean;
};
type AtomLabel = {
  hCount: number;
  hPrefix: boolean;
  charge: string;
  element: string;
  showElement: boolean;
  text: string;
  halfWidth: number;
  halfHeight: number;
};

const SVG_WIDTH = 260;
const SVG_HEIGHT = 190;
const SVG_PADDING = 30;
const BOND_COLOR = "#26313d";
const HIGHLIGHT_COLOR = "#2fb344";
const HOVER_COLOR = "#1475ff";
const HIGHLIGHT_FILL = "rgba(47, 179, 68, 0.22)";
const HOVER_FILL = "rgba(20, 117, 255, 0.14)";
const HYDROGEN_BOND_LENGTH = 29;
const HYDROGEN_LABEL_OFFSET = 8;

const ELEMENT_COLORS: Record<string, string> = {
  B: "#8a5a22",
  Br: "#8a3ffc",
  C: "#14212f",
  Cl: "#16803c",
  F: "#008a5a",
  H: "#475569",
  I: "#7c3aed",
  N: "#2563eb",
  O: "#dc2626",
  P: "#c2410c",
  S: "#ca8a04",
  Se: "#a16207",
};

function elementColor(element: string) {
  return ELEMENT_COLORS[element] ?? "#14212f";
}

function visibleAtoms(parsed: ParsedMol) {
  return parsed.atoms.filter((atom) => {
    if (atom.element !== "H") return true;
    const attached = bondsForAtom(parsed, atom.index)
      .map((bond) => connectedAtom(parsed, bond, atom.index))
      .find((neighbor): neighbor is MolAtom => Boolean(neighbor));
    return attached != null && attached.element !== "C";
  });
}

function shouldLabelAtom(atom: MolAtom, highlighted: boolean, hovered: boolean, hCount: number) {
  if (atom.element !== "C") return true;
  if (!highlighted && !hovered) return atom.charge !== 0;
  return atom.charge !== 0;
}

function labelForAtom(
  parsed: ParsedMol,
  atom: MolAtom,
  highlighted: boolean,
  hovered: boolean,
  hydrogenCounts?: number[],
  expandHydrogens = false,
): AtomLabel | null {
  const attachedHydrogens = atom.element === "H"
    ? 0
    : atomHydrogenCount(parsed, atom, hydrogenCounts);
  const hCount = expandHydrogens ? 0 : attachedHydrogens;
  if (!shouldLabelAtom(atom, highlighted, hovered, hCount)) return null;

  const charge = atomChargeText(atom.charge);
  const showElement = atom.element !== "C" || atom.charge !== 0;
  const hPrefix = showElement && hCount > 0 && atomHydrogenPrefix(parsed, atom);
  const hText = hCount > 0 ? `H${hCount > 1 ? hCount : ""}` : "";
  const element = showElement ? atom.element : "";
  const text = hPrefix ? `${hText}${element}${charge}` : `${element}${hText}${charge}`;
  const halfWidth = Math.max(9, text.length * 4.2 + (charge ? 3 : 0));
  return { hCount, hPrefix, charge, element, showElement, text, halfWidth, halfHeight: 8 };
}

function normalizeAngle(angle: number) {
  const fullTurn = Math.PI * 2;
  return ((angle % fullTurn) + fullTurn) % fullTurn;
}

function openHydrogenAngles(existingAngles: number[], count: number) {
  if (count <= 0) return [];

  if (existingAngles.length === 0) {
    const center = -Math.PI / 2;
    const span = count === 1 ? 0 : Math.min(Math.PI * 1.25, (count - 1) * 0.9);
    return Array.from({ length: count }, (_, index) =>
      count === 1 ? center : center - span / 2 + (span * index) / (count - 1),
    );
  }

  const sorted = existingAngles.map(normalizeAngle).sort((a, b) => a - b);
  let largestGap = -1;
  let center = sorted[0] + Math.PI;
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index];
    const end = index === sorted.length - 1 ? sorted[0] + Math.PI * 2 : sorted[index + 1];
    const gap = end - start;
    if (gap > largestGap) {
      largestGap = gap;
      center = start + gap / 2;
    }
  }

  if (count === 1) return [center];

  const span = Math.min(largestGap * 0.62, Math.PI * 1.15, (count - 1) * 0.9);
  return Array.from({ length: count }, (_, index) => center - span / 2 + (span * index) / (count - 1));
}

function scaleStructure(atoms: MolAtom[]) {
  const xs = atoms.map((atom) => atom.x);
  const ys = atoms.map((atom) => atom.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(0.5, maxX - minX);
  const spanY = Math.max(0.5, maxY - minY);
  const usableWidth = SVG_WIDTH - SVG_PADDING * 2;
  const usableHeight = SVG_HEIGHT - SVG_PADDING * 2;
  const scale = Math.min(48, usableWidth / spanX, usableHeight / spanY);
  const offsetX = (SVG_WIDTH - spanX * scale) / 2 - minX * scale;
  const offsetY = (SVG_HEIGHT - spanY * scale) / 2 + maxY * scale;

  return (atom: MolAtom): Point => ({
    x: atom.x * scale + offsetX,
    y: -atom.y * scale + offsetY,
  });
}

function trimPoint(start: Point, end: Point, label: AtomLabel | null) {
  if (!label) return start;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const xDistance = Math.abs(ux) > 0.01 ? label.halfWidth / Math.abs(ux) : Infinity;
  const yDistance = Math.abs(uy) > 0.01 ? label.halfHeight / Math.abs(uy) : Infinity;
  const offset = Math.min(length * 0.38, Math.min(xDistance, yDistance) + 2);
  return { x: start.x + ux * offset, y: start.y + uy * offset };
}

function offsetLine(a: Point, b: Point, amount: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  return {
    a: { x: a.x + nx * amount, y: a.y + ny * amount },
    b: { x: b.x + nx * amount, y: b.y + ny * amount },
  };
}

function wedgePoints(a: Point, b: Point, width = 10) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  return `${a.x},${a.y} ${b.x + nx * width * 0.5},${b.y + ny * width * 0.5} ${
    b.x - nx * width * 0.5
  },${b.y - ny * width * 0.5}`;
}

function hydrogenDrawingsForAtom({
  parsed,
  atomDrawing,
  drawingByIndex,
  hydrogenCounts,
}: {
  parsed: ParsedMol;
  atomDrawing: AtomDrawing;
  drawingByIndex: Map<number, AtomDrawing>;
  hydrogenCounts?: number[];
}): HydrogenDrawing[] {
  const { atom } = atomDrawing;
  if (atom.element === "H" || (!atomDrawing.highlighted && !atomDrawing.hovered)) return [];

  const hCount = atomHydrogenCount(parsed, atom, hydrogenCounts);
  if (hCount <= 0) return [];

  const existingAngles = bondsForAtom(parsed, atom.index)
    .map((bond) => connectedAtom(parsed, bond, atom.index))
    .map((neighbor) => (neighbor ? drawingByIndex.get(neighbor.index) : null))
    .filter((neighbor): neighbor is AtomDrawing => Boolean(neighbor))
    .map((neighbor) =>
      Math.atan2(neighbor.point.y - atomDrawing.point.y, neighbor.point.x - atomDrawing.point.x),
    );

  return openHydrogenAngles(existingAngles, hCount).map((angle, index) => {
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const point = {
      x: atomDrawing.point.x + direction.x * HYDROGEN_BOND_LENGTH,
      y: atomDrawing.point.y + direction.y * HYDROGEN_BOND_LENGTH,
    };
    const rawStart = trimPoint(atomDrawing.point, point, atomDrawing.label);
    const bondEnd = {
      x: point.x - direction.x * HYDROGEN_LABEL_OFFSET,
      y: point.y - direction.y * HYDROGEN_LABEL_OFFSET,
    };
    return {
      id: `${atom.index}-H-${index}`,
      parentIndex: atom.index,
      point,
      bondStart: rawStart,
      bondEnd,
      highlighted: atomDrawing.highlighted,
      hovered: atomDrawing.hovered,
    };
  });
}

function BondLine({
  a,
  b,
  bond,
  className,
  stroke = BOND_COLOR,
  strokeWidth = 1.8,
  opacity = 1,
}: {
  a: Point;
  b: Point;
  bond: MolBond;
  className?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}) {
  if (bond.stereo === 1 && bond.order === 1) {
    return <polygon points={wedgePoints(a, b)} fill={stroke} opacity={opacity} className={className} />;
  }

  if (bond.stereo === 6 && bond.order === 1) {
    return (
      <g stroke={stroke} strokeWidth={1.2} strokeLinecap="round" opacity={opacity} className={className}>
        {Array.from({ length: 6 }, (_, index) => {
          const t = (index + 1) / 7;
          const center = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const length = Math.hypot(dx, dy) || 1;
          const nx = -dy / length;
          const ny = dx / length;
          const width = 2 + t * 9;
          return (
            <line
              key={index}
              x1={center.x - nx * width * 0.5}
              y1={center.y - ny * width * 0.5}
              x2={center.x + nx * width * 0.5}
              y2={center.y + ny * width * 0.5}
            />
          );
        })}
      </g>
    );
  }

  if (bond.order === 2) {
    const first = offsetLine(a, b, 3);
    const second = offsetLine(a, b, -3);
    return (
      <g stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" opacity={opacity} className={className}>
        <line x1={first.a.x} y1={first.a.y} x2={first.b.x} y2={first.b.y} />
        <line x1={second.a.x} y1={second.a.y} x2={second.b.x} y2={second.b.y} />
      </g>
    );
  }

  if (bond.order === 3) {
    const first = offsetLine(a, b, 4.5);
    const third = offsetLine(a, b, -4.5);
    return (
      <g stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" opacity={opacity} className={className}>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        <line x1={first.a.x} y1={first.a.y} x2={first.b.x} y2={first.b.y} />
        <line x1={third.a.x} y1={third.a.y} x2={third.b.x} y2={third.b.y} />
      </g>
    );
  }

  return (
    <line
      x1={a.x}
      y1={a.y}
      x2={b.x}
      y2={b.y}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeDasharray={bond.order === 4 ? "5 4" : undefined}
      opacity={opacity}
      className={className}
    />
  );
}

function AtomText({ drawing }: { drawing: AtomDrawing }) {
  const { atom, point, label, highlighted, hovered } = drawing;
  if (!label) return null;

  const fill = highlighted ? "#176b25" : hovered ? "#0f4f9f" : elementColor(atom.element);
  const hText = label.hCount > 0 ? "H" : "";
  const hNumber = label.hCount > 1 ? String(label.hCount) : "";

  return (
    <g>
      <rect
        x={point.x - label.halfWidth - 2}
        y={point.y - label.halfHeight - 2}
        width={(label.halfWidth + 2) * 2}
        height={(label.halfHeight + 2) * 2}
        rx={5}
        fill="white"
        opacity={0.94}
      />
      <text
        x={point.x}
        y={point.y + 4.5}
        textAnchor="middle"
        fontFamily="'Arial', 'Helvetica Neue', sans-serif"
        fontSize={14}
        fontWeight={700}
        fill={fill}
      >
        {label.hPrefix && hText ? <tspan>{hText}</tspan> : null}
        {label.hPrefix && hNumber ? (
          <tspan baselineShift="sub" fontSize={9}>
            {hNumber}
          </tspan>
        ) : null}
        {label.showElement ? <tspan>{label.element}</tspan> : null}
        {!label.hPrefix && hText ? <tspan>{hText}</tspan> : null}
        {!label.hPrefix && hNumber ? (
          <tspan baselineShift="sub" fontSize={9}>
            {hNumber}
          </tspan>
        ) : null}
        {label.charge ? (
          <tspan baselineShift="super" dx={1} fontSize={9}>
            {label.charge}
          </tspan>
        ) : null}
      </text>
    </g>
  );
}

function HydrogenText({ drawing }: { drawing: HydrogenDrawing }) {
  const color = drawing.highlighted ? "#176b25" : HOVER_COLOR;

  return (
    <g data-virtual-hydrogen={drawing.id} pointerEvents="none">
      <circle cx={drawing.point.x} cy={drawing.point.y} r={9.5} fill="white" opacity={0.96} />
      <text
        x={drawing.point.x}
        y={drawing.point.y + 4.2}
        textAnchor="middle"
        fontFamily="'Arial', 'Helvetica Neue', sans-serif"
        fontSize={13}
        fontWeight={700}
        fill={color}
      >
        H
      </text>
    </g>
  );
}

function StructureSvg({
  molfile,
  hydrogenCounts,
  highlightedAtoms,
  onAtomHover,
  onAtomClick,
}: {
  molfile: string;
  hydrogenCounts?: number[];
  highlightedAtoms?: number[] | null;
  onAtomHover?: (atomIndex: number | null) => void;
  onAtomClick?: (atomIndex: number) => void;
}) {
  const [hoveredAtomIndex, setHoveredAtomIndex] = useState<number | null>(null);
  const parsed = useMemo(() => parseMolfile(molfile), [molfile]);

  const model = useMemo(() => {
    if (!parsed) return null;
    const atoms = visibleAtoms(parsed);
    if (atoms.length === 0) return null;

    const project = scaleStructure(atoms);
    const activeSet = new Set(highlightedAtoms ?? []);
    if (hoveredAtomIndex != null) activeSet.add(hoveredAtomIndex);

    const drawings = atoms.map((atom) => {
      const highlighted = Boolean(highlightedAtoms?.includes(atom.index));
      const hovered = hoveredAtomIndex === atom.index;
      const expandHydrogens =
        (highlighted || hovered) && atom.element !== "H" && atomHydrogenCount(parsed, atom, hydrogenCounts) > 0;
      return {
        atom,
        point: project(atom),
        highlighted,
        hovered,
        label: labelForAtom(parsed, atom, highlighted, hovered, hydrogenCounts, expandHydrogens),
      };
    });
    const drawingByIndex = new Map(drawings.map((drawing) => [drawing.atom.index, drawing]));
    const hydrogens = drawings.flatMap((drawing) =>
      hydrogenDrawingsForAtom({ parsed, atomDrawing: drawing, drawingByIndex, hydrogenCounts }),
    );
    const bonds = parsed.bonds
      .map((bond) => {
        const from = drawingByIndex.get(bond.from);
        const to = drawingByIndex.get(bond.to);
        if (!from || !to) return null;
        const a = trimPoint(from.point, to.point, from.label);
        const b = trimPoint(to.point, from.point, to.label);
        return {
          bond,
          a,
          b,
          highlighted: activeSet.has(bond.from) || activeSet.has(bond.to),
        };
      })
      .filter((bond): bond is NonNullable<typeof bond> => Boolean(bond));

    return { drawings, bonds, hydrogens };
  }, [highlightedAtoms, hoveredAtomIndex, hydrogenCounts, parsed]);

  useEffect(() => {
    if (highlightedAtoms?.includes(hoveredAtomIndex ?? -1)) return;
    if (hoveredAtomIndex == null) return;
    if (parsed?.atoms.some((atom) => atom.index === hoveredAtomIndex)) return;
    setHoveredAtomIndex(null);
  }, [highlightedAtoms, hoveredAtomIndex, parsed]);

  if (!model) return null;

  return (
    <svg
      viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
      className="h-full w-full"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Molecule structure"
      onPointerLeave={() => {
        setHoveredAtomIndex(null);
        onAtomHover?.(null);
      }}
    >
      <rect x={0} y={0} width={SVG_WIDTH} height={SVG_HEIGHT} fill="white" />

      {model.bonds
        .filter((bond) => bond.highlighted)
        .map(({ bond, a, b }, index) => (
          <BondLine
            key={`highlight-bond-${index}`}
            a={a}
            b={b}
            bond={bond}
            stroke={HIGHLIGHT_COLOR}
            strokeWidth={7}
            opacity={0.18}
          />
        ))}

      {model.drawings.map((drawing) => {
        if (!drawing.highlighted && !drawing.hovered) return null;
        return (
          <circle
            key={`halo-${drawing.atom.index}`}
            cx={drawing.point.x}
            cy={drawing.point.y}
            r={drawing.label ? Math.max(13, drawing.label.halfWidth + 5) : 12}
            fill={drawing.highlighted ? HIGHLIGHT_FILL : HOVER_FILL}
            stroke={drawing.highlighted ? HIGHLIGHT_COLOR : HOVER_COLOR}
            strokeWidth={1.5}
          />
        );
      })}

      {model.bonds.map(({ bond, a, b }, index) => (
        <BondLine key={`bond-${index}`} a={a} b={b} bond={bond} />
      ))}

      {model.hydrogens.map((drawing) => (
        <line
          key={`hydrogen-bond-${drawing.id}`}
          data-virtual-hydrogen-bond={drawing.id}
          x1={drawing.bondStart.x}
          y1={drawing.bondStart.y}
          x2={drawing.bondEnd.x}
          y2={drawing.bondEnd.y}
          stroke={drawing.highlighted ? HIGHLIGHT_COLOR : HOVER_COLOR}
          strokeWidth={1.45}
          strokeLinecap="round"
          pointerEvents="none"
        />
      ))}

      {model.drawings.map((drawing) => (
        <AtomText key={`label-${drawing.atom.index}`} drawing={drawing} />
      ))}

      {model.hydrogens.map((drawing) => (
        <HydrogenText key={`hydrogen-${drawing.id}`} drawing={drawing} />
      ))}

      {model.drawings.map((drawing) => (
        <circle
          key={`hit-${drawing.atom.index}`}
          cx={drawing.point.x}
          cy={drawing.point.y}
          r={18}
          fill="transparent"
          className="cursor-pointer"
          onPointerEnter={() => {
            setHoveredAtomIndex(drawing.atom.index);
            onAtomHover?.(drawing.atom.index);
          }}
          onClick={(event) => {
            event.stopPropagation();
            onAtomClick?.(drawing.atom.index);
          }}
        >
          <title>{`${drawing.atom.element} atom #${drawing.atom.index}`}</title>
        </circle>
      ))}
    </svg>
  );
}

export function FloatingCompound({
  id,
  label,
  smiles,
  imageDataUrl,
  molfile,
  hydrogenCounts,
  highlightedAtoms,
  initialX,
  initialY,
  onAtomHover,
  onAtomClick,
  onClose,
}: FloatingCompoundProps) {
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(
    null,
  );

  const activeText = useMemo(() => {
    if (!molfile || !highlightedAtoms || highlightedAtoms.length === 0) return null;
    const parsed = parseMolfile(molfile);
    if (!parsed) return null;
    const labels = highlightedAtoms
      .map((atomIndex) => parsed.atoms.find((atom) => atom.index === atomIndex))
      .filter((atom): atom is MolAtom => Boolean(atom))
      .map((atom) => `${atom.element} #${atom.index}`);
    return labels.length > 0 ? labels.join(", ") : null;
  }, [highlightedAtoms, molfile]);

  useEffect(() => {
    function handleMove(event: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      setPos({
        x: drag.originX + (event.clientX - drag.startX),
        y: drag.originY + (event.clientY - drag.startY),
      });
    }
    function handleUp() {
      dragRef.current = null;
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  return (
    <div
      className="fixed z-50 w-[280px] overflow-hidden rounded-lg border border-[#c8d4df] bg-white shadow-[0_14px_34px_rgba(15,23,42,0.22)]"
      style={{ left: pos.x, top: pos.y, fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif" }}
      data-compound-id={id}
    >
      <div
        className="flex cursor-move items-center justify-between gap-2 border-b border-[#c8d4df] bg-[#eef3f7] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[#334155]"
        onMouseDown={(event) => {
          dragRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            originX: pos.x,
            originY: pos.y,
          };
          document.body.style.userSelect = "none";
        }}
      >
        <span className="truncate">{label}</span>
        <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-[#64748b]">
          hover atoms
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-[#64748b] hover:bg-[#dbe4ec] hover:text-[#0f172a]"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex h-[218px] items-center justify-center bg-white p-2">
        {molfile ? (
          <StructureSvg
            molfile={molfile}
            hydrogenCounts={hydrogenCounts}
            highlightedAtoms={highlightedAtoms}
            onAtomHover={onAtomHover}
            onAtomClick={onAtomClick}
          />
        ) : imageDataUrl ? (
          <img src={imageDataUrl} alt={label} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="px-2 text-center font-mono text-[11px] text-[#4a5568]">
            {smiles}
          </span>
        )}
      </div>
      <div className="border-t border-[#c8d4df] bg-[#f7fafc] px-3 py-2">
        <div className="truncate font-mono text-[10px] text-[#475569]">{smiles}</div>
        <div className="mt-1 text-[10px] font-medium text-[#64748b]">
          {activeText ?? "Hover a peak or atom to link structure and spectrum."}
        </div>
      </div>
    </div>
  );
}
