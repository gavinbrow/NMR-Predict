// Heuristic interpretation summary.
//
// The to-do lists "AI-assisted explanation" as a later goal, but this workspace
// is strictly client-side with no backend or cloud LLM (a hard project
// constraint), so this module produces a transparent, rule-based narrative
// instead: it turns the detected repeat units, series, end groups and
// MALDI-apparent molecular weights into plain-language findings, each with a
// confidence cue and the appropriate caveats. It asserts nothing it can't back
// with the numbers already computed.

import { adductById } from "./adducts";
import { matchRepeatUnit } from "./repeatLibrary";
import type { EndGroupCandidate } from "./endgroups";
import type { MolWeightStats } from "./molweight";
import type { RepeatCandidate } from "./polymers";
import type { Adduct, Peak, Series } from "./types";

export type FindingTone = "info" | "good" | "warn";

export interface Finding {
  tone: FindingTone;
  text: string;
}

export interface InterpretationInput {
  peaks: Peak[];
  series: Series[];
  adducts: Adduct[];
  repeatCandidates?: RepeatCandidate[];
  endGroupCandidates?: EndGroupCandidate[];
  molWeight?: MolWeightStats | null;
  /**
   * Every repeat unit the analyst currently has in play. A sample containing two
   * polymers carries one entry per polymer, and each is looked up in the repeat
   * library on its own — reporting only the dominant detected spacing left the
   * second polymer unnamed.
   */
  repeatMasses?: number[];
}

/** A repeat unit and one of `repeatMasses` are the same when they agree to the
 *  precision the detector and the Series panel round to. */
const REPEAT_TOL = 0.005;

/** Build a rule-based interpretation of the current analysis state. */
export function interpretSpectrum(input: InterpretationInput): Finding[] {
  const findings: Finding[] = [];
  const { peaks, series, adducts } = input;

  const analyte = peaks.filter(
    (p) => p.accepted !== false && !p.ignored && p.flag !== "isotope",
  );
  const flagged = peaks.filter((p) => p.flag && p.flag !== "isotope" && p.flag !== "shoulder");

  findings.push({
    tone: "info",
    text: `${analyte.length} analyte peaks picked${
      flagged.length ? ` · ${flagged.length} flagged as matrix/salt/contaminant background` : ""
    }.`,
  });

  // Repeat units. What the analyst has in play wins over what the detector
  // guessed: once repeat units are selected, each gets its own library lookup and
  // its own line, so a sample read as two polymers names both. The detected
  // spacings are reported only while nothing has been selected yet.
  const active = (input.repeatMasses ?? []).filter((m) => Number.isFinite(m) && m > 0);
  const topRepeat = input.repeatCandidates?.[0];
  if (active.length > 0) {
    for (const [i, mass] of active.entries()) {
      const match = matchRepeatUnit(mass);
      // Superseded readings are the SAME ladder seen through another adduct, so
      // counting them would report a two-polymer sample as six series. Every
      // other view hides them; the count follows suit.
      const own = series.filter(
        (s) => !s.supersededBy && Math.abs(s.repeatMass - mass) <= REPEAT_TOL,
      );
      const memberCount = own.reduce((n, s) => n + s.members.length, 0);
      findings.push({
        tone: match ? "good" : "info",
        text: `${
          active.length > 1 ? `Repeat unit ${i + 1} of ${active.length}` : "Repeat unit"
        } ≈ ${mass.toFixed(3)} Da${
          match
            ? `, consistent with ${match.name}${match.formula ? ` (${match.formula})` : ""}`
            : " (no library match)"
        }${
          own.length
            ? ` — ${own.length} assigned series, ${memberCount} peaks.`
            : " — no series assigned to it yet."
        }`,
      });
    }
    if (active.length > 1) {
      findings.push({
        tone: "info",
        text: `${active.length} repeat units are in play, so the sample is being read as more than one polymer — check that each ladder's end group and adduct belong to the repeat unit it was assigned under.`,
      });
    }
  } else if (topRepeat) {
    const match = matchRepeatUnit(topRepeat.repeatMass);
    findings.push({
      tone: "good",
      text: `Dominant repeat spacing ≈ ${topRepeat.repeatMass.toFixed(3)} Da${
        match
          ? `, consistent with ${match.name}${match.formula ? ` (${match.formula})` : ""}`
          : " (no library match)"
      }.`,
    });
    if (input.repeatCandidates && input.repeatCandidates.length > 1) {
      const second = input.repeatCandidates[1];
      if (second.score > 0.5) {
        findings.push({
          tone: "info",
          text: `A second spacing ≈ ${second.repeatMass.toFixed(3)} Da is also present — possible copolymer or a competing adduct ladder.`,
        });
      }
    }
  } else {
    findings.push({ tone: "warn", text: "No clear repeating spacing detected — sample may not be a homopolymer, or peaks are too sparse." });
  }

  // Series.
  if (series.length > 0) {
    const best = [...series].sort((a, b) => b.score - a.score)[0];
    const adductLabel = adductById(adducts, best.adductId).label;
    const longest = bestRun(best);
    findings.push({
      tone: best.score >= 0.5 ? "good" : "warn",
      text: `Best oligomer series: ${adductLabel}, ${best.members.length} members (longest run ${longest}), end-group residual ${best.endGroupMass.toFixed(2)} Da, fit error ${(best.meanErrorDa ?? 0).toFixed(3)} Da, score ${Math.round(best.score * 100)}%.`,
    });
    const adductIds = new Set(series.map((s) => s.adductId));
    if (adductIds.size > 1) {
      findings.push({
        tone: "info",
        text: `Multiple adduct series detected (${[...adductIds].map((id) => adductById(adducts, id).label).join(", ")}) — the same polymer is ionizing with more than one cation.`,
      });
    }
    if (longest < 4) {
      findings.push({ tone: "warn", text: "The longest consecutive run is short (<4); treat the series assignment as tentative." });
    }
  } else if (topRepeat) {
    findings.push({ tone: "warn", text: "A repeat spacing was found but no series could be assigned — check the selected adducts." });
  }

  // End groups.
  const topEnd = input.endGroupCandidates?.find((c) => c.libraryMatch) ?? input.endGroupCandidates?.[0];
  if (topEnd) {
    findings.push({
      tone: topEnd.libraryMatch ? "good" : "info",
      text: `End-group residual ≈ ${topEnd.residualMass.toFixed(3)} Da${
        topEnd.libraryMatch ? ` matches ${topEnd.libraryMatch}` : " (no library match)"
      } across ${topEnd.matchedOligomers} oligomers (${Math.round(topEnd.confidence * 100)}% confidence).`,
    });
  }

  // Molecular weight.
  if (input.molWeight && input.molWeight.count > 0) {
    const mw = input.molWeight;
    findings.push({
      tone: "info",
      text: `MALDI-apparent Mn ≈ ${mw.mn.toFixed(0)}, Mw ≈ ${mw.mw.toFixed(0)}, Đ ≈ ${mw.dispersity.toFixed(3)} (${mw.massBasis} basis, ${mw.count} peaks). Intensities are not quantitative — treat as indicative only.`,
    });
  }

  findings.push({
    tone: "info",
    text: "This summary is generated by deterministic rules from the values above — not an external/AI model — and is meant to guide, not replace, expert review.",
  });

  return findings;
}

function bestRun(series: Series): number {
  const ns = series.members.map((m) => m.n).sort((a, b) => a - b);
  let best = ns.length ? 1 : 0;
  let run = 1;
  for (let i = 1; i < ns.length; i += 1) {
    run = ns[i] === ns[i - 1] + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}
