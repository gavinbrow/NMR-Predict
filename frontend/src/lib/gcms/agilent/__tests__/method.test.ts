import { describe, expect, it } from "vitest";
import {
  mergeRunMeta,
  parseAcqMethod,
  parseCnormIni,
  parsePrePostIni,
} from "../method";
import type { RunMeta } from "../../types";

// Fixtures are synthetic but mirror the real `GCMS Example/` files. Each
// fixture is crafted to exercise one of the five bug fixes called out in the
// work-package spec.

// --- Fix #1: ramp table terminates on the first non-4-numeric line, so a
//     later 4-column numeric table (the THERMAL AUX ramp) is NOT swallowed.
// --- Fix #2: "Initial temp:" is scoped to the OVEN section, so the inlet and
//     aux-heater "Initial temp:" values do not collide.
const ACQMETH = `
                           INSTRUMENT CONTROL PARAMETERS:    Instrument #1
                           -----------------------------------------------

   C:\\METHOD\\GavinMethod.M

Control Information
------- -----------
       Sample Inlet : GC

=============================================================================
                                6890 GC METHOD
=============================================================================

OVEN
   Initial temp:  80 'C (On)               Maximum temp:  280 'C
   Initial time:  2.00 min                 Equilibration time:  0.50 min
   Ramps:
      #  Rate  Final temp  Final time
      1 20.00      280       10.00
      2   0.0(Off)
   Post temp:  0 'C
   Post time:  0.00 min
   Run time:  22.00 min

FRONT INLET (SPLIT/SPLITLESS)           BACK INLET (UNKNOWN)
   Mode:  Split
   Initial temp:  250 'C (On)

THERMAL AUX 2
   Use:  MSD Transfer Line Heater
   Initial temp:  280 'C (On)
   Initial time:  0.00 min
      #  Rate  Final temp  Final time
      1   5.0      300       5.00

                                MS ACQUISITION PARAMETERS

Tune File                : pcich07-05-2021-working.U
Acquistion Mode          : Scan

Solvent Delay            : 3.00 min

[Scan Parameters]

Low Mass                 : 50.0
High Mass                : 550.0
Threshold                : 150

[MSZones]

MS Quad                  : 150 C   maximum 200 C
MS Source                : 250 C   maximum 300 C

                              TUNE PARAMETERS for SN: G1030-60697
                        -----------------------------

EMVOLTS     :    1941.176

                           END OF TUNE PARAMETERS
`;

// --- Fix #3: acqmode 2 -> "Scan/SIM" (not "Scan").
// --- Fix #5: CI mode + reagent + multi-segment scan program + threshold.
const PRE_POST = `[POSTRUN]
SOURCE=MS
Date=Tue Jul 21 17:02:23 2026
SmartCard=AGILENT TECHNOLOGIES,5973N,G1030-60697,5.01.90
Serial_N=G1030-60697
acqmode=2
TuneName=pcich07-05-2021-working.U
TuneDate= 5 Jul 2021   4:27 pm
CImode=1
CIpolarity=0
CIflow=20
Reagent=p_methane
SourceTemp=250
QuadTemp=150
[Scan Parameters]
scanstart1=0.00
lowmass1=50.00
highmass1=550.00
scanstart2=5.00
lowmass2=100.00
highmass2=400.00
scanstart3=-1.00
lowmass3=50.00
highmass3=550.00
[Sequence]
_methfile$=GavinMethod.M
_methpath$=C:\\METHOD\\
`;

const CNORM = `[targets]
base=69
masses=5
mass1=50
mass2=131
mass3=219
mass4=414
mass5=502
target1=1
target2=45
target3=55
target4=2.5
target5=2
[atune.cnorm]
masses=5
69=470848
50=10118
131=229952
219=417280
414=39704
502=40768
[stune.cnorm]
masses=5
69=218048
50=2127
131=123888
219=107632
414=7243
502=5681
`;

describe("parseAcqMethod", () => {
  const meta = parseAcqMethod(ACQMETH);

  it("(fix #2) scopes Initial temp to the OVEN section (80, not 250 or 280)", () => {
    expect(meta.ovenInitialTempC).toBe(80);
  });

  it("(fix #1) reads the two oven ramps and does NOT swallow the THERMAL AUX table", () => {
    expect(meta.ovenRamps).toEqual([
      { rate: 20, finalTemp: 280, finalTime: 10 },
    ]);
    // The ramp row "1 5.0 300 5.00" from THERMAL AUX must NOT appear.
    const ramps = meta.ovenRamps ?? [];
    expect(ramps.some((r) => r.rate === 5 && r.finalTemp === 300)).toBe(false);
  });

  it("reads Run time, Solvent Delay, Low/High Mass, Threshold", () => {
    expect(meta.runTimeMin).toBe(22);
    expect(meta.solventDelayMin).toBe(3);
    expect(meta.lowMass).toBe(50);
    expect(meta.highMass).toBe(550);
    expect(meta.threshold).toBe(150);
  });

  it("reads MS Source / MS Quad temperatures", () => {
    expect(meta.sourceTemp).toBe(250);
    expect(meta.quadTemp).toBe(150);
  });

  it("reads the tune file name and instrument serial number", () => {
    expect(meta.tuneFile).toBe("pcich07-05-2021-working.U");
    expect(meta.serialNumber).toBe("G1030-60697");
  });

  it("(fix #4) does NOT extract sample or operator", () => {
    expect(meta.sample).toBeUndefined();
    expect(meta.operator).toBeUndefined();
  });

  it("reads the Acquistion Mode label when present", () => {
    expect(meta.scanMode).toBe("Scan");
  });

  it("never throws on garbage", () => {
    expect(() => parseAcqMethod("")).not.toThrow();
    expect(() => parseAcqMethod("!!!\x00\x01")).not.toThrow();
  });
});

