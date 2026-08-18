import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { centroidProfile } from "../centroid";
import {
  applyCalibration,
  decodeWatersText,
  parseCalCoefficients,
  parseWatersExtern,
  parseWatersHeader,
  parseWatersIndex,
  parseWatersRaw,
  type WatersRawBundle,
} from "../waters/masslynx";

// ---------------------------------------------------------------------------
// Unit tests — no fixture needed
// ---------------------------------------------------------------------------

describe("parseWatersHeader", () => {
  it("splits on the FIRST colon so paths and times survive", () => {
    const h = parseWatersHeader(
      "$$ Acquired Name: 6169_DAC_3\r\n$$ Cal Time: 13:37\r\n$$ MS Method: D:\\Projects\\x.EXP\r\n",
    );
    expect(h.get("Acquired Name")).toBe("6169_DAC_3");
    expect(h.get("Cal Time")).toBe("13:37");
    expect(h.get("MS Method")).toBe("D:\\Projects\\x.EXP");
  });
});

describe("parseWatersExtern", () => {
  it("splits the tune page from each function's own block", () => {
    const { global, functions } = parseWatersExtern(
      [
        "Polarity\t\t\tES+",
        "Capillary (kV)\t\t\t3.0000",
        "Function Parameters - Function 1 - TOF MS FUNCTION",
        "Start Mass\t\t\t100.0",
        "Data Format\t\t\tContinuum",
        "Function Parameters - Function 2 - REFERENCE",
        "Start Mass\t\t\t50.0",
        "Data Format\t\t\tCentroid",
      ].join("\r\n"),
    );
    expect(global.get("Polarity")).toBe("ES+");
    expect(functions.get(1)?.type).toBe("TOF MS FUNCTION");
    expect(functions.get(1)?.params.get("Start Mass")).toBe("100.0");
    expect(functions.get(2)?.type).toBe("REFERENCE");
    expect(functions.get(2)?.params.get("Data Format")).toBe("Centroid");
  });
});

describe("parseCalCoefficients", () => {
  it("stops at the trailing type token", () => {
    expect(parseCalCoefficients("1.0e0,2.0e0,3.0e0,T1")).toEqual([1, 2, 3]);
    expect(parseCalCoefficients(undefined)).toBeNull();
    expect(parseCalCoefficients("T1")).toBeNull();
  });

  it("applies as (SUM ci * sqrt(m)**i)**2, so an identity polynomial is a no-op", () => {
    expect(applyCalibration(556.2771, [0, 1])).toBeCloseTo(556.2771, 9);
  });
});

describe("centroidProfile", () => {
  it("reports the intensity-weighted centroid and the peak AREA", () => {
    // Symmetric triangle centred on 100.02: centroid is the centre, area the sum.
    const mz = [100.0, 100.01, 100.02, 100.03, 100.04];
    const it_ = [1, 5, 10, 5, 1];
    const peaks = centroidProfile(mz, it_);
    expect(peaks).toHaveLength(1);
    expect(peaks[0].mz).toBeCloseTo(100.02, 10);
    expect(peaks[0].intensity).toBe(22);
  });

  it("splits merged shoulders at the local minimum instead of merging them", () => {
    const mz = [200.0, 200.01, 200.02, 200.03, 200.04, 200.05, 200.06];
    const it_ = [1, 8, 2, 1, 3, 9, 2];
    const peaks = centroidProfile(mz, it_);
    expect(peaks).toHaveLength(2);
    expect(peaks[0].mz).toBeLessThan(200.03);
    expect(peaks[1].mz).toBeGreaterThan(200.03);
  });

  it("drops peaks under relThreshold, measured on area", () => {
    const mz = [300.0, 300.01, 300.02, 300.03, 300.04, 300.05];
    const it_ = [10, 100, 10, 0, 1, 1];
    expect(centroidProfile(mz, it_)).toHaveLength(2);
    expect(centroidProfile(mz, it_, { relThreshold: 0.1 })).toHaveLength(1);
  });

  it("returns nothing for an empty or all-zero scan", () => {
    expect(centroidProfile([], [])).toEqual([]);
    expect(centroidProfile([1, 2, 3], [0, 0, 0])).toEqual([]);
  });
});

