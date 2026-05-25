"""ORCA functional/basis level-of-theory sweep.

Walks a cheap -> expensive ladder of ``(functional, basis)`` levels. For each
level it temporarily sets ``settings.orca_functional`` / ``settings.orca_basis``
(read by :meth:`OrcaEngine.predict` at call time, so no backend restart is
needed), optionally warms the TMS reference cache once (timed separately), runs
the chosen molecules, and records accuracy vs. wall-clock cost.

Speed estimates in :data:`LADDER` are *relative*, for a ~10-heavy-atom molecule
on ~8 cores. Absolute time depends heavily on molecule size, ``ORCA_CPUS`` and
``ORCA_RAM_MB``. DFT-GIAO NMR cost rises steeply with basis size (~N^3-N^4 in
basis functions) and hybrids add exact-exchange cost over the equivalent GGA.
"""
from __future__ import annotations

import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import List, Optional, Sequence

from app.config import settings

from benchmarks.dataset import Dataset
from benchmarks.runner import BenchmarkResult, _fmt_secs, _now, run_engine


@dataclass(frozen=True)
class Level:
    n: int
    functional: str
    basis: str
    rel_speed: str
    pros: str
    cons: str


# Cheap -> expensive. Numbers are stable selectors for the CLI (--levels 1 2 3).
LADDER: List[Level] = [
    Level(
        1, "PBE", "def2-SVP", "seconds (current default)",
        "Cheapest; fast TMS; fine for nonpolar sp3 trends.",
        "SVP too small for quantitative shifts; GGA underestimates deshielding; "
        "weak for aromatics/carbonyls.",
    ),
    Level(
        2, "TPSS", "def2-SVP", "~seconds-1 min",
        "Meta-GGA; modestly better 13C than PBE at ~same cost.",
        "Still SVP-limited; not quantitative.",
    ),
    Level(
        3, "B97-D3", "def2-TZVP", "~1-5 min",
        "Dispersion-corrected GGA + triple-zeta; good geometry/cost balance.",
        "GGA shielding still trails hybrids for sp2/carbonyl C.",
    ),
    Level(
        4, "PBE0", "def2-TZVP", "~5-20 min",
        "Hybrid + TZ; the standard 'good enough' for 1H/13C; reliable across scenarios.",
        "Exact exchange ~3-10x the GGA cost.",
    ),
    Level(
        5, "B3LYP", "pcSseg-1", "~5-20 min",
        "Jensen NMR-optimized basis tuned for shieldings; strong accuracy/cost.",
        "pcSseg-1 still small; B3LYP geometry ideally wants dispersion.",
    ),
    Level(
        6, "B3LYP", "pcSseg-2", "~20-90 min",
        "Best accuracy-per-cost sweet spot for routine 1H/13C.",
        "Noticeably slower; RAM-hungry (set ORCA_RAM_MB >= 4000).",
    ),
]

_LEVELS_BY_N = {lvl.n: lvl for lvl in LADDER}


def levels_for(numbers: Optional[Sequence[int]]) -> List[Level]:
    """Resolve level numbers to :class:`Level` objects (all, if None)."""
    if not numbers:
        return list(LADDER)
    out = []
    for n in numbers:
        if n not in _LEVELS_BY_N:
            raise ValueError(f"unknown level {n} (valid: {sorted(_LEVELS_BY_N)})")
        out.append(_LEVELS_BY_N[n])
    return out


@contextmanager
def _orca_level(functional: str, basis: str):
    """Temporarily set ORCA functional/basis, restoring afterward."""
    prev_func = settings.orca_functional
    prev_basis = settings.orca_basis
    settings.orca_functional = functional
    settings.orca_basis = basis
    try:
        yield
    finally:
        settings.orca_functional = prev_func
        settings.orca_basis = prev_basis


