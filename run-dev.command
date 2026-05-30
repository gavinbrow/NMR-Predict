#!/bin/bash
#
# Double-clickable macOS launcher for the NMR-Predict dev servers.
#
# Finder runs a .command file in Terminal. This starts the Vite frontend
# (http://127.0.0.1:8080) and, if a Python backend is available, the FastAPI
# backend (http://127.0.0.1:7999). The MALDI workspace at /maldi is
# frontend-only and works even when the backend is not running.
#
# Usage: just double-click run-dev.command in Finder, or run it from a shell.

set -u

# Always operate from the directory this script lives in (the repo root).
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"

echo "NMR-Predict dev launcher"
echo "Repo: $ROOT"
echo

# --- Frontend dependencies ---------------------------------------------------
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "Installing frontend dependencies (first run)…"
  ( cd "$ROOT/frontend" && npm install --legacy-peer-deps ) || {
    echo "npm install failed. Fix the error above and re-run."
    read -r -p "Press Return to close…" _
    exit 1
  }
fi

# --- Backend (best effort) ---------------------------------------------------
# The backend is optional for the MALDI workspace. Start it only if we can find
# a Python interpreter that already has uvicorn installed.
PYTHON=""
if [ -x "$ROOT/backend/.venv/bin/python" ]; then
  PYTHON="$ROOT/backend/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1 && python3 -c "import uvicorn" >/dev/null 2>&1; then
  PYTHON="python3"
fi

BACKEND_PID=""
if [ -n "$PYTHON" ]; then
  echo "Starting backend  → http://127.0.0.1:7999"
  ( cd "$ROOT/backend" && "$PYTHON" -m uvicorn app.main:app --reload --host 127.0.0.1 --port 7999 ) &
  BACKEND_PID=$!
else
  echo "Backend not started: no virtualenv at backend/.venv and no system uvicorn."
  echo "  → The MALDI workspace (/maldi) is fully client-side and runs without it."
  echo "  → For NMR prediction, set up backend/.venv (see README) and re-run."
fi
echo

# Stop the backend when this window/process exits.
cleanup() {
  if [ -n "$BACKEND_PID" ]; then
    kill "$BACKEND_PID" >/dev/null 2>&1
  fi
}
trap cleanup EXIT INT TERM

# Open the browser shortly after Vite has had time to boot.
( sleep 4 && open "http://127.0.0.1:8080/maldi" >/dev/null 2>&1 ) &

# --- Frontend (foreground; Ctrl+C stops everything) --------------------------
echo "Starting frontend → http://127.0.0.1:8080  (Ctrl+C to stop)"
echo
cd "$ROOT/frontend" || exit 1
npm run dev -- --host 127.0.0.1 --port 8080
