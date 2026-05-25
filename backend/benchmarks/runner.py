"""Benchmark runner — run one engine over the dataset and collect per-group
prediction errors plus wall-clock timing.

Composes the public engine interface only (``get_engine``, ``engine.predict``,
``engine.is_ready``) and the app's canonicalizer; it does not import engine
internals.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from statistics import fmean
from typing import Dict, List, Optional

from app.chem.canonical import InvalidSmilesError, canonicalize
from app.engines import engine_is_implemented, get_engine

from benchmarks.dataset import Dataset, ReferenceMolecule, resolve_reference_atoms


def _now() -> str:
    """Wall-clock HH:MM:SS stamp for progress lines."""
    return time.strftime("%H:%M:%S")


def _fmt_secs(seconds: float) -> str:
    """Human-friendly elapsed time (e.g. ``4.2s``, ``3m12.0s``, ``1h04m``)."""
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, sec = divmod(seconds, 60)
    if minutes < 60:
        return f"{int(minutes)}m{sec:04.1f}s"
    hours, minutes = divmod(int(minutes), 60)
    return f"{hours}h{int(minutes):02d}m"


@dataclass(frozen=True)
class DataPoint:
    """One scored (predicted, reference) pair for a reference group."""

    engine: str
    nucleus: str
    molecule_id: str
    scenario: str
    group_smarts: str
    reference_ppm: float
    predicted_ppm: float
    n_atoms: int
    exchangeable: bool

    @property
    def error(self) -> float:
        return self.predicted_ppm - self.reference_ppm

    @property
    def abs_error(self) -> float:
        return abs(self.predicted_ppm - self.reference_ppm)


@dataclass(frozen=True)
class MoleculeRun:
    """Outcome of running the engine on one molecule for one nucleus."""

    molecule_id: str
    nucleus: str
    status: str  # "ok" | "skipped" | "error"
    seconds: float
    message: Optional[str] = None


@dataclass
class BenchmarkResult:
    engine: str
    # Optional level-of-theory tag, used by the ORCA sweep.
    functional: Optional[str] = None
    basis: Optional[str] = None
    points: List[DataPoint] = field(default_factory=list)
    runs: List[MoleculeRun] = field(default_factory=list)

    @property
    def label(self) -> str:
        if self.functional and self.basis:
            return f"{self.engine} [{self.functional}/{self.basis}]"
        return self.engine

    def total_seconds(self) -> float:
        return sum(r.seconds for r in self.runs)


def _predicted_by_index(shifts) -> Dict[int, float]:
    return {s.atom_index: s.shift_ppm for s in shifts}


def run_engine(
    engine_name: str,
    dataset: Dataset,
    nuclei: List[str],
    *,
    conformer_strategy: str = "fast",
    skip_unready: bool = True,
    exclude_exchangeable: bool = False,
    functional: Optional[str] = None,
    basis: Optional[str] = None,
    progress: bool = False,
) -> BenchmarkResult:
    """Run ``engine_name`` over ``dataset`` for each nucleus in ``nuclei``.

    - Engines that are not implemented or not ready are recorded as ``skipped``
      molecule runs (never raised) when ``skip_unready`` is True.
    - Per-molecule prediction errors (or exceptions) are captured; one failing
      molecule does not abort the run.
    - ``functional`` / ``basis`` are recorded for reporting only — the caller is
      responsible for having set ``settings.orca_*`` before calling.
    """
    result = BenchmarkResult(engine=engine_name, functional=functional, basis=basis)

    if not engine_is_implemented(engine_name):
        if progress:
            print(
                f"[{_now()}] {engine_name}: not implemented - skipping all molecules",
                flush=True,
            )
        for mol in dataset.molecules:
            for nucleus in nuclei:
                result.runs.append(
                    MoleculeRun(mol.id, nucleus, "skipped", 0.0, "engine not implemented")
                )
        return result

    engine = get_engine(engine_name)
    ready, reason = engine.is_ready()
    if not ready:
        if not skip_unready:
            raise RuntimeError(f"engine {engine_name!r} not ready: {reason}")
        if progress:
            print(
                f"[{_now()}] {engine_name}: not ready ({reason}) - skipping all molecules",
                flush=True,
            )
        for mol in dataset.molecules:
            for nucleus in nuclei:
                result.runs.append(
                    MoleculeRun(mol.id, nucleus, "skipped", 0.0, f"not ready: {reason}")
                )
        return result

    work = [
        (mol, nucleus)
        for mol in dataset.molecules
        for nucleus in nuclei
        if nucleus in mol.shifts
    ]
    total = len(work)
    if progress:
        print(
            f"[{_now()}] {engine_name}: {total} (molecule, nucleus) run(s) to do",
            flush=True,
        )
    engine_start = time.perf_counter()
    for index, (mol, nucleus) in enumerate(work, start=1):
        _run_one(
            engine_name=engine_name,
            engine=engine,
            mol=mol,
            nucleus=nucleus,
            conformer_strategy=conformer_strategy,
            exclude_exchangeable=exclude_exchangeable,
            result=result,
            progress=progress,
            index=index,
            total=total,
        )

    if progress:
        ok = sum(1 for r in result.runs if r.status == "ok")
        err = sum(1 for r in result.runs if r.status == "error")
        skipped = sum(1 for r in result.runs if r.status == "skipped")
        print(
            f"[{_now()}] {engine_name}: done in "
            f"{_fmt_secs(time.perf_counter() - engine_start)} - "
            f"{ok} ok, {err} error, {skipped} skipped",
            flush=True,
        )

    return result


def _run_one(
    *,
    engine_name: str,
    engine,
    mol: ReferenceMolecule,
    nucleus: str,
    conformer_strategy: str,
    exclude_exchangeable: bool,
    result: BenchmarkResult,
    progress: bool,
    index: int = 0,
    total: int = 0,
) -> None:
    tag = f"[{index}/{total}] " if total else ""

    def _log(msg: str) -> None:
        if progress:
            print(f"[{_now()}] {tag}{engine_name} | {mol.id} {nucleus} | {msg}", flush=True)

    _log("predicting ...")

    try:
        canon = canonicalize(mol.smiles, add_hs=True)
    except InvalidSmilesError as exc:
        result.runs.append(MoleculeRun(mol.id, nucleus, "error", 0.0, f"canon: {exc}"))
        _log(f"ERROR - canon: {exc}")
        return

    start = time.perf_counter()
    try:
        shifts = engine.predict(
            canon.mol, nucleus, conformer_strategy=conformer_strategy
        )
    except Exception as exc:  # engine-specific errors are intentionally broad here
        elapsed = time.perf_counter() - start
        result.runs.append(
            MoleculeRun(mol.id, nucleus, "error", elapsed, f"{type(exc).__name__}: {exc}")
        )
        _log(f"ERROR in {_fmt_secs(elapsed)} - {type(exc).__name__}: {exc}")
        return
    elapsed = time.perf_counter() - start

    n_before = len(result.points)
    pred = _predicted_by_index(shifts)
    matched_any = False
    for ref in mol.shifts[nucleus]:
        if exclude_exchangeable and ref.exchangeable:
            continue
        atom_indices = resolve_reference_atoms(canon.mol, ref.group_smarts, nucleus)
        predicted_vals = [pred[i] for i in atom_indices if i in pred]
        if not predicted_vals:
            continue  # engine returned nothing for this group; not counted as error
        matched_any = True
        result.points.append(
            DataPoint(
                engine=engine_name,
                nucleus=nucleus,
                molecule_id=mol.id,
                scenario=mol.scenario,
                group_smarts=ref.group_smarts,
                reference_ppm=ref.ppm,
                predicted_ppm=fmean(predicted_vals),
                n_atoms=len(predicted_vals),
                exchangeable=ref.exchangeable,
            )
        )

    status = "ok" if matched_any else "error"
    message = None if matched_any else "no reference groups matched predicted atoms"
    result.runs.append(MoleculeRun(mol.id, nucleus, status, elapsed, message))

    added = result.points[n_before:]
    if status == "ok" and added:
        mae = fmean(p.abs_error for p in added)
        max_err = max(p.abs_error for p in added)
        _log(
            f"OK in {_fmt_secs(elapsed)} - MAE {mae:.2f} max {max_err:.2f} ppm "
            f"(n={len(added)})"
        )
    else:
        _log(f"ERROR in {_fmt_secs(elapsed)} - {message}")