describe("parseWatersIndex", () => {
  it("rejects a .DAT length that no supported point size divides", () => {
    // One record, 30 bytes, claiming 10 points; 7 bytes of data divides by none.
    const idx = new ArrayBuffer(30);
    new DataView(idx).setUint32(4, 10, true);
    expect(parseWatersIndex(idx, 7)).toBeNull();
  });

  it("picks the point size that divides the .DAT exactly", () => {
    const idx = new ArrayBuffer(30);
    const dv = new DataView(idx);
    dv.setUint32(4, 10, true);
    dv.setFloat32(8, 1234, true);
    dv.setFloat32(12, 0.5, true);
    const parsed = parseWatersIndex(idx, 80);
    expect(parsed?.bytesPerPoint).toBe(8);
    expect(parsed?.entries[0].pointCount).toBe(10);
    expect(parsed?.entries[0].rtMin).toBeCloseTo(0.5, 6);
    expect(parseWatersIndex(idx, 120)?.bytesPerPoint).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Acceptance test against a real SYNAPT XS acquisition.
//
// The fixture is a 32 MB continuum `.raw` folder kept out of the repo; the
// suite skips when it is absent. Expected values come from the vendor's own
// processed PDF of the same acquisition (scan 11, RT 0.242 min):
// base peak m/z 337.2858 at 1.80e6.
// ---------------------------------------------------------------------------

const RAW_DIR = resolve(__dirname, "../../../../../Test HRMS/6169_DAC_3.raw/6169_DAC_3.raw");
const present = existsSync(resolve(RAW_DIR, "_FUNC001.DAT"));

function ab(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function bundle(): WatersRawBundle {
  return {
    folderName: "6169_DAC_3.raw",
    sourcePath: "6169_DAC_3.raw",
    headerTxt: decodeWatersText(ab(resolve(RAW_DIR, "_HEADER.TXT"))),
    externInf: decodeWatersText(ab(resolve(RAW_DIR, "_extern.inf"))),
    functnsInf: ab(resolve(RAW_DIR, "_FUNCTNS.INF")),
    functions: new Map([
      [1, { idx: ab(resolve(RAW_DIR, "_FUNC001.IDX")), dat: ab(resolve(RAW_DIR, "_FUNC001.DAT")) }],
      [2, { idx: ab(resolve(RAW_DIR, "_FUNC002.IDX")), dat: ab(resolve(RAW_DIR, "_FUNC002.DAT")) }],
    ]),
  };
}

describe.skipIf(!present)("real Waters SYNAPT XS .raw folder", () => {
  it("decodes both functions with the vendor's own m/z and intensities", () => {
    const { runs, errors } = parseWatersRaw(bundle());
    expect(errors).toEqual([]);
    expect(runs).toHaveLength(2);

    const [fn1, fn2] = runs;
    expect(fn1.scanCount).toBe(50);
    expect(fn2.scanCount).toBe(7);
    expect(fn1.format).toBe("waters-raw");
    expect(fn1.meta.ionization).toBe("ESI");
    expect(fn1.meta.polarity).toBe("+");
    expect(fn1.meta.instrument).toBe("SYNAPT-XS#DBC325");
    expect(fn1.meta.scanMode).toBe("TOF MS FUNCTION");

    // The decoded m/z axis lands on the method's stated 100..1000 range.
    expect(fn1.mzRange[0]).toBeGreaterThan(99.9);
    expect(fn1.mzRange[0]).toBeLessThan(101);
    expect(fn1.mzRange[1]).toBeGreaterThan(999);
    expect(fn1.mzRange[1]).toBeLessThan(1000.1);

    // Scan 11 in MassLynx's 1-based numbering is index 10.
    const scan = 10;
    expect(fn1.rtMin[scan]).toBeCloseTo(0.2423, 3);

    // Base peak: vendor reports m/z 337.2858 at 1.80e6. Centroiding must
    // reproduce both — the m/z to a few ppm and the intensity as peak AREA.
    expect(fn1.basePeakMz[scan]).toBeGreaterThan(337.283);
    expect(fn1.basePeakMz[scan]).toBeLessThan(337.289);
    expect(fn1.basePeakIntensity[scan]).toBeGreaterThan(1.79e6);
    expect(fn1.basePeakIntensity[scan]).toBeLessThan(1.81e6);

    // Centroiding conserves area, so a scan's points still sum to its TIC.
    let sum = 0;
    for (let i = fn1.scanOffset[scan]; i < fn1.scanOffset[scan + 1]; i += 1) {
      sum += fn1.intensity[i];
    }
    expect(sum / fn1.tic[scan]).toBeCloseTo(1, 2);

    // m/z ascends within every scan — the invariant the view layer relies on.
    // Counted rather than asserted per point: this run has ~10^6 points and an
    // expect() per point takes longer than the whole suite's timeout.
    let descents = 0;
    for (let s = 0; s < fn1.scanCount; s += 1) {
      for (let i = fn1.scanOffset[s] + 1; i < fn1.scanOffset[s + 1]; i += 1) {
        if (fn1.mz[i] < fn1.mz[i - 1]) descents += 1;
      }
    }
    expect(descents).toBe(0);

    // Function 2 is the lockspray REFERENCE: already centroided, and its masses
    // are NOT flagged calibrated, so the Cal Function polynomial must be
    // applied. Leucine enkephalin's 556.2771 lands within the lockspray
    // correction the vendor applies separately (~35 ppm) rather than the
    // ~475 ppm the uncalibrated value would be off by.
    expect(fn2.meta.scanMode).toBe("REFERENCE");
    let best = 0;
    for (let i = fn2.scanOffset[0]; i < fn2.scanOffset[1]; i += 1) {
      if (fn2.intensity[i] > fn2.intensity[best]) best = i;
    }
    expect(fn2.mz[best]).toBeGreaterThan(556.2);
    expect(fn2.mz[best]).toBeLessThan(556.32);
  });

  it("keeps the full profile when centroiding is turned off", () => {
    const { runs } = parseWatersRaw(bundle(), { centroid: false });
    const fn1 = runs[0];
    // 32,537,464 bytes / 8 bytes per point.
    expect(fn1.pointCount).toBe(4_067_183);

    // Profile intensities sum to the index TIC on EVERY scan, to within the f32
    // precision the TIC itself is stored at. This is the decode's sharpest
    // check: the elution scans (4-8) carry saturating peaks whose flag bits sit
    // directly above the intensity exponent, and reading those bits as exponent
    // inflates a single point to ~1e46 while leaving every other scan correct.
    let worst = 0;
    for (let s = 0; s < fn1.scanCount; s += 1) {
      let sum = 0;
      for (let i = fn1.scanOffset[s]; i < fn1.scanOffset[s + 1]; i += 1) {
        sum += fn1.intensity[i];
      }
      worst = Math.max(worst, Math.abs(sum - fn1.tic[s]) / fn1.tic[s]);
    }
    expect(worst).toBeLessThan(1e-3);

    // Nothing decoded to a non-finite intensity (the symptom of that bug).
    expect(fn1.basePeakIntensity.every((v) => Number.isFinite(v))).toBe(true);
    // Peak intensity across the run stays in the range the vendor reports.
    expect(Math.max(...fn1.basePeakIntensity)).toBeLessThan(1e9);
  });

  it("centroiding shrinks the run and conserves the total signal", () => {
    const profile = parseWatersRaw(bundle(), { centroid: false }).runs[0];
    const centroided = parseWatersRaw(bundle(), { centroid: true }).runs[0];

    // ~4x on this acquisition. The default keeps every peak, noise included, so
    // the reduction is the profile's points-per-peak, not a threshold's doing.
    expect(centroided.pointCount).toBeLessThan(profile.pointCount / 3);
    expect(centroided.scanCount).toBe(profile.scanCount);

    // Centroiding is area-preserving: only lone single-sample spikes (which
    // cannot form a peak) are lost, so >99% of the signal must survive.
    const sumOf = (r: typeof profile) => {
      let s = 0;
      for (let i = 0; i < r.intensity.length; i += 1) s += r.intensity[i];
      return s;
    };
    expect(sumOf(centroided) / sumOf(profile)).toBeGreaterThan(0.99);
  });
});
