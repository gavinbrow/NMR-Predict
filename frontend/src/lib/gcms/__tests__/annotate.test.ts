import { describe, expect, it } from "vitest";
import { layoutLabels, type LabelInput } from "../annotate";

// Default layout options used across the suite. The plot box is 1000 wide and
// 600 tall, starting at (40, 10); there is plenty of room above every anchor
// unless a test deliberately shrinks the box.
const OPTS = {
  plotLeft: 40,
  plotTop: 10,
  plotWidth: 1000,
  plotHeight: 600,
  fontSize: 12,
  lineHeight: 14,
  charWidth: 7.2,
  maxLabels: 50,
  minGapPx: 2,
  leaderMinPx: 12,
};

function label(x: number, y: number, text: string, priority = 1): LabelInput {
  return { x, y, lines: [text], priority };
}

describe("layoutLabels", () => {
  it("returns an empty array for no inputs", () => {
    expect(layoutLabels([], OPTS)).toEqual([]);
  });

  it("places a single label centred above its anchor", () => {
    const out = layoutLabels([label(540, 300, "7.401", 10)], OPTS);
    expect(out).toHaveLength(1);
    const p = out[0];
    expect(p.anchorX).toBe(540);
    expect(p.anchorY).toBe(300);
    // x centred: anchorX - w/2. w = "7.401".length * charWidth = 5 * 7.2 = 36.
    expect(p.x).toBeCloseTo(540 - 18, 6);
    // y above anchor by leaderMinPx + h (h = 1 line = 14).
    expect(p.y).toBeCloseTo(300 - 12 - 14, 6);
  });

  it("sorts by priority descending (highest priority placed first)", () => {
    const a = label(540, 300, "low", 1);
    const b = label(540, 300, "HIGH", 9);
    // Two anchors at the SAME (x,y): the higher-priority one wins the initial
    // slot; the lower one is pushed up. Both should still be placed because the
    // box is short and there is room above.
    const out = layoutLabels([a, b], OPTS);
    expect(out).toHaveLength(2);
    // The high-priority label sits lower (closer to the anchor); the low one is
    // pushed above it by one box height + gap.
    const high = out.find((p) => p.lines[0] === "HIGH")!;
    const low = out.find((p) => p.lines[0] === "low")!;
    expect(high.y).toBeGreaterThan(low.y);
  });

  it("caps the list at maxLabels", () => {
    const items: LabelInput[] = [];
    for (let i = 0; i < 10; i += 1) items.push(label(100 + i * 100, 300, `p${i}`, 10 - i));
    const out = layoutLabels(items, { ...OPTS, maxLabels: 3 });
    expect(out).toHaveLength(3);
    // The three highest-priority items (p0, p1, p2) survive.
    const texts = out.map((p) => p.lines[0]).sort();
    expect(texts).toEqual(["p0", "p1", "p2"]);
  });

  it("a two-line label is twice as tall as a one-line label", () => {
    const one = layoutLabels([label(540, 300, "x", 5)], OPTS)[0];
    const two = layoutLabels([{ x: 540, y: 300, lines: ["a", "b"], priority: 5 }], OPTS)[0];
    // Both bottoms sit at anchorY - leaderMinPx (== 300 - 12 = 288); the
    // two-line box's TOP is one lineHeight higher, so it is twice as TALL.
    const oneHeight = 1 * 14;
    const twoHeight = 2 * 14;
    expect(two.y).toBeCloseTo(one.y - 14, 6);
    expect(twoHeight).toBe(2 * oneHeight);
    // Bottoms coincide.
    expect(one.y + oneHeight).toBeCloseTo(two.y + twoHeight, 6);
  });

  it("clamps the left edge when the anchor is near the left plot edge", () => {
    const out = layoutLabels([label(45, 300, "7.401", 1)], OPTS);
    expect(out).toHaveLength(1);
    // w = 36; centred would be 45 - 18 = 27, below plotLeft (40). Clamp to 40.
    expect(out[0].x).toBe(40);
  });

  it("clamps the right edge when the anchor is near the right plot edge", () => {
    const right = OPTS.plotLeft + OPTS.plotWidth; // 1040
    const out = layoutLabels([label(right - 5, 300, "7.401", 1)], OPTS);
    expect(out).toHaveLength(1);
    // w = 36; centred would be (right-5) - 18 = right - 23, but x + w = right + 13
    // exceeds plotRight (1040). Clamp so x + w = 1040 => x = 1004.
    expect(out[0].x + 36).toBe(OPTS.plotLeft + OPTS.plotWidth);
  });

  it("clamps the top edge when the anchor is near the top", () => {
    // Anchor at y = 15 (just inside plotTop = 10). Natural top would be
    // 15 - 12 - 14 = -11, below plotTop. Clamp to plotTop (10). The
    // leaderMinPx rule is waived for top-clamped labels.
    const out = layoutLabels([label(540, 15, "top", 1)], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0].y).toBe(OPTS.plotTop);
  });

  it("resolves two anchors at the same x by pushing one up", () => {
    const out = layoutLabels([label(540, 300, "a", 5), label(540, 300, "b", 4)], OPTS);
    expect(out).toHaveLength(2);
    const a = out.find((p) => p.lines[0] === "a")!;
    const b = out.find((p) => p.lines[0] === "b")!;
    // Same anchor, so one is pushed above the other by (h + minGapPx).
    expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(14);
  });

  it("drops a third label that cannot fit", () => {
    // Shrink the vertical space above the anchor so only TWO stacked boxes fit.
    // plotTop = 552, anchor y = 610, leaderMinPx = 12, lineHeight = 14,
    // minGapPx = 2. The first box's top = 610 - 12 - 14 = 584 (inside). The
    // second is pushed up by (h + minGapPx) = 16 to 584 - 16 = 568 which is
    // ABOVE plotTop (552)?? 568 >= 552 so it FITS — adjust so the second is
    // borderline and the third definitely drops. Use plotTop = 570: first box
    // top = 584 (fits), second pushed to 568 (< 570 => DROPPED). That yields 1.
    // To get exactly TWO placed and a third dropped, we want the second to fit
    // and the third not: plotTop = 552 => first 584, second 568 (fits, >=552),
    // third 552 (< 552 is false; 552 == 552 borderline). Use plotTop = 553 so
    // the third push to 552 is < 553 and drops, while the second at 568 fits.
    const opts = { ...OPTS, plotTop: 553, plotHeight: 60, leaderMinPx: 12 };
    const out = layoutLabels(
      [label(540, 610, "a", 5), label(540, 610, "b", 4), label(540, 610, "c", 3)],
      opts,
    );
    expect(out).toHaveLength(2);
  });

  it("honours leaderMinPx: every placed box bottom is at least leaderMinPx above its anchorY (unless top-clamped)", () => {
    const items: LabelInput[] = [
      label(200, 300, "a", 5),
      label(400, 100, "b", 5), // well below plotTop, room above
      label(600, 25, "c", 5), // near top -> will be clamped (waived)
      label(800, 500, "d", 5),
    ];
    const out = layoutLabels(items, OPTS);
    for (const p of out) {
      const bottom = p.y + p.lines.length * OPTS.lineHeight;
      const gap = p.anchorY - bottom;
      if (p.y === OPTS.plotTop) {
        // Top-clamped: the rule is waived. Just assert it is inside the box.
        expect(p.y).toBeGreaterThanOrEqual(OPTS.plotTop);
      } else {
        expect(gap).toBeGreaterThanOrEqual(OPTS.leaderMinPx - 1e-6);
      }
    }
  });

  it("returns labels in x-ascending order of the anchor", () => {
    const items: LabelInput[] = [
      label(700, 300, "c", 3),
      label(100, 300, "a", 1),
      label(450, 300, "b", 2),
    ];
    const out = layoutLabels(items, OPTS);
    expect(out.map((p) => p.lines[0])).toEqual(["a", "b", "c"]);
  });

  it("preserves the lines array and color on the placed label", () => {
    const out = layoutLabels(
      [{ x: 540, y: 300, lines: ["first", "second"], priority: 1, color: "#0ea5e9" }],
      OPTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].lines).toEqual(["first", "second"]);
    expect(out[0].color).toBe("#0ea5e9");
  });

  it("a well-placed label (no collision, no clamp) reports leader === false", () => {
    const out = layoutLabels([label(540, 300, "7.401", 10)], OPTS);
    expect(out).toHaveLength(1);
    // Bottom sits exactly leaderMinPx (12) above the anchor — well under the
    // leaderMinPx + 2 threshold, so no leader line is needed.
    expect(out[0].leader).toBe(false);
  });

  it("a label pushed up by a collision reports leader === true", () => {
    const out = layoutLabels([label(540, 300, "a", 5), label(540, 300, "b", 4)], OPTS);
    expect(out).toHaveLength(2);
    const a = out.find((p) => p.lines[0] === "a")!; // wins the initial slot
    const b = out.find((p) => p.lines[0] === "b")!; // pushed up one box height
    expect(a.leader).toBe(false);
    expect(b.leader).toBe(true);
  });

  it("drops a label whose collision push-up would exceed leaderMaxPx instead of shoving it to plotTop", () => {
    // Plenty of vertical room (plotTop=10, plotHeight=600) so plotTop is NOT
    // the limiting factor — only leaderMaxPx should cause the drop. Two
    // labels share the same anchor: the higher-priority one ("a") takes the
    // initial slot (gap = leaderMinPx = 12); "b" collides and is pushed up by
    // one lineHeight (14), growing its gap to 26. With leaderMaxPx set to 20
    // (between 12 and 26), "b" must be dropped rather than pushed further.
    const opts = { ...OPTS, leaderMaxPx: 20 };
    const out = layoutLabels([label(540, 300, "a", 5), label(540, 300, "b", 4)], opts);
    expect(out).toHaveLength(1);
    expect(out[0].lines[0]).toBe("a");
  });

  it("keeps a label whose push-up gap stays within leaderMaxPx", () => {
    // Same setup as above. The first push (to gap 26) still collides with
    // "a" once the minGapPx (2) inflation is applied — box "b"'s inflated
    // bottom edge (260 + 2 = 262) still overlaps box "a"'s top (274) — so a
    // second push is needed, landing "b" at gap 40. leaderMaxPx (45)
    // comfortably covers that, so "b" survives.
    const opts = { ...OPTS, leaderMaxPx: 45 };
    const out = layoutLabels([label(540, 300, "a", 5), label(540, 300, "b", 4)], opts);
    expect(out).toHaveLength(2);
  });

  it("drops a label whose x-clamp overhang would exceed maxOverhangPx instead of drawing a long diagonal leader", () => {
    // Same anchor/geometry as the "clamps the right edge" test: the box is
    // clamped so its centre sits 13px from the anchor. With maxOverhangPx set
    // below that (5), the label must be dropped instead of drawn clamped.
    const right = OPTS.plotLeft + OPTS.plotWidth; // 1040
    const opts = { ...OPTS, maxOverhangPx: 5 };
    const out = layoutLabels([label(right - 5, 300, "7.401", 1)], opts);
    expect(out).toHaveLength(0);
  });

  it("keeps an x-clamped label whose overhang stays within maxOverhangPx", () => {
    const right = OPTS.plotLeft + OPTS.plotWidth; // 1040
    const opts = { ...OPTS, maxOverhangPx: 20 };
    const out = layoutLabels([label(right - 5, 300, "7.401", 1)], opts);
    expect(out).toHaveLength(1);
  });
});