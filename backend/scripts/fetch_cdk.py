"""Download the CDK bundle and HOSE predictor jars into ``backend/vendor/cdk/``.

The CDK bundle contains the Chemistry Development Kit core. The current
nmrshiftdb distribution ships separate predictor jars for carbon and proton
prediction, so both need to be present for the app's CDK engine.

Usage::

    python backend/scripts/fetch_cdk.py
    python backend/scripts/fetch_cdk.py --force
"""
from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

# Pinned to CDK's 2.9 release on GitHub. 42 MB shaded jar, no auth, HTTPS.
CDK_BUNDLE_URL = "https://github.com/cdk/cdk/releases/download/cdk-2.9/cdk-2.9.jar"
CDK_BUNDLE_FILENAME = "cdk-2.9.jar"
PREDICTOR_C_URL = "https://downloads.sourceforge.net/project/nmrshiftdb2/data/predictorc.jar"
PREDICTOR_C_FILENAME = "predictorc.jar"
PREDICTOR_H_URL = "https://downloads.sourceforge.net/project/nmrshiftdb2/data/predictorh.jar"
PREDICTOR_H_FILENAME = "predictorh.jar"

VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor" / "cdk"
_REQUEST_HEADERS = {
    "User-Agent": "NMR-Predict-Bootstrap/1.0",
    "Accept": "*/*",
}


def _download(url: str, dest: Path) -> None:
    print(f"  downloading {url}")
    print(f"    -> {dest}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    request = urllib.request.Request(url, headers=_REQUEST_HEADERS)
    with urllib.request.urlopen(request) as resp, open(tmp, "wb") as out:
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
                    print(f"    {pct:3d}%  ({written/1e6:6.2f} MB)")
    tmp.replace(dest)
    print("  done.")


def _download_if_missing(url: str, dest: Path, force: bool) -> bool:
    if dest.exists() and not force:
        print(f"[fetch_cdk] {dest.name} already present. Use --force to re-download.")
        return False
    _download(url, dest)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Re-download even if present.")
    args = parser.parse_args()

    VENDOR_DIR.mkdir(parents=True, exist_ok=True)

    failed = False
    downloads = (
        (CDK_BUNDLE_URL, VENDOR_DIR / CDK_BUNDLE_FILENAME, "CDK bundle"),
        (PREDICTOR_C_URL, VENDOR_DIR / PREDICTOR_C_FILENAME, "13C predictor jar"),
        (PREDICTOR_H_URL, VENDOR_DIR / PREDICTOR_H_FILENAME, "1H predictor jar"),
    )

    for url, dest, label in downloads:
        try:
            _download_if_missing(url, dest, force=args.force)
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch_cdk] failed to download {label}: {exc}", file=sys.stderr)
            failed = True

    present = sorted(p.name for p in VENDOR_DIR.glob("*.jar"))
    print(f"[fetch_cdk] vendor/cdk contains: {present or '(empty)'}")
    if failed:
        return 1

    print("\n[fetch_cdk] CDK bundle and predictor jars are ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
