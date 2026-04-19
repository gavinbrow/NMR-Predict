"""Download the pinned CDK bundle and predictor jars into ``backend/vendor/cdk/``."""
from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.request
import zipfile
from pathlib import Path

_DOWNLOAD_TIMEOUT_SECONDS = 30
_REQUEST_HEADERS = {
    "User-Agent": "NMR-Predict-Bootstrap/1.0",
    "Accept": "*/*",
}

_ARTIFACTS = (
    {
        "label": "CDK bundle",
        "url": "https://github.com/cdk/cdk/releases/download/cdk-2.9/cdk-2.9.jar",
        "filename": "cdk-2.9.jar",
        "sha256": "60710218b8f9fd206e6151122e630c281462e9588e4b7a279c49c1532a8aeffe",
    },
    {
        "label": "13C predictor jar",
        "url": "https://downloads.sourceforge.net/project/nmrshiftdb2/data/predictorc.jar",
        "filename": "predictorc.jar",
        "sha256": "e3c3365fb3ffdccd79bb1c39c457c2486e6170f88eeaca5f36c09587950a5090",
    },
    {
        "label": "1H predictor jar",
        "url": "https://downloads.sourceforge.net/project/nmrshiftdb2/data/predictorh.jar",
        "filename": "predictorh.jar",
        "sha256": "529e2c89279aaafcf63347460775693d0ff5120d17dae051e31b9e55f6d1e67d",
    },
)

VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor" / "cdk"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_jar(path: Path, expected_sha256: str) -> None:
    actual_sha256 = _sha256_file(path)
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"{path.name} checksum mismatch: expected {expected_sha256}, got {actual_sha256}"
        )

    try:
        with zipfile.ZipFile(path) as archive:
            members = {name.upper() for name in archive.namelist()}
    except zipfile.BadZipFile as exc:
        raise RuntimeError(f"{path.name} is not a valid JAR archive") from exc

    if "META-INF/MANIFEST.MF" not in members:
        raise RuntimeError(f"{path.name} is missing META-INF/MANIFEST.MF")


def _download(url: str, dest: Path) -> Path:
    print(f"  downloading {url}")
    print(f"    -> {dest}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    request = urllib.request.Request(url, headers=_REQUEST_HEADERS)
    with urllib.request.urlopen(request, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as resp, tmp.open("wb") as out:
        total = int(resp.headers.get("Content-Length", 0))
        written = 0
        last_pct = -1
        chunk = 1 << 15
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


def _ensure_artifact(url: str, dest: Path, sha256: str, force: bool) -> bool:
    if dest.exists() and not force:
        try:
            _verify_jar(dest, sha256)
            print(f"[fetch_cdk] {dest.name} already present and verified.")
            return False
        except RuntimeError as exc:
            print(f"[fetch_cdk] {dest.name} failed verification, re-downloading: {exc}")

    tmp = _download(url, dest)
    try:
        _verify_jar(tmp, sha256)
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Re-download even if present.")
    args = parser.parse_args()

    VENDOR_DIR.mkdir(parents=True, exist_ok=True)

    failed = False
    for artifact in _ARTIFACTS:
        dest = VENDOR_DIR / artifact["filename"]
        try:
            _ensure_artifact(
                artifact["url"],
                dest,
                artifact["sha256"],
                force=args.force,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch_cdk] failed to install {artifact['label']}: {exc}", file=sys.stderr)
            failed = True

    present = sorted(path.name for path in VENDOR_DIR.glob("*.jar"))
    print(f"[fetch_cdk] vendor/cdk contains: {present or '(empty)'}")
    if failed:
        return 1

    print("\n[fetch_cdk] CDK bundle and predictor jars are ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
