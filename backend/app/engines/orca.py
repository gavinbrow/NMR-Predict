"""ORCA engine - DFT NMR chemical-shift prediction via subprocess."""
from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional

from rdkit import Chem
from rdkit.Chem import AllChem

from app.config import settings
from app.engines.base import Engine
from app.schemas import AtomShift

logger = logging.getLogger(__name__)


class OrcaEngineError(RuntimeError):
    """Raised on ORCA setup, subprocess, or output-parsing failures."""


_TMS_SMILES = "C[Si](C)(C)C"
_NUCLEUS_TO_Z = {"1H": 1, "13C": 6}
_NUCLEUS_TO_SYMBOL = {"1H": "H", "13C": "C"}

_job_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="orca-worker")
_pending_request_slots = threading.BoundedSemaphore(
    max(1, settings.orca_max_pending_requests)
)


@dataclass(frozen=True)
class _OrcaJobResult:
    job_dir: Path
    out_path: Path
    out_text: str


def submit_orca_job(fn: Callable[[], object]) -> Future:
    return _job_executor.submit(fn)


@contextmanager
def _orca_request_slot():
    acquired = _pending_request_slots.acquire(blocking=False)
    if not acquired:
        raise OrcaEngineError("ORCA queue is full. Try again later.")
    try:
        yield
    finally:
        _pending_request_slots.release()


def _orca_work_root() -> Path:
    root = Path(settings.orca_work_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _orca_timeout_seconds() -> int:
    return max(30, int(settings.orca_timeout_seconds))


def _clamped_orca_resources(atom_count: Optional[int] = None) -> tuple[int, int]:
    host_cpus = os.cpu_count() or 1
    cpus = max(1, min(int(settings.orca_cpus), host_cpus))
    # ORCA parallelises several steps -- notably the per-atom NMR CP-SCF -- by
    # handing each MPI rank a slice of the atoms. If nprocs exceeds the atom
    # count the surplus ranks get no work and the parallel module
    # (orca_leanscf_mpi / the NMR property step) aborts ("process exited
    # without calling finalize") or deadlocks on a collective, which hangs the
    # whole request until ORCA_TIMEOUT. Never launch more ranks than atoms.
    if atom_count is not None and atom_count > 0:
        cpus = min(cpus, atom_count)
    ram_ceiling = max(256, int(settings.orca_ram_ceiling_mb))
    ram_mb = max(256, min(int(settings.orca_ram_mb), ram_ceiling))
    return cpus, ram_mb


def _prune_old_orca_job_dirs() -> None:
    ttl_seconds = max(60, int(settings.orca_job_ttl_seconds))
    cutoff = time.time() - ttl_seconds
    root = _orca_work_root()
    for path in root.iterdir():
        if not path.is_dir():
            continue
        try:
            if path.stat().st_mtime >= cutoff:
                continue
        except OSError:
            continue
        try:
            shutil.rmtree(path, ignore_errors=True)
        except OSError as exc:
            logger.warning("Failed to prune ORCA work dir %s: %s", path, exc)


def _cleanup_job_dir(job_dir: Path) -> None:
    try:
        shutil.rmtree(job_dir, ignore_errors=True)
    except OSError as exc:
        logger.warning("Failed to clean ORCA job dir %s: %s", job_dir, exc)


def _terminate_process_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return

    if sys.platform == "win32":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            proc.kill()

    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def _run_orca(inp_text: str, base: str, subdir: str) -> _OrcaJobResult:
    """Write *inp_text* into a fresh job directory and run ORCA there."""

    orca_exe = Path(settings.orca_exe)
    if not orca_exe.is_file():
        raise OrcaEngineError(
            f"ORCA binary not found at {orca_exe}. "
            "Set ORCA_EXE to a valid path to enable the ORCA engine."
        )

    _prune_old_orca_job_dirs()

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

    # Parallel ORCA (%pal nprocs > 1) shells out to its MPI launcher and the
    # per-module worker binaries (orca_*_mpi), which live next to orca.exe. If
    # the ORCA install dir isn't on PATH, ORCA can't find them and either errors
    # out or silently falls back to a single process — so put it first on PATH.
    orca_bin_dir = str(orca_exe.parent)
    existing_path = env.get("PATH", "")
    if orca_bin_dir not in existing_path.split(os.pathsep):
        env["PATH"] = (
            orca_bin_dir + os.pathsep + existing_path if existing_path else orca_bin_dir
        )

    creationflags = 0
    popen_kwargs: dict[str, object] = {}
    if sys.platform == "win32":
        creationflags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        )
    else:
        popen_kwargs["start_new_session"] = True

    timed_out = False
    timeout_exc: subprocess.TimeoutExpired | None = None
    with out_path.open("wb") as fout, err_path.open("wb") as ferr:
        proc = subprocess.Popen(
            [str(orca_exe), inp_path.name],
            cwd=str(job_dir),
            stdout=fout,
            stderr=ferr,
            env=env,
            shell=False,
            creationflags=creationflags,
            **popen_kwargs,
        )
        try:
            proc.wait(timeout=_orca_timeout_seconds())
        except subprocess.TimeoutExpired as exc:
            _terminate_process_tree(proc)
            timed_out = True
            timeout_exc = exc

    if timed_out:
        _cleanup_job_dir(job_dir)
        raise OrcaEngineError(
            f"ORCA job {base!r} timed out after {_orca_timeout_seconds()} seconds"
        ) from timeout_exc

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
        logger.warning(
            "ORCA job %s failed rc=%s in %s",
            base,
            proc.returncode,
            job_dir,
        )
        raise OrcaEngineError(
            f"ORCA job {base!r} failed with exit code {proc.returncode}."
        )

    return _OrcaJobResult(job_dir=job_dir, out_path=out_path, out_text=out_text)


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
    shieldings: Dict[int, float] = {}

    current_idx: Optional[int] = None
    for line in out_text.splitlines():
        match = _NUCLEUS_HEADER_RE.match(line)
        if match:
            current_idx = int(match.group(1))
            continue
        if current_idx is not None:
            match = _ISOTROPIC_RE.match(line)
            if match:
                shieldings[current_idx] = float(match.group(1))
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
            match = _TABLE_ROW_RE.match(line)
            if match:
                shieldings[int(match.group(1))] = float(match.group(3))

    return shieldings


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
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix="tms_refs.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            json.dump(cache, handle, indent=2)
            tmp_path = Path(handle.name)
        os.replace(tmp_path, path)
    except OSError as exc:
        logger.warning("Failed to write TMS cache at %s: %s", path, exc)


