import { describe, expect, it } from "vitest";
import { isMgf, parseMgf } from "../mgf";

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe("isMgf", () => {
  it("detects BEGIN IONS in the first 4 KB", () => {
    expect(isMgf(new TextEncoder().encode("BEGIN IONS\n..."))).toBe(true);
    expect(isMgf(new TextEncoder().encode("just text"))).toBe(false);
  });
});

describe("parseMgf", () => {
  it("preserves three BEGIN IONS blocks as three scans with TITLE/PEPMASS/RTINSECONDS/CHARGE", () => {
    const text = [
      "BEGIN IONS",
      "TITLE=scan A",
      "PEPMASS=500.1 1200",
      "CHARGE=2+",
      "RTINSECONDS=60",
      "100.5 5",
      "200.25 10",
      "300.0 2",
      "END IONS",
      "BEGIN IONS",
      "TITLE=scan B",
      "PEPMASS=600.2",
      "RTINSECONDS=120",
      "50.0 1",
      "150.0 4",
      "END IONS",
      "BEGIN IONS",
      "TITLE=scan C",
      "PEPMASS=700.3 9",
      "RTINSECONDS=180",
      "80.0 8",
      "END IONS",
    ].join("\n");
    const run = parseMgf(text, { name: "s.mgf" });
    expect(run.format).toBe("mgf");
    expect(run.scanCount).toBe(3);
    // RT in minutes
    expect(Array.from(run.rtMin)).toEqual([1, 2, 3]);
    // scan 0 points
    expect(Array.from(run.mz.subarray(run.scanOffset[0], run.scanOffset[1]))).toEqual([100.5, 200.25, 300.0]);
    expect(Array.from(run.intensity.subarray(run.scanOffset[0], run.scanOffset[1]))).toEqual([5, 10, 2]);
    // scan 1 points
    expect(Array.from(run.mz.subarray(run.scanOffset[1], run.scanOffset[2]))).toEqual([50.0, 150.0]);
    // scan 2 points
    expect(Array.from(run.mz.subarray(run.scanOffset[2], run.scanOffset[3]))).toEqual([80.0]);
    // msLevel defaults to 2
    expect(run.msLevel[0]).toBe(2);
  });

  it("warns when a block has no RTINSECONDS and uses the block index as rtMin", () => {
    const text = [
      "BEGIN IONS",
      "TITLE=no-rt block",
      "PEPMASS=400",
      "100.0 1",
      "END IONS",
      "BEGIN IONS",
      "TITLE=with rt",
      "PEPMASS=500",
      "RTINSECONDS=120",
      "200.0 2",
      "END IONS",
    ].join("\n");
    const run = parseMgf(text);
    expect(run.scanCount).toBe(2);
    expect(run.rtMin[0]).toBe(0); // block index 0
    expect(run.rtMin[1]).toBe(2); // 120 seconds / 60
    expect(run.warnings.some((w) => /no RTINSECONDS/.test(w))).toBe(true);
  });

  it("ignores blank and comment lines (#, ;, !, /)", () => {
    const text = [
      "BEGIN IONS",
      "PEPMASS=500",
      "# a comment",
      "; semicolon comment",
      "! bang comment",
      "// slash comment",
      "",
      "100.0 1",
      "200.0 2",
      "END IONS",
    ].join("\n");
    const run = parseMgf(text);
    expect(run.scanCount).toBe(1);
    expect(Array.from(run.mz)).toEqual([100.0, 200.0]);
  });

  it("returns an empty valid run when there are no BEGIN IONS blocks", () => {
    const run = parseMgf("just some text\nno ions here");
    expect(run.scanCount).toBe(0);
    expect(run.scanOffset.length).toBe(1);
    expect(run.warnings.length).toBeGreaterThan(0);
  });
});