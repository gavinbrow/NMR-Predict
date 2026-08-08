import { describe, expect, it } from "vitest";
import { buildMaldiFigureData, type MaldiFigureFile } from "../figure";
import type { Peak, SpectrumData } from "../types";

function spectrum(mz: number[], intensity: number[]): SpectrumData {
  return { mz: Float64Array.from(mz), intensity: Float64Array.from(intensity) };
}

function peak(id: string, mz: number, intensity: number, extra: Partial<Peak> = {}): Peak {
  return { id, mz, intensity, ...extra };
}

/** The primary file, with whatever peaks/ladders a case needs layered on. */
function primary(over: Partial<MaldiFigureFile> = {}): MaldiFigureFile {
  return {
    id: "active",
    name: "sample A",
    spectrum: spectrum([100, 200, 300], [10, 20, 30]),
    peaks: [],
    ...over,
  };
}

describe("buildMaldiFigureData", () => {
  it("emits a profile line series on the spectrum's own m/z grid", () => {
    const data = buildMaldiFigureData({
      files: [primary()],
      showProfile: true,
      showSticks: false,
      labelPeaks: false,
      sourceName: "sample A",
    });
    expect(data.series).toHaveLength(1);
    const profile = data.series[0];
    expect(profile.id).toBe("profile:active");
    expect(profile.x).toEqual([100, 200, 300]);
    expect(profile.y).toEqual([10, 20, 30]);
    expect(profile.styleHints?.kind).toBe("line");
    expect(data.xLabel).toBe("m/z");
    expect(data.yLabel).toBe("Intensity");
    expect(data.reversedX).toBe(false);
  });

  it("adds a stick series and m/z labels from the peaks (centroid preferred)", () => {
    const peaks = [peak("p1", 150, 5, { centroid: 150.05 }), peak("p2", 250, 8)];
    const data = buildMaldiFigureData({
      files: [primary({ peaks })],
      showProfile: true,
      showSticks: true,
      labelPeaks: true,
      sourceName: "sample A",
    });
    const sticks = data.series.find((s) => s.id === "sticks");
    expect(sticks).toBeDefined();
    expect(sticks?.styleHints?.kind).toBe("sticks");
    expect(sticks?.x).toEqual([150.05, 250]); // centroid used when present
    expect(sticks?.y).toEqual([5, 8]);

    expect(data.peakLabels).toHaveLength(2);
    expect(data.peakLabels?.[0]).toMatchObject({ id: "p1", x: 150.05, y: 5, text: "150.05" });
    expect(data.peakLabels?.[1]).toMatchObject({ id: "p2", x: 250, y: 8, text: "250.00" });
  });

  it("omits the profile and/or sticks when their flags are off", () => {
    const data = buildMaldiFigureData({
      files: [primary({ peaks: [peak("p1", 150, 5)] })],
      showProfile: false,
      showSticks: false,
      labelPeaks: false,
      sourceName: "sample A",
    });
    expect(data.series).toHaveLength(0);
    expect(data.peakLabels).toEqual([]);
  });

  it("always supplies peakLabels (possibly empty) so the labels controls appear", () => {
    const data = buildMaldiFigureData({
      files: [primary()],
      showProfile: true,
      showSticks: false,
      labelPeaks: true,
      sourceName: "sample A",
    });
    expect(data.peakLabels).toEqual([]);
    expect(data.peakLabels).not.toBeUndefined();
  });

  it("falls back to a 'maldi' download stem when the name is blank", () => {
    const data = buildMaldiFigureData({
      files: [primary()],
      showProfile: true,
      showSticks: false,
      labelPeaks: false,
      sourceName: "",
    });
    expect(data.sourceName).toBe("maldi");
  });

  it("takes the host's y-axis label when it supplies one (normalised traces)", () => {
    const data = buildMaldiFigureData({
      files: [primary()],
      showProfile: true,
      showSticks: false,
      labelPeaks: false,
      sourceName: "x",
      yLabel: "Rel. intensity (%)",
    });
    expect(data.yLabel).toBe("Rel. intensity (%)");
  });

  it("emits one stick series per group with stable ids + ladder colours, and no unassigned when every peak is grouped", () => {
    const peaks = [peak("p1", 100, 10), peak("p2", 200, 20), peak("p3", 300, 30)];
    const data = buildMaldiFigureData({
      files: [
        primary({
          peaks,
          seriesGroups: [
            { id: "sA", label: "[M+H]+", color: "#111111", peakIds: new Set(["p1", "p2"]) },
            { id: "sB", label: "[M+Na]+", color: "#222222", peakIds: new Set(["p3"]) },
          ],
        }),
      ],
      showProfile: false,
      showSticks: true,
      labelPeaks: true,
      sourceName: "x",
    });
    const stickA = data.series.find((s) => s.id === "sticks:sA");
    const stickB = data.series.find((s) => s.id === "sticks:sB");
    expect(stickA?.styleHints).toMatchObject({ kind: "sticks", color: "#111111" });
    expect(stickA?.x).toEqual([100, 200]);
    expect(stickB?.styleHints?.color).toBe("#222222");
    expect(stickB?.x).toEqual([300]);
    // Every peak belongs to a group → no unassigned bucket.
    expect(data.series.find((s) => s.id === "sticks:unassigned")).toBeUndefined();
    // Labels carry the owning group's series id (drives "colour labels by series").
    expect(data.peakLabels?.find((l) => l.id === "p1")?.seriesId).toBe("sticks:sA");
    expect(data.peakLabels?.find((l) => l.id === "p3")?.seriesId).toBe("sticks:sB");
  });

  it("claims a peak shared by two groups for the first in array order, and buckets ungrouped peaks as 'sticks:unassigned'", () => {
    const peaks = [peak("shared", 100, 10), peak("only", 200, 20), peak("loose", 300, 30)];
    const data = buildMaldiFigureData({
      files: [
        primary({
          peaks,
          // Caller passes groups in precedence order (confirmed first, then score);
          // "shared" is in both, so the first group (sA) claims it.
          seriesGroups: [
            { id: "sA", label: "A", color: "#aaaaaa", peakIds: new Set(["shared", "only"]) },
            { id: "sB", label: "B", color: "#bbbbbb", peakIds: new Set(["shared"]) },
          ],
        }),
      ],
      showProfile: false,
      showSticks: true,
      labelPeaks: true,
      sourceName: "x",
    });
    expect(data.series.find((s) => s.id === "sticks:sA")?.x).toEqual([100, 200]);
    // sB's only member was claimed by sA → empty group → no series emitted.
    expect(data.series.find((s) => s.id === "sticks:sB")).toBeUndefined();
    expect(data.peakLabels?.find((l) => l.id === "shared")?.seriesId).toBe("sticks:sA");
    // "loose" is in no group → unassigned sticks, and its label has no seriesId.
    expect(data.series.find((s) => s.id === "sticks:unassigned")?.x).toEqual([300]);
    expect(data.peakLabels?.find((l) => l.id === "loose")?.seriesId).toBeUndefined();
  });

  it("passes Peak.color / Peak.label straight through to the labels", () => {
    const peaks = [peak("p1", 150, 5, { color: "#ff0000", label: "M+H" }), peak("p2", 250, 8)];
    const data = buildMaldiFigureData({
      files: [primary({ peaks })],
      showProfile: false,
      showSticks: false,
      labelPeaks: true,
      sourceName: "x",
    });
    // A user label wins verbatim and is marked custom so Decimals can't reformat it.
    expect(data.peakLabels?.find((l) => l.id === "p1")).toMatchObject({
      text: "M+H",
      customText: true,
      color: "#ff0000",
    });
    // No label/colour → m/z fallback, and neither flag is set.
    const l2 = data.peakLabels?.find((l) => l.id === "p2");
    expect(l2?.text).toBe("250.00");
    expect(l2?.customText).toBeUndefined();
    expect(l2?.color).toBeUndefined();
  });

  it("splits sticks by Peak.color so an individually-coloured peak keeps its colour", () => {
    // The shared renderer strokes a whole stick series one colour, so a coloured
    // peak must live in its own series. The uncoloured peaks stay in "sticks".
    const peaks = [peak("p1", 150, 5, { color: "#ff0000" }), peak("p2", 250, 8)];
    const data = buildMaldiFigureData({
      files: [primary({ peaks })],
      showProfile: false,
      showSticks: true,
      labelPeaks: false,
      sourceName: "x",
    });
    const red = data.series.find((s) => s.styleHints?.color === "#ff0000");
    expect(red?.x).toEqual([150]);
    expect(data.series.find((s) => s.id === "sticks")?.x).toEqual([250]);
  });

  it("emits the base colour first and keeps the colour split out of the legend", () => {
    // The recoloured peak comes FIRST in the list, so only an explicit ordering
    // puts the ladder's own series ahead of its one-off colour split.
    const peaks = [peak("p1", 150, 5, { color: "#ff0000" }), peak("p2", 250, 8)];
    const data = buildMaldiFigureData({
      files: [
        primary({
          peaks,
          seriesGroups: [
            { id: "sA", label: "ladder A", color: "#111111", peakIds: new Set(["p1", "p2"]) },
          ],
        }),
      ],
      showProfile: false,
      showSticks: true,
      labelPeaks: false,
      sourceName: "x",
    });
    expect(data.series.map((s) => s.id)).toEqual(["sticks:sA", "sticks:sA:c:#ff0000"]);
    // Only the ladder keys the legend; the split would just repeat its name.
    expect(data.series[0].legendHidden).toBeUndefined();
    expect(data.series[1].legendHidden).toBe(true);
  });

  it("leaves a single-file figure ungrouped and on the neutral dark trace", () => {
    // The Documents panel always holds a colour, but recolouring a lone
    // spectrum's trace magenta because of it would be a surprise.
    const data = buildMaldiFigureData({
      files: [primary({ color: "#d946ef", peaks: [peak("p1", 150, 5)] })],
      showProfile: true,
      showSticks: true,
      labelPeaks: false,
      sourceName: "x",
    });
    expect(data.series.find((s) => s.id === "profile:active")?.styleHints?.color).toBe("#1e293b");
    expect(data.series.find((s) => s.id === "sticks")?.styleHints?.color).toBe("#0ea5e9");
    expect(data.series.every((s) => s.group === undefined)).toBe(true);
  });
});