def _build_tms_mol() -> Chem.Mol:
    mol = Chem.MolFromSmiles(_TMS_SMILES)
    mol = Chem.AddHs(mol)
    return _rdkit_preoptimized_mol(mol, random_seed=0xC0FFEE, num_confs=75)


def _compute_tms_reference(functional: str, basis: str) -> Dict[str, float]:
    logger.info("Computing TMS reference at %s/%s (first-time)", functional, basis)
    mol = _build_tms_mol()
    xyz = _mol_xyz_block(mol)
    cpus, ram_mb = _clamped_orca_resources(mol.GetNumAtoms())
    inp_text = _build_nmr_input(
        xyz,
        charge=0,
        multiplicity=1,
        functional=functional,
        basis=basis,
        cpus=cpus,
        ram_mb=ram_mb,
    )
    stamp = uuid.uuid4().hex[:8]
    safe_key = re.sub(r"[^A-Za-z0-9._-]+", "_", _tms_cache_key(functional, basis))
    job = _run_orca(inp_text, base="tms", subdir=f"tms_{safe_key}_{stamp}")
    try:
        shieldings = parse_shieldings(job.out_text)
    finally:
        _cleanup_job_dir(job.job_dir)

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
            f"(H={len(h_vals)}, C={len(c_vals)})"
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


def _set_rdkit_param(params, name: str, value) -> None:
    try:
        setattr(params, name, value)
    except (AttributeError, ValueError):
        pass


def _rdkit_conformer_count(mol: Chem.Mol) -> int:
    heavy_atoms = sum(1 for atom in mol.GetAtoms() if atom.GetAtomicNum() > 1)
    # RDKit is cheap relative to DFT, so spend extra effort finding a good
    # starting geometry before the ORCA shielding job.
    return max(75, min(300, heavy_atoms * 25))


def _copy_single_conformer(mol: Chem.Mol, conf_id: int) -> Chem.Mol:
    conf = Chem.Conformer(mol.GetConformer(conf_id))
    single = Chem.Mol(mol)
    single.RemoveAllConformers()
    single.AddConformer(conf, assignId=True)
    return single


def _optimize_rdkit_conformers(work: Chem.Mol, conf_ids: List[int]) -> List[tuple[int, float]]:
    optimize_kwargs = {"maxIters": 4000, "numThreads": 0}
    results = None
    if AllChem.MMFFHasAllMoleculeParams(work):
        try:
            results = AllChem.MMFFOptimizeMoleculeConfs(work, **optimize_kwargs)
        except Exception as exc:  # noqa: BLE001
            logger.debug("MMFF conformer optimization failed; trying UFF: %s", exc)

    if results is None:
        try:
            results = AllChem.UFFOptimizeMoleculeConfs(work, **optimize_kwargs)
        except Exception as exc:  # noqa: BLE001
            raise OrcaEngineError("RDKit force-field optimization failed") from exc

    scored: List[tuple[int, float]] = []
    for cid, (status, energy) in zip(conf_ids, results):
        if status == -1:
            continue
        energy = float(energy)
        if math.isfinite(energy):
            scored.append((cid, energy))
    return scored