describe("parsePrePostIni", () => {
  const meta = parsePrePostIni(PRE_POST);

  it("(fix #3) maps acqmode 2 -> 'Scan/SIM'", () => {
    expect(meta.scanMode).toBe("Scan/SIM");
  });

  it("(fix #5) sets ionization='CI' and ciReagent when CImode=1", () => {
    expect(meta.ionization).toBe("CI");
    expect(meta.ciReagent).toBe("p_methane");
  });

  it("(fix #5) reads polarity from CIpolarity (0 -> '+')", () => {
    expect(meta.polarity).toBe("+");
  });

  it("(fix #5) builds the multi-segment scan program, dropping -1 segments", () => {
    expect(meta.scanSegments).toEqual([
      { start: 0, lowMass: 50, highMass: 550 },
      { start: 5, lowMass: 100, highMass: 400 },
    ]);
  });

  it("reads instrument + serial from SmartCard/Serial_N", () => {
    expect(meta.instrument).toBe("5973N");
    expect(meta.serialNumber).toBe("G1030-60697");
  });

  it("reads tune file name + date", () => {
    expect(meta.tuneFile).toBe("pcich07-05-2021-working.U");
    expect(meta.tuneDate).toBe("5 Jul 2021   4:27 pm");
  });

  it("reads acquired date and method", () => {
    expect(meta.acquiredDate).toBe("Tue Jul 21 17:02:23 2026");
    expect(meta.method).toBe("GavinMethod.M");
  });

  it("reads SourceTemp/QuadTemp", () => {
    expect(meta.sourceTemp).toBe(250);
    expect(meta.quadTemp).toBe(150);
  });

  it("defaults ionization to EI when CImode is absent", () => {
    const m = parsePrePostIni("[POSTRUN]\nacqmode=0\n");
    expect(m.ionization).toBe("EI");
  });

  it("never throws on garbage", () => {
    expect(() => parsePrePostIni("")).not.toThrow();
    expect(() => parsePrePostIni("!!!\n[oops\n")).not.toThrow();
  });
});

describe("parseCnormIni", () => {
  const tune = parseCnormIni(CNORM);

  it("captures target/atune/stune entries", () => {
    expect(tune.entries).toBeDefined();
    expect(tune.entries!.length).toBeGreaterThan(0);
    const keys = tune.entries!.map((e) => e.key);
    expect(keys).toContain("base");
    expect(keys).toContain("mass1");
    expect(keys.some((k) => k.startsWith("atune:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("stune:"))).toBe(true);
  });

  it("never throws on garbage", () => {
    expect(() => parseCnormIni("")).not.toThrow();
    expect(() => parseCnormIni("[oops\n")).not.toThrow();
  });
});

describe("mergeRunMeta", () => {
  it("later parts win for keys they define; undefined/empty skipped", () => {
    const a: Partial<RunMeta> = { method: "A", operator: "alice", lowMass: 50 };
    const b: Partial<RunMeta> = { method: "B", operator: undefined, sample: "" };
    const c: Partial<RunMeta> = { threshold: 150 };
    const merged = mergeRunMeta(a, b, c);
    expect(merged.method).toBe("B");
    expect(merged.operator).toBe("alice");
    expect(merged.lowMass).toBe(50);
    expect(merged.threshold).toBe(150);
    expect(merged.sample).toBeUndefined();
  });

  it("deep-merges raw and tune sub-objects", () => {
    const a: Partial<RunMeta> = { raw: { acqmeth: "a", prePost: "p1" } };
    const b: Partial<RunMeta> = { raw: { prePost: "p2", cnorm: "c" }, tune: { tuneFile: "t" } };
    const merged = mergeRunMeta(a, b);
    expect(merged.raw).toEqual({ acqmeth: "a", prePost: "p2", cnorm: "c" });
    expect(merged.tune).toEqual({ tuneFile: "t" });
  });

  it("returns an empty object for no parts", () => {
    expect(mergeRunMeta()).toEqual({});
  });
});