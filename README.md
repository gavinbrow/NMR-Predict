# NMR Predict

NMR Predict is a local web application for NMR chemical-shift prediction. It combines a FastAPI backend with a React frontend so you can draw or paste a molecule, validate its canonical SMILES, run one or more prediction engines, and inspect the resulting spectrum in an interactive viewer.

The project currently supports `1H` and `13C` prediction with three engines:

- `cdk`: HOSE-code lookup through CDK and the `nmrshiftdb2` predictor jars
- `cascade`: the CASCADE 3D graph neural network
- `orca`: DFT NMR prediction through the ORCA executable

## What It Does

- Draw molecules in Ketcher or paste SMILES directly.
- Validate input with RDKit and convert it to canonical SMILES before prediction.
- Run any combination of CDK, CASCADE, and ORCA.
- View either:
  - individual engine predictions as overlaid spectra
  - a weighted consensus prediction
- Inspect predicted signals in an NMRIUM-based viewer with:
  - atom-to-peak highlighting
  - per-engine overlays
  - proton signal grouping and approximate multiplicity labels
  - multi-molecule mixed spectra through the frontend "Add prediction" workflow

## How It Works

1. The backend parses the submitted SMILES with RDKit, sanitizes it, canonicalizes it, and uses that canonical atom ordering as the reference for all engines.
2. The selected engines return per-atom shifts for the requested nucleus.
3. For `1H`, the backend adds assignment metadata such as attached heavy atom, grouping, estimated multiplicity, neighbor count, and approximate `J` coupling.
4. In consensus mode, the backend combines successful engine outputs with normalized weights. Engines that fail are dropped from the consensus instead of failing the whole request.
5. The frontend normalizes the API response and renders synthetic spectra in NMRIUM from the predicted shift positions.

Current backend guardrails:

- SMILES length is limited to `256` characters.
- Molecules are limited to `64` heavy atoms.
- Molecules are limited to `192` total atoms after adding hydrogens.

## Quick Start

This repository is set up for a Windows-first local workflow. The simplest way to run it is from the project root:

```bat
run-nmr.bat
```

Available modes:

| Command | What it does |
| --- | --- |
| `run-nmr.bat` | Starts backend and frontend dev servers in separate windows |
| `run-nmr.bat all` | Same as the default command |
| `run-nmr.bat backend` | Starts only the FastAPI backend on `http://127.0.0.1:7999` |
| `run-nmr.bat frontend` | Starts only the Vite frontend on `http://127.0.0.1:8080` |
| `run-nmr.bat serve` | Builds the frontend and serves both the SPA and the API from FastAPI on `http://127.0.0.1:7999` |

What `run-nmr.bat` handles automatically:

- detects a usable backend Python interpreter
- checks that backend dependencies are installed
- downloads a portable Temurin 17 JRE into `backend/vendor/java/` if Java is missing
- downloads `cdk-2.9.jar`, `predictorc.jar`, and `predictorh.jar` into `backend/vendor/cdk/` if they are missing
- prevents startup when ports `7999` or `8080` are already occupied

Prerequisites for the full app:

- Python 3.10+ for the backend
- Node.js and npm for the frontend
- ORCA only if you want to use the ORCA engine

### Production / public hosting

```bat
run-production.bat
```

`run-production.bat` builds the frontend and serves the SPA + API from a single
uvicorn process on `0.0.0.0:7999` — reachable from other machines, not just
localhost. It runs without `--reload`, refuses to start if the port is busy or
the build is missing, and sets `NMR_ENV=production` so the interactive API docs
(`/docs`, `/redoc`, `/openapi.json`) are disabled. It runs in the foreground;
close the window or press Ctrl+C to stop.

> The service has **no built-in authentication** — anyone who can reach the port
> can submit prediction jobs (and ORCA DFT jobs, if ORCA is installed). Before
> exposing it to the open internet, open the Windows Firewall for the port and
> consider a reverse proxy (nginx / Caddy / Cloudflare Tunnel) for HTTPS and
> rate limiting. To keep it local-only instead, set `BIND_HOST=127.0.0.1` at the
> top of the script. The startup banner prints these notes and the firewall
> command.

## Manual Setup

