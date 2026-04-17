"""CDK engine for HOSE-code chemical shift prediction via JPype.

The current nmrshiftdb distribution ships separate predictor jars for carbon
(`predictorc.jar`) and proton (`predictorh.jar`) shifts. Both jars expose the
same fully qualified Java class name, so they cannot live on the JVM startup
classpath together. We start the JVM with only the CDK core jar(s), then load
the appropriate predictor jar with a dedicated child classloader per nucleus.
"""
from __future__ import annotations

import glob
import logging
import os
import shutil
import threading
from pathlib import Path
from typing import Optional

from rdkit import Chem

from app.config import settings
from app.engines.base import Engine
from app.schemas import AtomShift

logger = logging.getLogger(__name__)


class CdkEngineError(RuntimeError):
    """Raised when CDK setup or invocation fails."""


_WINDOWS_JVM_GLOBS = (
    r"C:\Program Files\Java\*\bin\server\jvm.dll",
    r"C:\Program Files\Java\*\jre\bin\server\jvm.dll",
    r"C:\Program Files\Eclipse Adoptium\*\bin\server\jvm.dll",
    r"C:\Program Files\Eclipse Foundation\*\bin\server\jvm.dll",
    r"C:\Program Files\Amazon Corretto\*\bin\server\jvm.dll",
    r"C:\Program Files\Microsoft\jdk-*\bin\server\jvm.dll",
    r"C:\Program Files (x86)\Java\*\bin\server\jvm.dll",
    r"C:\Program Files (x86)\Java\*\jre\bin\server\jvm.dll",
)

_PREDICTOR_JAR_BY_NUCLEUS = {
    "13C": ("predictorc.jar", "nmrshiftdb2.jar"),
    "1H": ("predictorh.jar",),
}
_DEFAULT_SOLVENT = "Unreported"


