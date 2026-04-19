"""ORCA engine - DFT NMR chemical-shift prediction via subprocess."""
from __future__ import annotations

import json
import logging
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


def _clamped_orca_resources() -> tuple[int, int]:
    host_cpus = os.cpu_count() or 1
    cpus = max(1, min(int(settings.orca_cpus), host_cpus))
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
    logger.info("Computing TMS reference at %s/%s (first-time)", functional, basis)
    mol = _build_tms_mol()
    xyz = _mol_xyz_block(mol)
    cpus, ram_mb = _clamped_orca_resources()
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


def _fast_conformer_xyz(mol: Chem.Mol) -> str:
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


def _goat_conformer_xyz(
    mol: Chem.Mol,
    charge: int,
    multiplicity: int,
    cpus: int,
    ram_mb: int,
) -> str:
    seed_xyz = _fast_conformer_xyz(mol)
    inp_text = _build_goat_input(
        seed_xyz,
        charge=charge,
        multiplicity=multiplicity,
        cpus=cpus,
        ram_mb=ram_mb,
    )
    stamp = uuid.uuid4().hex[:8]
    job = _run_orca(inp_text, base="goat", subdir=f"goat_{stamp}")
    try:
        gmin = job.out_path.parent / f"{job.out_path.stem}.globalminimum.xyz"
        if not gmin.exists():
            raise OrcaEngineError(
                f"GOAT completed but no globalminimum.xyz was written in {job.out_path.parent}"
            )
        return _parse_goat_globalmin_xyz(gmin)
    finally:
        _cleanup_job_dir(job.job_dir)


def _future_result(future: Future, label: str):
    wait_seconds = _orca_timeout_seconds() + 30
    try:
        return future.result(timeout=wait_seconds)
    except FutureTimeoutError as exc:
        raise OrcaEngineError(f"Timed out waiting for ORCA {label} result") from exc


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
        if strategy not in ("fast", "goat"):
            raise OrcaEngineError(
                f"Unknown conformer_strategy: {strategy!r} (expected 'fast' or 'goat')"
            )

        functional = settings.orca_functional
        basis = settings.orca_basis
        charge = Chem.GetFormalCharge(mol)
        radicals = sum(atom.GetNumRadicalElectrons() for atom in mol.GetAtoms())
        multiplicity = radicals + 1
        cpus, ram_mb = _clamped_orca_resources()

        with _orca_request_slot():
            _prune_old_orca_job_dirs()

            tms_future = submit_orca_job(lambda: _get_tms_reference(functional, basis))

            if strategy == "fast":
                xyz_block = _fast_conformer_xyz(mol)
            else:
                goat_future = submit_orca_job(
                    lambda: _goat_conformer_xyz(mol, charge, multiplicity, cpus, ram_mb)
                )
                xyz_block = _future_result(goat_future, "GOAT conformer")

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
        return shifts


orca_engine = OrcaEngine()
