// Pure, DOM-free label layout for the GC/MS plot overlays.
//
// `layoutLabels` takes a set of anchors (already converted to PLOT PIXELS by the
// caller via uPlot's `valToPos`) and produces a non-overlapping set of label
// boxes connected to their anchors by leader lines. It is the ONLY placement
// logic the GC/MS panels use; it never touches the DOM and never measures real
// text — text width is ALWAYS estimated as `len * charWidth` (the caller passes
// `charWidth ≈ fontSize * 0.6`). Measuring with `getBBox()` would race the PNG
// exporter's settle and make the exported image differ from the preview, so
// that is strictly forbidden here.
//
// The algorithm is deterministic and order-stable: the result is returned in
// x-ascending order of the ANCHOR (ties broken by priority descending), which
// the caller can rely on for snapshot tests and for stable overlay rendering
// across redraws.

export interface LabelInput {
  /** Anchor x in plot pixels (the point the leader line points at). */
  x: number;
  /** Anchor y in plot pixels. */
  y: number;
  /** Each line of text (already trimmed to a sensible length by the caller). */
  lines: string[];
  /** Higher priority wins placement first; ties broken by x ascending. */
  priority: number;
  /** Optional override colour; the caller's theme default is used when absent. */
  color?: string;
}

export interface PlacedLabel {
  /** Top-left of the label box, in plot pixels. */
  x: number;
  /** Top of the label box, in plot pixels. */
  y: number;
  /** The anchor the leader line points at, in plot pixels. */
  anchorX: number;
  anchorY: number;
  lines: string[];
  color?: string;
  /**
   * Whether the caller should draw a leader line for this label. `false`
   * when the box ended up within `leaderMinPx + 2` px of its anchor (measured
   * anchor-to-box-bottom-centre) — a well-placed label sitting right above
   * its point needs no visible connector. `true` once the box has been
   * pushed or clamped far enough away that a line is needed to tie it back
   * to its anchor.
   */
  leader: boolean;
}

export interface LayoutOptions {
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  fontSize: number;
  lineHeight: number;
  charWidth: number;
  maxLabels: number;
  minGapPx: number;
  leaderMinPx: number;
  /**
   * The furthest a label box may be pushed from its anchor (by the
   * collision push-up loop, step 7) before it is DROPPED instead of drawn.
   * Without this cap, a plot crowded with same-x anchors pushes every
   * collision loser all the way up to `plotTop`, each dragging a
   * full-height leader line behind it — the "field of grey vertical
   * strokes" bug this option exists to kill. Optional; defaults to
   * {@link DEFAULT_LEADER_MAX_PX} so callers that predate this option (the
   * PNG exporter, existing tests) keep their original, more permissive
   * behaviour.
   */
  leaderMaxPx?: number;
  /**
   * The furthest the horizontal clamp (step 4) may shift a box's centre
   * from its anchor's x before the label is DROPPED (step 5) rather than
   * drawn with a long diagonal leader running sideways to the plot edge.
   * Optional; defaults to {@link DEFAULT_MAX_OVERHANG_PX}.
   */
  maxOverhangPx?: number;
}

/** Default for {@link LayoutOptions.leaderMaxPx}. */
const DEFAULT_LEADER_MAX_PX = 160;
/** Default for {@link LayoutOptions.maxOverhangPx}. */
const DEFAULT_MAX_OVERHANG_PX = 60;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxWidth(item: LabelInput, charWidth: number): number {
  let maxLen = 0;
  for (const line of item.lines) {
    if (line.length > maxLen) maxLen = line.length;
  }
  return maxLen * charWidth;
}

function boxesCollide(a: Box, b: Box, gap: number): boolean {
  return (
    a.x - gap < b.x + b.w &&
    a.x + a.w + gap > b.x &&
    a.y - gap < b.y + b.h &&
    a.y + a.h + gap > b.y
  );
}

/**
 * Lay out a set of labels so none overlap, each is clamped inside the plot box,
 * and each (unless clamped at the top edge) sits at least `leaderMinPx` above
 * its anchor. Returns the placed labels in x-ascending order of the anchor
 * (ties broken by priority descending, then by original input order).
 *
 * Algorithm:
 *   1. Sort by `priority` DESCENDING; cap the list at `maxLabels`.
 *   2. Box size: `w = maxLineLength * charWidth`, `h = lines.length * lineHeight`.
 *   3. Initial position: horizontally centred on the anchor
 *      (`x = anchorX - w/2`), vertically `y = anchorY - leaderMinPx - h`.
 *   4. Clamp into the plot box
 *      `[plotLeft, plotLeft+plotWidth] x [plotTop, plotTop+plotHeight]`.
 *   5. DROP the label if the horizontal clamp in step 4 shifted its box
 *      centre more than `maxOverhangPx` from the anchor's x — otherwise the
 *      leader would be a long diagonal stroke to the plot edge rather than a
 *      short, near-vertical line.
 *   6. Collision-test against every already-placed box, inflated by `minGapPx`.
 *      On a collision, push the box UP in `lineHeight` steps and retest.
 *   7. DROP the label entirely if it still collides after exhausting the space
 *      above, if pushing it up took it outside the plot box, or if the push
 *      grew the anchor-to-box gap beyond `leaderMaxPx` (a label that would
 *      need an oversized leader is dropped rather than shoved all the way to
 *      `plotTop` dragging a full-height line behind it).
 *   8. Return in x-ascending order of the anchor. Each placed label also
 *      reports `leader: false` when its box ended up within
 *      `leaderMinPx + 2` px of the anchor (no visible connector needed) and
 *      `true` otherwise.
 */