describe("buildMaldiFigureData — cross-file", () => {
  /** Two files, each with its own trace, peaks and one ladder. */
  function twoFiles(over: Partial<MaldiFigureFile> = {}): MaldiFigureFile[] {
    return [
      primary({
        color: "#d946ef",
        peaks: [peak("a1", 100, 10), peak("a2", 200, 20)],
        seriesGroups: [
          { id: "sA", label: "[M+Na]+ · 44 Da", color: "#d946ef", peakIds: new Set(["a1", "a2"]) },
        ],
        ...over,
      }),
      {
        id: "doc2",
        name: "sample B",
        color: "#0ea5e9",
        spectrum: spectrum([100, 400], [1, 2]),
        peaks: [peak("b1", 150, 4)],
        seriesGroups: [
          { id: "sB", label: "[M+Na]+ · 44 Da", color: "#22c55e", peakIds: new Set(["b1"]) },
        ],
      },
    ];
  }

  it("draws every file's trace, sticks and labels, primary first and one file at a time", () => {
    const data = buildMaldiFigureData({
      files: twoFiles(),
      showProfile: true,
      showSticks: true,
      labelPeaks: true,
      sourceName: "x",
    });
    // Each file's series are contiguous — the controls section by adjacent run,
    // and the legend reads file by file rather than traces-then-ladders.
    expect(data.series.map((s) => s.id)).toEqual([
      "profile:active",
      "sticks:sA",
      "profile:doc2",
      "sticks:sB",
    ]);
    expect(data.peakLabels?.map((l) => l.id)).toEqual(["a1", "a2", "b1"]);
    // The shared x grid stays the primary's m/z.
    expect(data.x).toEqual([100, 200, 300]);
  });

  it("gives each file its document colour and tags every series with the file name", () => {
    const data = buildMaldiFigureData({
      files: twoFiles(),
      showProfile: true,
      showSticks: true,
      labelPeaks: false,
      sourceName: "x",
    });
    const byId = new Map(data.series.map((s) => [s.id, s]));
    // Traces take the document's own colour, so the figure matches the plot.
    expect(byId.get("profile:active")?.styleHints?.color).toBe("#d946ef");
    expect(byId.get("profile:doc2")?.styleHints?.color).toBe("#0ea5e9");
    // Ladders keep their own colours (a file can hold several polymers).
    expect(byId.get("sticks:sB")?.styleHints?.color).toBe("#22c55e");
    // The group is what sections the maker's Series controls by file.
    expect(byId.get("profile:active")?.group).toBe("sample A");
    expect(byId.get("sticks:sB")?.group).toBe("sample B");
  });

  it("prefixes legend labels with the file name so identically-named ladders stay apart", () => {
    const data = buildMaldiFigureData({
      files: twoFiles(),
      showProfile: false,
      showSticks: true,
      labelPeaks: false,
      sourceName: "x",
    });
    expect(data.series.map((s) => s.label)).toEqual([
      "sample A · [M+Na]+ · 44 Da",
      "sample B · [M+Na]+ · 44 Da",
    ]);
  });

  it("applies each file's scale and offset to its trace, sticks and label anchors", () => {
    const [a, b] = twoFiles();
    const data = buildMaldiFigureData({
      files: [
        { ...a, scale: 10, offset: 0 },
        { ...b, scale: 50, offset: 100 },
      ],
      showProfile: true,
      showSticks: true,
      labelPeaks: true,
      sourceName: "x",
    });
    const byId = new Map(data.series.map((s) => [s.id, s]));
    expect(byId.get("profile:active")?.y).toEqual([100, 200, 300]);
    expect(byId.get("profile:doc2")?.y).toEqual([150, 200]); // 1*50+100, 2*50+100
    expect(byId.get("sticks:sB")?.y).toEqual([300]); // 4*50+100
    // Stems grow from their own file's baseline, not from zero.
    expect(byId.get("sticks:sA")?.baseline).toBeUndefined();
    expect(byId.get("sticks:sB")?.baseline).toBe(100);
    // The label anchor is transformed too, but it is ranked by the peak's OWN
    // intensity so an offset file can't monopolise the label budget.
    const b1 = data.peakLabels?.find((l) => l.id === "b1");
    expect(b1?.y).toBe(300);
    expect(b1?.priority).toBe(4);
  });

  it("keeps each file's unassigned peaks in their own bucket, in the file colour", () => {
    const [a, b] = twoFiles();
    const data = buildMaldiFigureData({
      files: [
        { ...a, peaks: [...a.peaks, peak("aLoose", 500, 3)] },
        { ...b, peaks: [...b.peaks, peak("bLoose", 600, 7)] },
      ],
      showProfile: false,
      showSticks: true,
      labelPeaks: false,
      sourceName: "x",
    });
    const byId = new Map(data.series.map((s) => [s.id, s]));
    // The primary keeps the legacy id; later files qualify theirs.
    expect(byId.get("sticks:unassigned")?.x).toEqual([500]);
    expect(byId.get("sticks:unassigned:doc2")?.x).toEqual([600]);
    // Nothing owns these peaks, so the file colour is what identifies them.
    expect(byId.get("sticks:unassigned")?.styleHints?.color).toBe("#d946ef");
    expect(byId.get("sticks:unassigned:doc2")?.styleHints?.color).toBe("#0ea5e9");
  });

  it("collapses a file with no ladders into one series named after it", () => {
    const [a, b] = twoFiles();
    const data = buildMaldiFigureData({
      files: [{ ...a, seriesGroups: [] }, b],
      showProfile: false,
      showSticks: true,
      labelPeaks: false,
      sourceName: "x",
    });
    const plain = data.series.find((s) => s.id === "sticks");
    expect(plain?.label).toBe("sample A");
    expect(plain?.x).toEqual([100, 200]);
    // Its neighbour still splits by ladder — grouping is per file, not global.
    expect(data.series.find((s) => s.id === "sticks:sB")).toBeDefined();
  });

  it("emits nothing for a file whose peaks were all filtered out", () => {
    const [a, b] = twoFiles();
    const data = buildMaldiFigureData({
      files: [a, { ...b, peaks: [] }],
      showProfile: false,
      showSticks: true,
      labelPeaks: true,
      sourceName: "x",
    });
    expect(data.series.map((s) => s.id)).toEqual(["sticks:sA"]);
    expect(data.peakLabels?.map((l) => l.id)).toEqual(["a1", "a2"]);
  });
});
