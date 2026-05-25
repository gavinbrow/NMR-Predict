import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { parseMolfile } from "@/lib/nmr/molfile";

interface FloatingCompoundProps {
  id: string;
  label: string;
  smiles: string;
  imageDataUrl?: string | null;
  molfile?: string | null;
  highlightedAtoms?: number[] | null;
  initialX: number;
  initialY: number;
  onClose: () => void;
}

const VIEWBOX_PADDING = 24;
const ATOM_LABEL_FONT = 13;

function StructureSvg({
  molfile,
  highlightedAtoms,
}: {
  molfile: string;
  highlightedAtoms?: number[] | null;
}) {
  const parsed = useMemo(() => parseMolfile(molfile), [molfile]);

  if (!parsed || parsed.atoms.length === 0) {
    return null;
  }

  const xs = parsed.atoms.map((atom) => atom.x);
  const ys = parsed.atoms.map((atom) => atom.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(0.5, maxX - minX);
  const spanY = Math.max(0.5, maxY - minY);

  const width = 200;
  const height = 160;
  const usableWidth = width - VIEWBOX_PADDING * 2;
  const usableHeight = height - VIEWBOX_PADDING * 2;
  const scale = Math.min(usableWidth / spanX, usableHeight / spanY);
  const offsetX = (width - spanX * scale) / 2 - minX * scale;
  const offsetY = (height - spanY * scale) / 2 + maxY * scale;

  const project = (atom: { x: number; y: number }) => ({
    cx: atom.x * scale + offsetX,
    cy: -atom.y * scale + offsetY,
  });

  const projected = parsed.atoms.map(project);
  const highlightSet = new Set(highlightedAtoms ?? []);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-full w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      {parsed.bonds.map((bond, index) => {
        const a = projected[bond.from];
        const b = projected[bond.to];
        if (!a || !b) return null;
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const offset = 3;

        if (bond.order === 2) {
          return (
            <g key={index} stroke="#1f2937" strokeWidth={1.4} strokeLinecap="round">
              <line x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} />
              <line
                x1={a.cx + nx * offset}
                y1={a.cy + ny * offset}
                x2={b.cx + nx * offset}
                y2={b.cy + ny * offset}
              />
            </g>
          );
        }
        if (bond.order === 3) {
          return (
            <g key={index} stroke="#1f2937" strokeWidth={1.4} strokeLinecap="round">
              <line x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} />
              <line
                x1={a.cx + nx * offset}
                y1={a.cy + ny * offset}
                x2={b.cx + nx * offset}
                y2={b.cy + ny * offset}
              />
              <line
                x1={a.cx - nx * offset}
                y1={a.cy - ny * offset}
                x2={b.cx - nx * offset}
                y2={b.cy - ny * offset}
              />
            </g>
          );
        }
        return (
          <line
            key={index}
            x1={a.cx}
            y1={a.cy}
            x2={b.cx}
            y2={b.cy}
            stroke="#1f2937"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
        );
      })}

      {parsed.atoms.map((atom, index) => {
        const { cx, cy } = projected[index];
        const highlighted = highlightSet.has(atom.index);
        const showLabel = atom.element !== "C" || highlighted;

        return (
          <g key={index}>
            {highlighted ? (
              <circle
                cx={cx}
                cy={cy}
                r={9}
                fill="rgba(87, 196, 99, 0.35)"
                stroke="#33a02c"
                strokeWidth={1.5}
              />
            ) : null}
            {showLabel ? (
              <>
                <circle cx={cx} cy={cy} r={ATOM_LABEL_FONT * 0.7} fill="white" />
                <text
                  x={cx}
                  y={cy + ATOM_LABEL_FONT * 0.35}
                  fontSize={ATOM_LABEL_FONT}
                  textAnchor="middle"
                  fontFamily="Inter, system-ui, sans-serif"
                  fontWeight={600}
                  fill={highlighted ? "#1f7a1f" : "#0f172a"}
                >
                  {atom.element}
                </text>
              </>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function FloatingCompound({
  label,
  smiles,
  imageDataUrl,
  molfile,
  highlightedAtoms,
  initialX,
  initialY,
  onClose,
}: FloatingCompoundProps) {
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(
    null,
  );

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
      className="fixed z-50 w-[220px] rounded-sm border border-[#cad3dd] bg-white shadow-[0_2px_8px_rgba(15,23,42,0.18)]"
      style={{ left: pos.x, top: pos.y, fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif" }}
    >
      <div
        className="flex cursor-move items-center justify-between gap-2 border-b border-[#cad3dd] bg-[#f3f5f8] px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-[#4a5568]"
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
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm p-0.5 text-[#4a5568] hover:bg-[#e1e5ea] hover:text-[#1a202c]"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex h-[180px] items-center justify-center bg-white p-2">
        {molfile ? (
          <StructureSvg molfile={molfile} highlightedAtoms={highlightedAtoms} />
        ) : imageDataUrl ? (
          <img src={imageDataUrl} alt={label} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="px-2 text-center font-mono text-[11px] text-[#4a5568]">
            {smiles}
          </span>
        )}
      </div>
      <div className="truncate border-t border-[#cad3dd] bg-[#f8f9fb] px-2 py-1 font-mono text-[10px] text-[#4a5568]">
        {smiles}
      </div>
    </div>
  );
}