### Backend

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 7999
```

### Frontend

```powershell
cd frontend
npm install
npm run dev -- --host 127.0.0.1 --port 8080
```

By default the frontend talks to the backend through the Vite `/api` proxy.

Useful frontend environment variables:

| Variable | Purpose |
| --- | --- |
| `VITE_NMR_API_URL` | Overrides the API base URL. Default: `/api` |
| `VITE_NMR_ENABLE_DEMO_MODE=1` | Enables mock responses when the backend is unreachable |

Demo mode is disabled by default. If the backend is down and demo mode is not enabled, the frontend shows the real connection failure instead of fabricating chemistry results.

## Prediction Engines

| Engine | Current behavior | Setup notes |
| --- | --- | --- |
| `cdk` | Uses JPype to bridge into CDK and the `nmrshiftdb2` predictor jars. Supports `1H` and `13C`. | `run-nmr.bat` can fetch the required Java runtime and jars automatically. You can also run `python backend/scripts/fetch_cdk.py` manually. |
| `cascade` | Uses the CASCADE neural-network model and an RDKit ETKDG/MMFF conformer ensemble. Supports `1H` and `13C`. | The backend expects the CASCADE assets under `backend/vendor/cascade/CASCADE/cascade-Jupyternotebook-SMILES/models/cascade/` unless `CASCADE_PATH` is set. |
| `orca` | Runs ORCA as a subprocess, computes a TMS reference cache for the selected level of theory, and converts shieldings to ppm. Supports `1H` and `13C`. | ORCA is not bundled. Set `ORCA_EXE` to the executable path to enable this engine. If ORCA is not configured, the app still works with the other available engines. |

### ORCA Notes

ORCA-specific behavior in the current implementation:

- `conformer_strategy: "fast"` uses a deeper RDKit ETKDG conformer ensemble plus MMFF/UFF force-field preoptimization, then selects the lowest-energy conformer for the ORCA NMR job.
- ORCA work is serialized through a single-worker queue.
- The queue is intentionally bounded so expensive requests fail fast instead of piling up indefinitely.
- TMS reference values are cached in `ORCA_WORK_DIR/tms_refs.json`.

Common ORCA environment variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `ORCA_EXE` | `C:\ORCA_6.1.1\orca.exe` | |
| `ORCA_FUNCTIONAL` | `TPSSh` | e.g. `PBE`, `BP86`, `TPSS`, `TPSSh`, `B97-D3`, `B3LYP`, `PBE0`, `wB97X-D3` |
| `ORCA_BASIS` | `pcSseg-1` | e.g. `def2-SVP`, `def2-TZVP`, `def2-TZVPP`, `pcSseg-1`, `pcSseg-2` |
| `ORCA_CPUS` | host CPU count | maps to `%pal nprocs`; clamped to host CPU count |
| `ORCA_RAM_MB` | `2000` | RAM **per core** (ORCA `%maxcore`); total RAM ≈ `ORCA_CPUS * ORCA_RAM_MB` |
| `ORCA_TIMEOUT` | `600` | |

Additional queue and work-directory settings live in `backend/app/config.py`.

### Configuring via `.env`

For convenience, the backend also loads a `.env` file from the project root at
startup (via `python-dotenv`). Copy `.env.example` to `.env` and uncomment the
variables you want to override:

```powershell
copy .env.example .env
```

The `.env.example` file documents the recommended values for the ORCA
functional and basis set, as well as the other settings listed above. Restart
the backend after editing `.env` so the new values are picked up.

## API

The backend exposes these routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Basic liveness check |
| `GET` | `/engines` | Lists registered engines, default weights, and readiness |
| `GET` | `/options` | Lists valid nuclei, modes, conformer strategies, and engine names |
| `POST` | `/validate` | Validates a SMILES string and returns canonical SMILES |
| `POST` | `/predict` | Runs engine predictions and optionally computes consensus |

The same endpoints are also available under `/api/*`, which is what the frontend uses.

### Example `POST /predict`

```json
{
  "smiles": "CCO",
  "engines": ["cdk", "cascade", "orca"],
  "mode": "consensus",
  "nucleus": "13C",
  "conformer_strategy": "fast",
  "weights": {
    "cdk": 0.5,
    "cascade": 0.3,
    "orca": 0.2
  }
}
```

Current request options:

- `nucleus`: `1H` or `13C`
- `engines`: one or more of `cdk`, `cascade`, `orca`; omitted requests default to `cdk` for `1H` and `cascade` for `13C`
- `mode`: `individual` or `consensus`
- `conformer_strategy`: `fast`

In consensus mode, the backend uses these default weights unless you override them:

- `cdk`: `0.5`
- `cascade`: `0.3`
- `orca`: `0.2`

The response includes:

- `canonical_smiles`
- `atom_symbols`
- `engines`
- `consensus`

In individual mode, `consensus` is `null`. In consensus mode, the `consensus` block includes merged per-atom shifts and `weights_used`, which reflects the weights after dropping any engines that did not return `status: "ok"`.

## Testing

### Backend

```powershell
cd backend
pytest
```

The backend test suite covers:

- SMILES validation and canonicalization
- conformer generation
- engine registry behavior
- consensus weighting and renormalization
- signal annotation metadata for `1H`
- endpoint shape and error handling

Some live engine tests are conditional:

- CDK live tests are skipped unless `CDK_JAR_PATH` is set
- CASCADE live tests require the model assets to be present
- ORCA live tests require both ORCA to be installed and `RUN_ORCA_TESTS=1`

### Accuracy benchmarks

A standalone harness in `backend/benchmarks/` measures how accurate each engine
is against a curated literature dataset (`benchmarks/data/reference_shifts.json`,
~39 molecules across chemical-environment scenarios, including a `larger` bucket —
anthracene, testosterone, cholesterol, etc. — that exercises ORCA size-scaling),
and sweeps ORCA functional / basis levels of theory on a cheap→expensive ladder.
Run from `backend/`:

```powershell
# Validate the dataset (canonicalize + SMARTS resolution)
python -m benchmarks.cli --validate-dataset

# Compare available engines on every scenario, both nuclei. The `orca` engine
# expands to the ORCA functional/basis ladder; use `--levels` to restrict it.
# Writes a report trio (.md + .csv + .html) into benchmarks/reports/.
# Unready engines are skipped, not errored.
python -m benchmarks.cli --engines cdk cascade orca --nucleus 13C 1H

# Print the ORCA level-of-theory ladder (relative speed + pros/cons table)
python -m benchmarks.cli ladder

# ORCA functional/basis sweep over the cheap end of the ladder (needs ORCA)
python -m benchmarks.cli orca-sweep --levels 1 2 3 --scenario aliphatic

# Merge a new expensive ORCA add-on sweep into an existing comparison report
python -m benchmarks.cli merge-csv --merge-csvs `
  benchmarks/reports/benchmark_20260525_full_ladder.csv `
  benchmarks/reports/benchmark_20260525_dft_extension.csv `
  --basename benchmark_20260525_full_ladder_plus_dft
```

Each run writes three files into `benchmarks/reports/` sharing one basename
(override with `--basename`, otherwise timestamped): a Markdown report, a raw
per-group CSV, and a **standalone styled HTML report** you can open directly in
a browser. All three break accuracy down per scenario and per nucleus (MAE /
RMSE / max error / bias / R², plus a bias-removed "scaled MAE" and a
worst-offenders list). Long ORCA sweeps checkpoint the raw CSV after every
completed level, and the HTML report includes figures for overall MAE,
seconds-per-heavy-atom, and molecule-size buckets. The ORCA ladder includes
cheap GGA/meta-GGA checks plus hybrid/range-separated levels such as
`PBE0`, `TPSSh`, and `wB97X-D3` with `def2-*` and `pcSseg-*` bases.
A pytest gate (`tests/test_benchmark_accuracy.py`) asserts per-engine MAE stays
under calibrated thresholds; it skips engines that aren't installed, and ORCA
accuracy assertions are gated behind `RUN_ORCA_TESTS=1` like the other ORCA
tests. See `backend/benchmarks/data/README.md` for the dataset schema.

### Frontend

```powershell
cd frontend
npm test
```

Frontend tests cover:

- API request behavior and cancellation handling
- backend-to-UI response normalization
- signal grouping and integral generation
- synthetic NMRIUM spectrum assembly
- Ketcher fallback behavior when the editor bundle is unavailable

## Repository Layout

| Path | Purpose |
| --- | --- |
| `backend/app/` | FastAPI app, RDKit utilities, engine implementations, consensus logic |
| `backend/tests/` | Backend tests |
| `backend/scripts/` | Bootstrap scripts for Java and CDK assets |
| `backend/vendor/` | Vendored third-party runtime and model assets used by the app |
| `frontend/src/` | React application, API client, spectrum generation, and UI components |
| `run-nmr.bat` | Main local startup script |

## Current Scope

This repository currently implements a local prediction workflow for `1H` and `13C` NMR, including engine comparison, weighted consensus, and an interactive viewer for inspecting predicted assignments.
