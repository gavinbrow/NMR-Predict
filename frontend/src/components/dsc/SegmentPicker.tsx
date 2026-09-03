// Segment chip picker for the selected run's "Segments" left-rail section:
// one chip per procedure segment (§WP1.4's `DscSegment`), reading like
// "Heat 1 · 10 °C/min · 0→280 °C", plus an "All" chip that clears the run's
// pinned segment (passes `null`, which the store/compute layer resolves back
// to the default per `defaultSegmentId` — normally the 2nd heat).
//
// Stateless — selection is reported via `onSelect`; the host wires it to
// `useDscStore().setActiveSegment`.

import type { DscSegment } from "@/lib/dsc/types";

const KIND_LABEL: Record<DscSegment["kind"], string> = {
  heat: "Heat",
  cool: "Cool",
  isothermal: "Isothermal",
  unknown: "Segment",
};

function segmentLabel(seg: DscSegment): string {
  const parts = [`${KIND_LABEL[seg.kind]} ${seg.ordinal}`];
  if (seg.rateCPerMin != null) parts.push(`${seg.rateCPerMin} °C/min`);
  parts.push(`${Math.round(seg.tStartC)}→${Math.round(seg.tEndC)} °C`);
  return parts.join(" · ");
}

function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-smooth ${
        active
          ? "border-primary/60 bg-primary/10 text-primary"
          : "border-border/60 bg-background/60 text-muted-foreground hover:border-primary/40 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export function SegmentPicker({
  segments,
  activeSegmentId,
  onSelect,
}: {
  segments: DscSegment[];
  /** The run's currently pinned segment, or `null` when it should resolve to
   *  the default (§WP1.4's `defaultSegmentId`). */
  activeSegmentId: string | null;
  onSelect: (segmentId: string | null) => void;
}) {
  if (segments.length === 0) {
    return <p className="text-xs text-muted-foreground">This run has no segments.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      <Chip
        active={activeSegmentId === null}
        onClick={() => onSelect(null)}
        title="Resolve to the default segment (2nd heat, when present)"
      >
        All
      </Chip>
      {segments.map((seg) => (
        <Chip key={seg.id} active={activeSegmentId === seg.id} onClick={() => onSelect(seg.id)}>
          {segmentLabel(seg)}
        </Chip>
      ))}
    </div>
  );
}
