// Segment chip picker for the selected run's "Segments" left-rail section:
// one chip per procedure segment (§WP1.4's `DscSegment`), reading like
// "Heat 1 · 10 °C/min · 0→280 °C", plus an "All" chip that overlays every
// segment (all heats and cools) on the plot — i.e. it requests the plot's
// `segmentMode: "all"` (see `lib/dsc/plot.ts`'s `segmentsForMode` and
// `lib/dsc/figure.ts`), NOT a pinned-segment value. Clicking a specific chip
// pins that segment (`useDscStore().setActiveSegment`) AND switches back to
// `segmentMode: "active"`.
//
// Stateless — this component owns no state of its own. The host tells it
// which chip is active via `allSegments` (highlights "All") and
// `resolvedSegmentId` (highlights that segment otherwise — the run's
// resolved `analysis.segmentId`, since a `null` pinned segment still
// resolves to a real default, normally the 2nd heat), and reports clicks via
// `onSelectAll` / `onSelect`.

import { segmentDisplayName } from "@/lib/dsc/segments";
import type { DscSegment } from "@/lib/dsc/types";

function segmentLabel(seg: DscSegment): string {
  const parts = [segmentDisplayName(seg)];
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
  allSegments,
  resolvedSegmentId,
  onSelectAll,
  onSelect,
}: {
  segments: DscSegment[];
  /** True when the plot is currently overlaying every segment
   *  (`segmentMode: "all"`) — highlights the "All" chip instead of a single
   *  segment chip. */
  allSegments: boolean;
  /** The run's resolved active segment (`run.analysis.segmentId`) — highlighted
   *  when `allSegments` is false. Always a real segment id (or `null` only
   *  when the run has none), never the "unresolved" sentinel the pinned
   *  `activeSegmentId` can be. */
  resolvedSegmentId: string | null;
  /** Request `segmentMode: "all"` (overlay every heat/cool segment). */
  onSelectAll: () => void;
  /** Pin this segment and request `segmentMode: "active"`. */
  onSelect: (segmentId: string) => void;
}) {
  if (segments.length === 0) {
    return <p className="text-xs text-muted-foreground">This run has no segments.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      <Chip active={allSegments} onClick={onSelectAll} title="Overlay every heating and cooling segment">
        All
      </Chip>
      {segments.map((seg) => (
        <Chip
          key={seg.id}
          active={!allSegments && resolvedSegmentId === seg.id}
          onClick={() => onSelect(seg.id)}
        >
          {segmentLabel(seg)}
        </Chip>
      ))}
    </div>
  );
}