class CdkEngine(Engine):
    name = "cdk"
    default_weight = 0.5

    def __init__(self) -> None:
        self._ready = False
        self._SmilesParser = None
        self._builder = None
        self._AtomContainerManipulator = None
        self._CDKHydrogenAdder = None
        self._jpype = None
        self._predictor_jars: dict[str, str] = {}
        self._predictors: dict[str, tuple[object, object, object]] = {}
        self._lock = threading.RLock()

    def _java_home_from_jvm_path(self, jvm_path: str) -> Optional[str]:
        path = Path(jvm_path).resolve()
        parts = [part.lower() for part in path.parts]
        try:
            server_idx = parts.index("server")
        except ValueError:
            return None

        if server_idx >= 1 and parts[server_idx - 1] == "bin":
            return str(path.parents[2])
        if (
            server_idx >= 2
            and parts[server_idx - 1] == "bin"
            and parts[server_idx - 2] == "jre"
        ):
            return str(path.parents[3])
        return None

    def _candidate_jvm_paths(self) -> list[str]:
        candidates: list[str] = []
        seen: set[str] = set()

        def add(path: Optional[str]) -> None:
            if not path:
                return
            normalized = os.path.abspath(path)
            if normalized in seen:
                return
            seen.add(normalized)
            candidates.append(normalized)

        java_home = os.getenv("JAVA_HOME")
        if java_home:
            add(os.path.join(java_home, "bin", "server", "jvm.dll"))
            add(os.path.join(java_home, "jre", "bin", "server", "jvm.dll"))

        java_exe = shutil.which("java")
        if java_exe:
            java_root = str(Path(java_exe).resolve().parent.parent)
            add(os.path.join(java_root, "bin", "server", "jvm.dll"))
            add(os.path.join(java_root, "jre", "bin", "server", "jvm.dll"))

        vendor_java_dir = Path(__file__).resolve().parents[2] / "vendor" / "java"
        if vendor_java_dir.exists():
            for match in sorted(vendor_java_dir.rglob("jvm.dll"), reverse=True):
                add(str(match))

        if os.name == "nt":
            for pattern in _WINDOWS_JVM_GLOBS:
                for match in sorted(glob.glob(pattern), reverse=True):
                    add(match)

        return [path for path in candidates if os.path.isfile(path)]

    def _resolve_jvm_path(self, jpype) -> str:
        try:
            return jpype.getDefaultJVMPath()
        except jpype.JVMNotFoundException:
            for candidate in self._candidate_jvm_paths():
                java_home = self._java_home_from_jvm_path(candidate)
                if java_home and not os.getenv("JAVA_HOME"):
                    os.environ["JAVA_HOME"] = java_home
                return candidate
            raise

    # ------------------------------------------------------------------
    # JVM / classpath bootstrap
    # ------------------------------------------------------------------
    def _expand_classpath_entries(self, raw: str) -> list[str]:
        entries = raw.split(os.pathsep) if os.pathsep in raw else [raw]
        expanded: list[str] = []
        for entry in entries:
            entry = entry.strip()
            if not entry:
                continue
            if os.path.isdir(entry):
                for name in sorted(os.listdir(entry)):
                    if name.lower().endswith(".jar"):
                        expanded.append(os.path.join(entry, name))
            else:
                expanded.append(entry)
        return expanded

    def _is_predictor_jar(self, entry: str) -> bool:
        name = os.path.basename(entry).lower()
        return any(name in jar_names for jar_names in _PREDICTOR_JAR_BY_NUCLEUS.values())

    def _has_predictor_jar(self, entries: list[str]) -> bool:
        return any(self._is_predictor_jar(entry) for entry in entries)

    def _resolve_predictor_jars(self, entries: list[str]) -> dict[str, str]:
        by_name = {
            os.path.basename(entry).lower(): entry
            for entry in entries
            if os.path.isfile(entry)
        }
        resolved: dict[str, str] = {}
        missing: list[str] = []
        for nucleus, jar_names in _PREDICTOR_JAR_BY_NUCLEUS.items():
            for jar_name in jar_names:
                predictor = by_name.get(jar_name.lower())
                if predictor:
                    resolved[nucleus] = predictor
                    break
            else:
                missing.append(f"{nucleus}: {' or '.join(jar_names)}")

        if missing:
            raise CdkEngineError(
                "CDK classpath is missing predictor jars for: "
                + ", ".join(missing)
                + ". Drop the missing jar(s) into backend/vendor/cdk/."
            )
        return resolved

    def _resolve_classpath(self) -> tuple[list[str], dict[str, str]]:
        raw = settings.cdk_jar_path
        if not raw:
            raise CdkEngineError(
                "CDK_JAR_PATH not configured. Point it at backend/vendor/cdk "
                "(or a directory of jars) to enable the CDK engine."
            )

        expanded = self._expand_classpath_entries(raw)
        missing = [path for path in expanded if not os.path.isfile(path)]
        if missing:
            raise CdkEngineError(f"CDK jar(s) not found on disk: {missing}")
        if not expanded:
            raise CdkEngineError("CDK classpath resolved to an empty list")

        predictor_jars = self._resolve_predictor_jars(expanded)
        core_jars = [entry for entry in expanded if not self._is_predictor_jar(entry)]
        if not core_jars:
            raise CdkEngineError(
                "CDK classpath has predictor jars but no CDK core bundle. "
                "Make sure cdk-2.9.jar is present alongside the predictor jars."
            )

        return core_jars, predictor_jars

    def _ensure_ready(self) -> None:
        with self._lock:
            if self._ready:
                return

            try:
                import jpype  # noqa: F401
                import jpype.imports  # noqa: F401
            except ImportError as exc:
                raise CdkEngineError(
                    "JPype1 not installed; run `pip install JPype1`."
                ) from exc

            classpath, predictor_jars = self._resolve_classpath()
            try:
                jvm_path = self._resolve_jvm_path(jpype)
            except jpype.JVMNotFoundException as exc:
                raise CdkEngineError(
                    "No Java runtime found for the CDK engine. Install a JDK "
                    "(e.g. Temurin 17 from https://adoptium.net/) and make "
                    "sure JAVA_HOME points at it, or that `java` is on PATH."
                ) from exc

            if not jpype.isJVMStarted():
                try:
                    jpype.startJVM(jvm_path, classpath=classpath, convertStrings=False)
                except jpype.JVMNotFoundException as exc:
                    raise CdkEngineError(
                        "No Java runtime found for the CDK engine. Install a JDK "
                        "(e.g. Temurin 17 from https://adoptium.net/) and make "
                        "sure JAVA_HOME points at it, or that `java` is on PATH."
                    ) from exc
                except Exception as exc:
                    raise CdkEngineError(
                        f"Failed to start the JVM for the CDK engine: {exc}"
                    ) from exc

            try:
                from org.openscience.cdk import DefaultChemObjectBuilder
                from org.openscience.cdk.smiles import SmilesParser
                from org.openscience.cdk.tools import CDKHydrogenAdder
                from org.openscience.cdk.tools.manipulator import (
                    AtomContainerManipulator,
                )
            except Exception as exc:
                raise CdkEngineError(
                    f"Failed to import CDK core classes from the jar(s): {exc}"
                ) from exc

            self._jpype = jpype
            self._predictor_jars = predictor_jars
            self._SmilesParser = SmilesParser
            self._builder = DefaultChemObjectBuilder.getInstance()
            self._AtomContainerManipulator = AtomContainerManipulator
            self._CDKHydrogenAdder = CDKHydrogenAdder
            self._ready = True
            logger.info(
                "CDK engine ready with core jars=%s predictor jars=%s",
                classpath,
                predictor_jars,
            )

    def _ensure_predictor(self, nucleus: str) -> tuple[object, object]:
        with self._lock:
            cached = self._predictors.get(nucleus)
            if cached is not None:
                _, predictor, predict_method = cached
                return predictor, predict_method

            predictor_jar = self._predictor_jars.get(nucleus)
            if not predictor_jar:
                raise CdkEngineError(f"No predictor jar configured for nucleus {nucleus!r}")

            jpype = self._jpype
            try:
                URL = jpype.JClass("java.net.URL")
                URLClassLoader = jpype.JClass("java.net.URLClassLoader")
                JFile = jpype.JClass("java.io.File")
                JClass = jpype.JClass("java.lang.Class")
                JClassLoader = jpype.JClass("java.lang.ClassLoader")
                JBoolean = jpype.JClass("java.lang.Boolean")
                JString = jpype.JClass("java.lang.String")
                IAtom = jpype.JClass("org.openscience.cdk.interfaces.IAtom")
                IAtomContainer = jpype.JClass("org.openscience.cdk.interfaces.IAtomContainer")

                jar_url = JFile(predictor_jar).toURI().toURL()
                urls = jpype.JArray(URL)([jar_url])
                loader = URLClassLoader.newInstance(urls, JClassLoader.getSystemClassLoader())
                predictor_cls = JClass.forName(
                    "org.openscience.nmrshiftdb.PredictionTool",
                    True,
                    loader,
                )
                predictor = predictor_cls.getDeclaredConstructor().newInstance()
                predict_method = predictor_cls.getMethod(
                    "predict",
                    IAtomContainer.class_,
                    IAtom.class_,
                    JBoolean.TYPE,
                    JString.class_,
                )
            except Exception as exc:
                raise CdkEngineError(
                    f"Failed to load {nucleus} predictor from {predictor_jar}: {exc}"
                ) from exc

            self._predictors[nucleus] = (loader, predictor, predict_method)
            return predictor, predict_method

    def warmup(self) -> None:
        self._ensure_ready()
        for nucleus in ("13C", "1H"):
            self._ensure_predictor(nucleus)

    # ------------------------------------------------------------------
    # Readiness (cheap - never starts the JVM)
    # ------------------------------------------------------------------
    def is_ready(self):
        raw = settings.cdk_jar_path
        if not raw:
            return False, (
                "CDK classpath not configured. Run "
                "`python backend/scripts/fetch_cdk.py` or set CDK_JAR_PATH."
            )

        entries = self._expand_classpath_entries(raw)
        has_jars = any(os.path.isfile(entry) for entry in entries)
        if not has_jars:
            return False, (
                f"No jars found at {raw}. Run "
                "`python backend/scripts/fetch_cdk.py` to install the CDK bundle "
                "and predictors."
            )

        try:
            core_jars, _predictor_jars = self._resolve_classpath()
        except CdkEngineError as exc:
            return False, str(exc)

        if not core_jars:
            return False, (
                "No CDK core jar found. Run `python backend/scripts/fetch_cdk.py` "
                "to install cdk-2.9.jar."
            )

        try:
            import jpype
        except ImportError:
            return False, "JPype1 not installed; run `pip install JPype1`."

        try:
            self._resolve_jvm_path(jpype)
        except jpype.JVMNotFoundException:
            return False, (
                "No Java runtime found. Install a JDK (e.g. Temurin 17 from "
                "https://adoptium.net/) and set JAVA_HOME, then restart the "
                "backend."
            )

        return True, None

    # ------------------------------------------------------------------
    # Prediction
    # ------------------------------------------------------------------
    def predict(self, mol: Chem.Mol, nucleus: str, **_options) -> list[AtomShift]:
        if nucleus not in ("1H", "13C"):
            raise CdkEngineError(f"Unsupported nucleus: {nucleus!r}")

        self._ensure_ready()

        heavy_mol = Chem.RemoveHs(mol)
        canonical = Chem.MolToSmiles(heavy_mol, canonical=True)

        parser = self._SmilesParser(self._builder)
        try:
            cdk_mol = parser.parseSmiles(canonical)
        except Exception as exc:
            raise CdkEngineError(f"CDK failed to parse SMILES {canonical!r}: {exc}") from exc

        self._AtomContainerManipulator.percieveAtomTypesAndConfigureAtoms(cdk_mol)
        adder = self._CDKHydrogenAdder.getInstance(self._builder)
        adder.addImplicitHydrogens(cdk_mol)
        self._AtomContainerManipulator.convertImplicitToExplicitHydrogens(cdk_mol)

        rd_symbols = [atom.GetSymbol() for atom in mol.GetAtoms()]
        cdk_symbols = [str(cdk_mol.getAtom(i).getSymbol()) for i in range(cdk_mol.getAtomCount())]
        if rd_symbols != cdk_symbols:
            raise CdkEngineError(
                "RDKit/CDK atom ordering diverged after hydrogen addition; "
                f"RDKit={rd_symbols} CDK={cdk_symbols}"
            )

        predictor, predict_method = self._ensure_predictor(nucleus)
        target_atnum = 1 if nucleus == "1H" else 6

        shifts: list[AtomShift] = []
        for rd_idx, rd_atom in enumerate(mol.GetAtoms()):
            if rd_atom.GetAtomicNum() != target_atnum:
                continue

            cdk_atom = cdk_mol.getAtom(rd_idx)
            shift = self._predict_single(predictor, predict_method, cdk_mol, cdk_atom)
            if shift is None:
                continue

            shifts.append(
                AtomShift(
                    atom_index=rd_idx,
                    symbol=rd_atom.GetSymbol(),
                    shift_ppm=shift,
                    confidence=None,
                )
            )
        return shifts

    def _predict_single(
        self,
        predictor,
        predict_method,
        cdk_mol,
        cdk_atom,
    ) -> Optional[float]:
        try:
            result = predict_method.invoke(
                predictor,
                cdk_mol,
                cdk_atom,
                False,
                self._jpype.JString(_DEFAULT_SOLVENT),
            )
        except Exception as exc:
            logger.debug("CDK predictor invocation failed: %s", exc)
            return None

        if result is None:
            return None

        try:
            if len(result) == 0:
                return None
            shift = float(result[1] if len(result) > 1 else result[0])
        except Exception as exc:
            logger.debug("CDK predictor returned unexpected payload %r: %s", result, exc)
            return None

        if shift < 0:
            return None
        return shift


cdk_engine = CdkEngine()