export function layoutLabels(items: LabelInput[], opts: LayoutOptions): PlacedLabel[] {
  if (items.length === 0) return [];

  const {
    plotLeft,
    plotTop,
    plotWidth,
    plotHeight,
    lineHeight,
    charWidth,
    maxLabels,
    minGapPx,
    leaderMinPx,
  } = opts;
  const leaderMaxPx = opts.leaderMaxPx ?? DEFAULT_LEADER_MAX_PX;
  const maxOverhangPx = opts.maxOverhangPx ?? DEFAULT_MAX_OVERHANG_PX;
  const plotRight = plotLeft + plotWidth;
  const plotBottom = plotTop + plotHeight;

  // 1. Sort by priority DESCENDING; stable on input order for equal priority.
  // We carry the original index so the priority-descending sort is stable and
  // so the final x-ascending sort can break ties deterministically.
  const indexed = items.map((it, i) => ({ it, i }));
  indexed.sort((a, b) => {
    if (b.it.priority !== a.it.priority) return b.it.priority - a.it.priority;
    return a.i - b.i;
  });
  const capped = indexed.slice(0, Math.max(0, maxLabels));

  const placed: { item: LabelInput; box: Box; origIdx: number }[] = [];

  for (const { it, i } of capped) {
    // 2. Box size.
    const w = boxWidth(it, charWidth);
    const h = it.lines.length * lineHeight;

    // 3. Initial position: centred on the anchor, above it by leaderMinPx.
    let x = it.x - w / 2;
    let y = it.y - leaderMinPx - h;

    // 4. Clamp into the plot box on BOTH axes. A label whose natural position
    //    sits above plotTop (anchor near the top edge) is clamped down to
    //    plotTop; the spec waives the leaderMinPx rule for such top-clamped
    //    labels. Vertical clamping BEFORE the collision push means a push that
    //    starts from plotTop immediately leaves the box and drops the label.
    if (x < plotLeft) x = plotLeft;
    if (x + w > plotRight) x = plotRight - w;
    if (x < plotLeft) x = plotLeft; // w > plotWidth: keep left edge in-bounds.

    // 5. DROP if the horizontal clamp above shoved the box more than
    //    maxOverhangPx away from the anchor — that shift is what turns the
    //    leader into a long diagonal stroke running sideways to the plot
    //    edge (the reported "stray gray line" bug).
    const overhangX = Math.abs(x + w / 2 - it.x);
    if (overhangX > maxOverhangPx) continue;

    if (y < plotTop) y = plotTop;
    if (y + h > plotBottom) y = plotBottom - h;
    if (y < plotTop) continue; // taller than the plot box: drop.

    // 6. Collision: push UP in lineHeight steps and retest.
    let collides = true;
    let dropped = false;
    while (collides) {
      collides = false;
      for (const { box } of placed) {
        if (boxesCollide({ x, y, w, h }, box, minGapPx)) {
          collides = true;
          break;
        }
      }
      if (collides) {
        y -= lineHeight;
        // 7. If pushed outside the plot box, DROP the label.
        if (y < plotTop) {
          dropped = true;
          break;
        }
        // 7. If the push grew the anchor-to-box gap past leaderMaxPx, DROP
        //    rather than keep pushing toward plotTop — this is the fix for
        //    the full-height leader-line field: a label that can't be placed
        //    within a reasonable leader length disappears instead of being
        //    shoved to the top of the plot.
        if (it.y - (y + h) > leaderMaxPx) {
          dropped = true;
          break;
        }
      }
    }
    if (dropped) continue;

    placed.push({ item: it, box: { x, y, w, h }, origIdx: i });
  }

  // 8. Return in x-ascending order of the anchor (ties broken by priority
  //    descending, then by original input order) — documented and stable.
  placed.sort((a, b) => {
    if (a.item.x !== b.item.x) return a.item.x - b.item.x;
    if (b.item.priority !== a.item.priority) return b.item.priority - a.item.priority;
    return a.origIdx - b.origIdx;
  });

  return placed.map(({ item, box }) => {
    // 8. leader: false when the box is within leaderMinPx + 2 of the anchor,
    // measured as the straight-line distance from the anchor to the leader
    // line's other endpoint (the box's bottom-centre) — so a small residual
    // x-overhang doesn't flip a vertically well-placed label into "needs a
    // leader" territory, but a real push-up or clamp does.
    const boxCenterX = box.x + box.w / 2;
    const boxBottom = box.y + box.h;
    const dist = Math.hypot(boxCenterX - item.x, boxBottom - item.y);
    return {
      x: box.x,
      y: box.y,
      anchorX: item.x,
      anchorY: item.y,
      lines: item.lines,
      color: item.color,
      leader: dist > leaderMinPx + 2,
    };
  });
}