"""Download and extract a pinned Temurin Java runtime into ``backend/vendor/java``."""
from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

_DOWNLOAD_TIMEOUT_SECONDS = 30
_HTTP_HEADERS = {
    "User-Agent": "NMR-Predict-Bootstrap/1.0",
    "Accept": "application/octet-stream",
}

_JAVA_ARCHIVE_URL = (
    "https://github.com/adoptium/temurin17-binaries/releases/download/"
    "jdk-17.0.18%2B8/OpenJDK17U-jre_x64_windows_hotspot_17.0.18_8.zip"
)
_JAVA_ARCHIVE_NAME = "OpenJDK17U-jre_x64_windows_hotspot_17.0.18_8.zip"
_JAVA_ARCHIVE_SHA256 = "95c9ebe3ee16baab7239531757513d9a03799ca06483ef2f3b530e81e93e7b5b"
_JAVA_HOME_DIRNAME = "jdk-17.0.18+8-jre"

VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor" / "java"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _existing_java_home() -> Path | None:
    for jvm_path in sorted(VENDOR_DIR.rglob("jvm.dll"), reverse=True):
        parts = [part.lower() for part in jvm_path.parts]
        if "server" not in parts:
            continue
        try:
            server_idx = parts.index("server")
        except ValueError:
            continue
        if server_idx >= 1 and parts[server_idx - 1] == "bin":
            return jvm_path.parents[2]
        if (
            server_idx >= 2
            and parts[server_idx - 1] == "bin"
            and parts[server_idx - 2] == "jre"
        ):
            return jvm_path.parents[3]
    return None


def _verify_archive(path: Path) -> None:
    actual_sha256 = _sha256_file(path)
    if actual_sha256 != _JAVA_ARCHIVE_SHA256:
        raise RuntimeError(
            f"{path.name} checksum mismatch: expected {_JAVA_ARCHIVE_SHA256}, got {actual_sha256}"
        )

    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.namelist()
    except zipfile.BadZipFile as exc:
        raise RuntimeError(f"{path.name} is not a valid ZIP archive") from exc

    required = {
        f"{_JAVA_HOME_DIRNAME}/bin/java.exe",
        f"{_JAVA_HOME_DIRNAME}/bin/server/jvm.dll",
        f"{_JAVA_HOME_DIRNAME}/release",
    }
    missing = sorted(required.difference(members))
    if missing:
        raise RuntimeError(f"{path.name} is missing required files: {missing}")


def _download(dest: Path) -> Path:
    print(f"  downloading {_JAVA_ARCHIVE_URL}")
    print(f"    -> {dest}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    request = urllib.request.Request(_JAVA_ARCHIVE_URL, headers=_HTTP_HEADERS)
    with urllib.request.urlopen(request, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as resp, tmp.open("wb") as out:
        total = int(resp.headers.get("Content-Length", 0))
        written = 0
        last_pct = -1
        chunk = 1 << 20
        while True:
            buf = resp.read(chunk)
            if not buf:
                break
            out.write(buf)
            written += len(buf)
            if total:
                pct = int((written / total) * 100)
                if pct != last_pct and pct % 10 == 0:
                    last_pct = pct
                    print(f"    {pct:3d}%  ({written / 1e6:6.2f} MB)")
    print("  done.")
    return tmp


def _clean_previous_runtimes(keep: set[str]) -> None:
    for path in VENDOR_DIR.iterdir():
        if path.name in keep:
            continue
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Re-download even if present.")
    args = parser.parse_args()

    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    existing_home = _existing_java_home()
    if existing_home and not args.force:
        print(f"[fetch_java] Java runtime already present at {existing_home}")
        return 0

    archive_path = VENDOR_DIR / _JAVA_ARCHIVE_NAME
    try:
        tmp = _download(archive_path)
        _verify_archive(tmp)
        tmp.replace(archive_path)
    except Exception as exc:  # noqa: BLE001
        print(f"[fetch_java] failed to download Java runtime: {exc}", file=sys.stderr)
        archive_path.unlink(missing_ok=True)
        return 1
    finally:
        tmp_path = archive_path.with_suffix(archive_path.suffix + ".part")
        tmp_path.unlink(missing_ok=True)

    try:
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(VENDOR_DIR)
    except Exception as exc:  # noqa: BLE001
        print(f"[fetch_java] failed to extract Java runtime: {exc}", file=sys.stderr)
        return 1
    finally:
        archive_path.unlink(missing_ok=True)

    java_home = _existing_java_home()
    if java_home is None:
        print("[fetch_java] extraction finished but no JVM was found", file=sys.stderr)
        return 1

    keep = {java_home.name, "README.md"}
    _clean_previous_runtimes(keep)
    print(f"[fetch_java] Java runtime ready at {java_home}")
    print(f"[fetch_java] java.exe = {java_home / 'bin' / 'java.exe'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