def _rdkit_preoptimized_mol(
    mol: Chem.Mol,
    *,
    random_seed: int = 42,
    num_confs: Optional[int] = None,
) -> Chem.Mol:
    work = Chem.Mol(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = random_seed
    params.pruneRmsThresh = 0.25
    _set_rdkit_param(params, "maxAttempts", 2000)
    _set_rdkit_param(params, "numThreads", 0)
    _set_rdkit_param(params, "enforceChirality", True)
    _set_rdkit_param(params, "useSmallRingTorsions", True)
    _set_rdkit_param(params, "useMacrocycleTorsions", True)

    conf_ids = list(
        AllChem.EmbedMultipleConfs(
            work,
            numConfs=num_confs or _rdkit_conformer_count(work),
            params=params,
        )
    )
    if not conf_ids:
        if AllChem.EmbedMolecule(work, randomSeed=random_seed) == -1:
            raise OrcaEngineError("ETKDG failed to embed any conformer")
        conf_ids = [0]

    scored = _optimize_rdkit_conformers(work, conf_ids)
    best_cid = min(scored, key=lambda item: item[1])[0] if scored else conf_ids[0]
    return _copy_single_conformer(work, best_cid)


def _fast_conformer_xyz(mol: Chem.Mol) -> str:
    return _mol_xyz_block(_rdkit_preoptimized_mol(mol))


def _future_result(future: Future, label: str):
    wait_seconds = _orca_timeout_seconds() + 30
    try:
        return future.result(timeout=wait_seconds)
    except FutureTimeoutError as exc:
        raise OrcaEngineError(f"Timed out waiting for ORCA {label} result") from exc


def _average_symmetry_equivalent_shifts(
    mol: Chem.Mol, shifts: List[AtomShift]
) -> List[AtomShift]:
    # ORCA computes per-atom shieldings from a single 3D conformer whose geometry
    # is never perfectly symmetric, so topologically equivalent atoms come out at
    # slightly different ppm. Collapse them to their group mean so symmetric
    # molecules render as one signal per equivalence class, matching CDK/CASCADE.
    if not shifts:
        return shifts

    ranks = list(Chem.CanonicalRankAtoms(mol, breakTies=False, includeIsotopes=True))
    group_sums: Dict[int, float] = {}
    group_counts: Dict[int, int] = {}
    for shift in shifts:
        rank = ranks[shift.atom_index]
        group_sums[rank] = group_sums.get(rank, 0.0) + shift.shift_ppm
        group_counts[rank] = group_counts.get(rank, 0) + 1

    averaged: List[AtomShift] = []
    for shift in shifts:
        rank = ranks[shift.atom_index]
        mean_ppm = group_sums[rank] / group_counts[rank]
        averaged.append(shift.model_copy(update={"shift_ppm": mean_ppm}))
    return averaged


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

    def predict(self, mol: Chem.Mol, nucleus: str, **options) -> List[AtomShift]:
        if nucleus not in _NUCLEUS_TO_Z:
            raise OrcaEngineError(f"Unsupported nucleus: {nucleus!r}")

        strategy = options.get("conformer_strategy", "fast")
        if strategy != "fast":
            raise OrcaEngineError(
                f"Unknown conformer_strategy: {strategy!r} (expected 'fast')"
            )

        functional = settings.orca_functional
        basis = settings.orca_basis
        charge = Chem.GetFormalCharge(mol)
        radicals = sum(atom.GetNumRadicalElectrons() for atom in mol.GetAtoms())
        multiplicity = radicals + 1
        cpus, ram_mb = _clamped_orca_resources(mol.GetNumAtoms())

        with _orca_request_slot():
            _prune_old_orca_job_dirs()

            tms_future = submit_orca_job(lambda: _get_tms_reference(functional, basis))

            xyz_block = _fast_conformer_xyz(mol)

            def _run_sample() -> Dict[int, float]:
                inp_text = _build_nmr_input(
                    xyz_block,
                    charge=charge,
                    multiplicity=multiplicity,
                    functional=functional,
                    basis=basis,
                    cpus=cpus,
                    ram_mb=ram_mb,
                )
                stamp = uuid.uuid4().hex[:8]
                job = _run_orca(inp_text, base="sample", subdir=f"sample_{stamp}")
                try:
                    return parse_shieldings(job.out_text)
                finally:
                    _cleanup_job_dir(job.job_dir)

            sample_future = submit_orca_job(_run_sample)
            tms_ref = _future_result(tms_future, "TMS reference")
            shieldings = _future_result(sample_future, "sample")

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
                    f"ORCA did not emit an isotropic shielding for atom {idx} ({target_sym})"
                )
            shifts.append(
                AtomShift(
                    atom_index=idx,
                    symbol=target_sym,
                    shift_ppm=ref_sigma - sigma,
                    confidence=None,
                )
            )
        return _average_symmetry_equivalent_shifts(mol, shifts)


orca_engine = OrcaEngine()
