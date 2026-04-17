"""Download and extract a portable Temurin Java runtime into backend/vendor/java.

This avoids requiring an admin-installed JDK on Windows. JPype can load the
bundled JVM directly from the extracted runtime, so the CDK engine works even
when `java` and `JAVA_HOME` are missing globally.

Usage::

    python backend/scripts/fetch_java.py
    python backend/scripts/fetch_java.py --force
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ADOPTIUM_API_URL = (
    "https://api.adoptium.net/v3/assets/latest/17/hotspot"
    "?architecture=x64&heap_size=normal&image_type=jre"
    "&jvm_impl=hotspot&os=windows&vendor=eclipse"
)

VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor" / "java"
HTTP_HEADERS = {
    "User-Agent": "NMR-Predict-Bootstrap/1.0",
    "Accept": "application/json",
}


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


def _download(url: str, dest: Path) -> None:
    print(f"  downloading {url}")
    print(f"    -> {dest}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    request = urllib.request.Request(url, headers=HTTP_HEADERS)
    with urllib.request.urlopen(request) as resp, open(tmp, "wb") as out:
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
                    print(f"    {pct:3d}%  ({written/1e6:6.2f} MB)")
    tmp.replace(dest)
    print("  done.")


def _fetch_release_metadata() -> tuple[str, str]:
    request = urllib.request.Request(ADOPTIUM_API_URL, headers=HTTP_HEADERS)
    with urllib.request.urlopen(request) as resp:
        data = json.load(resp)
    if not data:
        raise RuntimeError("Adoptium API returned no releases")

    package = data[0]["binary"]["package"]
    return package["link"], package["name"]


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

    try:
        package_url, package_name = _fetch_release_metadata()
    except Exception as exc:  # noqa: BLE001
        print(f"[fetch_java] failed to query Adoptium API: {exc}", file=sys.stderr)
        return 1

    archive_path = VENDOR_DIR / package_name
    try:
        _download(package_url, archive_path)
    except Exception as exc:  # noqa: BLE001
        print(f"[fetch_java] failed to download Java runtime: {exc}", file=sys.stderr)
        return 1

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
