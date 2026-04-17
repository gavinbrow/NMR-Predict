"""ORCA engine — DFT NMR chemical-shift prediction via subprocess.

Runs the ORCA binary for each prediction. The current defaults target
speed over accuracy:

    ! PBE def2-SVP NMR TightSCF

All of ``functional``, ``basis``, ``cpus``, ``ram_mb``, and the ORCA
executable path are read from :mod:`app.config.settings` and can be
overridden per-deployment via the ``ORCA_*`` environment variables.

Conformer generation is selectable per request via
``conformer_strategy`` (forwarded from :class:`PredictRequest`):

* ``"fast"`` — RDKit ETKDG + MMFF; the lowest-energy of 50 conformers
  is fed straight into the NMR calc. Sub-second overhead. Default.
* ``"goat"`` — ORCA XTB2 GOAT global conformer search. Minutes of
  overhead but finds the global minimum across rotatable bonds.

Chemical shieldings are converted to δ ppm via TMS reference values
computed automatically at the same (functional, basis) on first use
and cached to ``{orca_work_dir}/tms_refs.json``. Subsequent predictions
at the same level of theory read the cached value instead of rerunning
TMS.

All ORCA invocations go through a single-worker thread queue so
concurrent ``/predict`` calls don't contend for the binary (each ORCA
job already saturates CPUs via ``%pal``). The queue hands back a
``concurrent.futures.Future`` — a hard per-job timeout can be bolted on
later by passing ``timeout=`` to ``.result()`` (and killing the
subprocess from the runner side).
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Dict, List, Optional

from rdkit import Chem
from rdkit.Chem import AllChem

from app.config import settings
from app.engines.base import Engine
from app.schemas import AtomShift

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------
# Exceptions and constants
# ---------------------------------------------------------------------

class OrcaEngineError(RuntimeError):
    """Raised on ORCA setup, subprocess, or output-parsing failures."""


_TMS_SMILES = "C[Si](C)(C)C"
_NUCLEUS_TO_Z = {"1H": 1, "13C": 6}
_NUCLEUS_TO_SYMBOL = {"1H": "H", "13C": "C"}


# ---------------------------------------------------------------------
# Single-worker job queue — all ORCA subprocess calls go through this.
# ---------------------------------------------------------------------

_job_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="orca-worker")


def submit_orca_job(fn: Callable[[], object]) -> Future:
    """Enqueue *fn* onto the shared single-worker ORCA executor.

    Callers typically block on ``.result()``. To add a hard timeout
    later, pass ``timeout=`` there — today the subprocess keeps running
    even if the future is abandoned, so a real kill-switch in
    :func:`_run_orca` would also be needed.
    """
    return _job_executor.submit(fn)


# ---------------------------------------------------------------------
# ORCA subprocess runner
# ---------------------------------------------------------------------

def _orca_work_root() -> Path:
    root = Path(settings.orca_work_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _run_orca(inp_text: str, base: str, subdir: str) -> Path:
    """Write *inp_text* into a fresh job directory and run ORCA there.

    Returns the path to the resulting ``.out`` file. Raises
    :class:`OrcaEngineError` on a non-zero exit code or when ORCA did
    not print the "TERMINATED NORMALLY" banner.
    """
    orca_exe = Path(settings.orca_exe)
    if not orca_exe.is_file():
        raise OrcaEngineError(
            f"ORCA binary not found at {orca_exe}. "
            "Set ORCA_EXE to a valid path to enable the ORCA engine."
        )

    job_dir = _orca_work_root() / subdir
    job_dir.mkdir(parents=True, exist_ok=True)

    inp_path = job_dir / f"{base}.inp"
    out_path = job_dir / f"{base}.out"
    err_path = job_dir / f"{base}.err"

    inp_path.write_text(inp_text, encoding="utf-8")

    env = os.environ.copy()
    tmpdir = job_dir / "_tmp"
    tmpdir.mkdir(exist_ok=True)
    env["TMPDIR"] = str(tmpdir)
    env["TEMP"] = str(tmpdir)
    env["TMP"] = str(tmpdir)

    creationflags = 0
    if sys.platform == "win32":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    with out_path.open("wb") as fout, err_path.open("wb") as ferr:
        proc = subprocess.run(
            [str(orca_exe), inp_path.name],
            cwd=str(job_dir),
            stdout=fout,
            stderr=ferr,
            env=env,
            shell=False,
            creationflags=creationflags,
        )

    # Fold stderr into .out for post-mortem inspection, then discard.
    try:
        if err_path.exists() and err_path.stat().st_size > 0:
            with out_path.open("ab") as fout, err_path.open("rb") as ferr:
                fout.write(b"\n--- stderr ---\n")
                fout.write(ferr.read())
        err_path.unlink(missing_ok=True)
    except OSError:
        pass

    out_text = out_path.read_text(errors="replace")
    if proc.returncode != 0 or "ORCA TERMINATED NORMALLY" not in out_text:
        tail = "\n".join(out_text.splitlines()[-40:])
        raise OrcaEngineError(
            f"ORCA job {base!r} failed (rc={proc.returncode}). "
            f"Tail of {out_path}:\n{tail}"
        )

    return out_path


# ---------------------------------------------------------------------
# ORCA input generation
# ---------------------------------------------------------------------

def _mol_xyz_block(mol: Chem.Mol, conf_id: int = -1) -> str:
    conf = mol.GetConformer(conf_id)
    lines = []
    for i, atom in enumerate(mol.GetAtoms()):
        pos = conf.GetAtomPosition(i)
        lines.append(
            f"  {atom.GetSymbol():2s}  {pos.x:14.8f}  {pos.y:14.8f}  {pos.z:14.8f}"
        )
    return "\n".join(lines)


def _build_nmr_input(
    xyz_block: str,
    charge: int,
    multiplicity: int,
    functional: str,
    basis: str,
    cpus: int,
    ram_mb: int,
) -> str:
    return "\n".join([
        f"! {functional} {basis} NMR TightSCF",
        "",
        f"%maxcore {ram_mb}",
        "%pal",
        f"  nprocs {cpus}",
        "end",
        "",
        f"* xyz {charge} {multiplicity}",
        xyz_block,
        "*",
        "",
    ])


def _build_goat_input(
    xyz_block: str, charge: int, multiplicity: int, cpus: int, ram_mb: int,
) -> str:
    return "\n".join([
        "! XTB2 GOAT",
        "",
        f"%maxcore {ram_mb}",
        "%pal",
        f"  nprocs {cpus}",
        "end",
        "",
        "%goat",
        f"  NWorkers {cpus}",
        "end",
        "",
        f"* xyz {charge} {multiplicity}",
        xyz_block,
        "*",
        "",
    ])


# ---------------------------------------------------------------------
# ORCA output parsing
# ---------------------------------------------------------------------

_NUCLEUS_HEADER_RE = re.compile(
    r"^\s*Nucleus\s*:?\s*(\d+)\s*([A-Z][a-z]?)\s*:?\s*$"
)
_ISOTROPIC_RE = re.compile(
    r"^\s*(?:Total\s+)?[Ii]sotropic\s+shielding\s*[:=]\s*(-?\d+\.\d+)"
)
_TABLE_ROW_RE = re.compile(
    r"^\s*(\d+)\s+([A-Z][a-z]?)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$"
)


def parse_shieldings(out_text: str) -> Dict[int, float]:
    """Extract ``{atom_index: isotropic_shielding_ppm}`` from ORCA output.

    ORCA prints chemical shieldings in two places: a per-atom block
    ("Nucleus  0 C: ... isotropic shielding = ...") and a summary
    table at the end of the section. This parser tries the per-atom
    form first (most robust across versions) and falls back to the
    table if nothing was matched. Atom indices are 0-based.
    """
    shieldings: Dict[int, float] = {}

    current_idx: Optional[int] = None
    for line in out_text.splitlines():
        m = _NUCLEUS_HEADER_RE.match(line)
        if m:
            current_idx = int(m.group(1))
            continue
        if current_idx is not None:
            m = _ISOTROPIC_RE.match(line)
            if m:
                shieldings[current_idx] = float(m.group(1))
                current_idx = None

    if shieldings:
        return shieldings

    in_nmr_section = False
    for line in out_text.splitlines():
        upper = line.upper()
        if "CHEMICAL SHIELDING" in upper or "CHEMICAL SHIFT" in upper:
            in_nmr_section = True
            continue
        if in_nmr_section:
            m = _TABLE_ROW_RE.match(line)
            if m:
                shieldings[int(m.group(1))] = float(m.group(3))

    return shieldings


def _parse_goat_globalmin_xyz(path: Path) -> str:
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    if len(lines) < 3:
        raise OrcaEngineError(f"GOAT globalminimum file malformed: {path}")
    coord_lines: List[str] = []
    for line in lines[2:]:
        parts = line.split()
        if len(parts) >= 4:
            elem = parts[0]
            x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
            coord_lines.append(f"  {elem:2s}  {x:14.8f}  {y:14.8f}  {z:14.8f}")
    if not coord_lines:
        raise OrcaEngineError(
            f"GOAT globalminimum file contained no coordinates: {path}"
        )
    return "\n".join(coord_lines)


# ---------------------------------------------------------------------
# TMS reference (σ_TMS) computation + on-disk cache
# ---------------------------------------------------------------------

_tms_lock = threading.Lock()


def _tms_cache_path() -> Path:
    return _orca_work_root() / "tms_refs.json"


def _tms_cache_key(functional: str, basis: str) -> str:
    return f"{functional.strip().lower()}|{basis.strip().lower()}"


def _load_tms_cache() -> dict:
    path = _tms_cache_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("TMS cache at %s unreadable; starting fresh", path)
        return {}


def _save_tms_cache(cache: dict) -> None:
    path = _tms_cache_path()
    try:
        path.write_text(json.dumps(cache, indent=2), encoding="utf-8")
    except OSError as exc:
        logger.warning("Failed to write TMS cache at %s: %s", path, exc)


def _build_tms_mol() -> Chem.Mol:
    mol = Chem.MolFromSmiles(_TMS_SMILES)
    mol = Chem.AddHs(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = 0xC0FFEE
    if AllChem.EmbedMolecule(mol, params) == -1:
        raise OrcaEngineError("Failed to embed TMS reference molecule")
    try:
        AllChem.MMFFOptimizeMolecule(mol, maxIters=500)
    except Exception:
        AllChem.UFFOptimizeMolecule(mol, maxIters=500)
    return mol


def _compute_tms_reference(functional: str, basis: str) -> Dict[str, float]:
    logger.info(
        "Computing TMS reference at %s/%s (first-time)", functional, basis,
    )
    mol = _build_tms_mol()
    xyz = _mol_xyz_block(mol)
    inp_text = _build_nmr_input(
        xyz,
        charge=0,
        multiplicity=1,
        functional=functional,
        basis=basis,
        cpus=settings.orca_cpus,
        ram_mb=settings.orca_ram_mb,
    )
    stamp = uuid.uuid4().hex[:8]
    safe_key = re.sub(r"[^A-Za-z0-9._-]+", "_", _tms_cache_key(functional, basis))
    out_path = _run_orca(
        inp_text,
        base="tms",
        subdir=f"tms_{safe_key}_{stamp}",
    )
    shieldings = parse_shieldings(out_path.read_text(errors="replace"))

    h_vals: List[float] = []
    c_vals: List[float] = []
    for idx, atom in enumerate(mol.GetAtoms()):
        sigma = shieldings.get(idx)
        if sigma is None:
            continue
        z = atom.GetAtomicNum()
        if z == 1:
            h_vals.append(sigma)
        elif z == 6:
            c_vals.append(sigma)

    if not h_vals or not c_vals:
        raise OrcaEngineError(
            f"TMS reference calc returned incomplete shieldings "
            f"(H={len(h_vals)}, C={len(c_vals)}). Check {out_path}."
        )

    return {
        "1H": sum(h_vals) / len(h_vals),
        "13C": sum(c_vals) / len(c_vals),
    }


def _get_tms_reference(functional: str, basis: str) -> Dict[str, float]:
    key = _tms_cache_key(functional, basis)
    with _tms_lock:
        cache = _load_tms_cache()
        if key in cache:
            return cache[key]
        refs = _compute_tms_reference(functional, basis)
        cache[key] = refs
        _save_tms_cache(cache)
        return refs


# ---------------------------------------------------------------------
# Conformer strategies
# ---------------------------------------------------------------------

def _fast_conformer_xyz(mol: Chem.Mol) -> str:
    """RDKit ETKDG (50 confs) + MMFF; return XYZ of the lowest-energy one.

    The caller's mol is not mutated — a copy is embedded.
    """
    work = Chem.Mol(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = 42
    params.numThreads = 0
    conf_ids = list(AllChem.EmbedMultipleConfs(work, numConfs=50, params=params))
    if not conf_ids:
        if AllChem.EmbedMolecule(work, randomSeed=42) == -1:
            raise OrcaEngineError("ETKDG failed to embed any conformer")
        conf_ids = [0]

    try:
        results = AllChem.MMFFOptimizeMoleculeConfs(work, maxIters=2000)
    except Exception:
        results = None

    best_cid = conf_ids[0]
    if results is not None:
        best_energy = float("inf")
        for cid, (conv, energy) in zip(conf_ids, results):
            if conv == -1:
                continue
            if energy < best_energy:
                best_energy = energy
                best_cid = cid

    return _mol_xyz_block(work, conf_id=best_cid)


def _goat_conformer_xyz(mol: Chem.Mol, charge: int, multiplicity: int) -> str:
    """ORCA XTB2 GOAT global conformer search; return XYZ of the global min.

    A fast RDKit geometry is used as the GOAT seed.
    """
    seed_xyz = _fast_conformer_xyz(mol)
    inp_text = _build_goat_input(
        seed_xyz,
        charge=charge,
        multiplicity=multiplicity,
        cpus=settings.orca_cpus,
        ram_mb=settings.orca_ram_mb,
    )
    stamp = uuid.uuid4().hex[:8]
    out_path = _run_orca(inp_text, base="goat", subdir=f"goat_{stamp}")
    gmin = out_path.parent / f"{out_path.stem}.globalminimum.xyz"
    if not gmin.exists():
        raise OrcaEngineError(
            f"GOAT completed but no globalminimum.xyz was written in {out_path.parent}"
        )
    return _parse_goat_globalmin_xyz(gmin)


# ---------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------

class OrcaEngine(Engine):
    name = "orca"
    default_weight = 0.2

    def is_ready(self):
        exe = settings.orca_exe
        if not exe:
            return False, "ORCA_EXE not set"
        if not Path(exe).is_file():
            return False, f"ORCA binary not found: {exe}"
        return True, None

    def predict(
        self, mol: Chem.Mol, nucleus: str, **options
    ) -> List[AtomShift]:
        if nucleus not in _NUCLEUS_TO_Z:
            raise OrcaEngineError(f"Unsupported nucleus: {nucleus!r}")

        strategy = options.get("conformer_strategy", "fast")
        if strategy not in ("fast", "goat"):
            raise OrcaEngineError(
                f"Unknown conformer_strategy: {strategy!r} (expected 'fast' or 'goat')"
            )

        functional = settings.orca_functional
        basis = settings.orca_basis
        charge = Chem.GetFormalCharge(mol)
        radicals = sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms())
        multiplicity = radicals + 1

        # Queue the TMS reference lookup first so the worker picks it up
        # before the sample job. If the cache is warm, this returns fast.
        tms_future = submit_orca_job(
            lambda: _get_tms_reference(functional, basis)
        )

        if strategy == "fast":
            # Pure RDKit, no subprocess — run inline and save a queue hop.
            xyz_block = _fast_conformer_xyz(mol)
        else:
            goat_future = submit_orca_job(
                lambda: _goat_conformer_xyz(mol, charge, multiplicity)
            )
            xyz_block = goat_future.result()

        def _run_sample() -> Dict[int, float]:
            inp_text = _build_nmr_input(
                xyz_block,
                charge=charge,
                multiplicity=multiplicity,
                functional=functional,
                basis=basis,
                cpus=settings.orca_cpus,
                ram_mb=settings.orca_ram_mb,
            )
            stamp = uuid.uuid4().hex[:8]
            out_path = _run_orca(inp_text, base="sample", subdir=f"sample_{stamp}")
            return parse_shieldings(out_path.read_text(errors="replace"))

        sample_future = submit_orca_job(_run_sample)

        tms_ref = tms_future.result()
        shieldings = sample_future.result()

        target_z = _NUCLEUS_TO_Z[nucleus]
        target_sym = _NUCLEUS_TO_SYMBOL[nucleus]
        ref_sigma = tms_ref[nucleus]

        shifts: List[AtomShift] = []
        for idx, atom in enumerate(mol.GetAtoms()):
            if atom.GetAtomicNum() != target_z:
                continue
            sigma = shieldings.get(idx)
            if sigma is None:
                raise OrcaEngineError(
                    f"ORCA did not emit an isotropic shielding for atom "
                    f"{idx} ({target_sym})"
                )
            shifts.append(AtomShift(
                atom_index=idx,
                symbol=target_sym,
                shift_ppm=ref_sigma - sigma,
                confidence=None,
            ))
        return shifts


orca_engine = OrcaEngine()