def _warm_tms(functional: str, basis: str) -> float:
    """Compute/load the TMS reference for this level; return seconds spent.

    Returns 0.0 if ORCA internals can't be imported (e.g. ORCA not installed) —
    the subsequent predict calls will surface the real error per molecule.
    """
    try:
        from app.engines.orca import _get_tms_reference
    except Exception:
        return 0.0
    start = time.perf_counter()
    try:
        _get_tms_reference(functional, basis)
    except Exception:
        # Leave it to per-molecule runs to record the failure.
        pass
    return time.perf_counter() - start


def run_sweep(
    dataset: Dataset,
    nuclei: List[str],
    levels: Sequence[Level],
    *,
    conformer_strategy: str = "fast",
    warm_tms: bool = True,
    progress: bool = True,
) -> List[BenchmarkResult]:
    """Run the ORCA engine over ``dataset`` at each level of theory.

    Returns one :class:`BenchmarkResult` per level (tagged with functional/basis
    so the report renders one row per level).
    """
    results: List[BenchmarkResult] = []
    sweep_start = time.perf_counter()
    for i, lvl in enumerate(levels, start=1):
        if progress:
            print(
                f"\n[{_now()}] == Level {lvl.n} ({i}/{len(levels)}): "
                f"{lvl.functional}/{lvl.basis} (rel. speed: {lvl.rel_speed}) ==",
                flush=True,
            )
        level_start = time.perf_counter()
        with _orca_level(lvl.functional, lvl.basis):
            tms_seconds = _warm_tms(lvl.functional, lvl.basis) if warm_tms else 0.0
            if progress and warm_tms:
                print(f"[{_now()}]    TMS reference warm: {_fmt_secs(tms_seconds)}", flush=True)
            result = run_engine(
                "orca",
                dataset,
                nuclei,
                conformer_strategy=conformer_strategy,
                skip_unready=True,
                functional=lvl.functional,
                basis=lvl.basis,
                progress=progress,
            )
        results.append(result)
        if progress:
            ok = sum(1 for r in result.runs if r.status == "ok")
            err = sum(1 for r in result.runs if r.status == "error")
            print(
                f"[{_now()}] -- Level {lvl.n} done in "
                f"{_fmt_secs(time.perf_counter() - level_start)} - {ok} ok, {err} error --",
                flush=True,
            )
    if progress:
        print(
            f"\n[{_now()}] Sweep complete: {len(levels)} level(s) in "
            f"{_fmt_secs(time.perf_counter() - sweep_start)}",
            flush=True,
        )
    return results


def render_ladder_markdown() -> str:
    """The static cheap->expensive reference table (pros/cons, no run needed)."""
    lines = [
        "# ORCA level-of-theory ladder (cheap -> expensive)",
        "",
        "Relative speeds are for a ~10-heavy-atom molecule on ~8 cores. DFT-GIAO "
        "NMR cost scales ~N^3-N^4 in basis functions; hybrids add exact-exchange "
        "cost over the equivalent GGA. The TMS reference is computed once per "
        "level and cached.",
        "",
        "| # | Functional | Basis | Rel. speed | Pros | Cons |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for lvl in LADDER:
        lines.append(
            f"| {lvl.n} | {lvl.functional} | {lvl.basis} | {lvl.rel_speed} | "
            f"{lvl.pros} | {lvl.cons} |"
        )
    lines.append("")
    lines.append("## Engine cost ladder (cross-engine)")
    lines.append("")
    lines.append("| Engine | Rel. speed | Pros | Cons |")
    lines.append("| --- | --- | --- | --- |")
    lines.append(
        "| `cdk` | ms | Instant; reliable for common environments in its training "
        "DB | HOSE-code lookup -> poor on novel environments; no 3D/conformer effects |"
    )
    lines.append(
        "| `cascade` | ~1-10 s | No DFT; captures 3D/conformer effects; good general "
        "13C/1H | ML — degrades outside training distribution; needs model assets |"
    )
    lines.append(
        "| `orca` | seconds -> hours | Physics-based; tunable accuracy; arbitrary "
        "chemistry | Slow; gas-phase by default; serialized single-worker queue |"
    )
    lines.append("")
    return "\n".join(lines)
