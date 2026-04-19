# NMR Predict

Local web app for NMR chemical-shift prediction. Users draw a molecule, pick
one or more prediction pathways (CASCADE, CDK, ORCA), and view individual or
consensus results.

## Status: Phase 4 complete — NMRIUM + Ketcher frontend

Phase 1 shipped the backend skeleton and RDKit canonicalization layer. Phase 2
landed the three engines: **CDK** (HOSE-code lookup), **CASCADE** (3D graph
neural network), and **ORCA** (DFT NMR via subprocess). Phase 3 added the
consensus manager and rounded out the HTTP surface (`/engines`, `/options`).
Phase 4 wires a React frontend with a Ketcher molecule editor and a bare
NMRIUM spectrum viewer — draw a structure, pick engines, and get a rendered
trace with bidirectional atom/peak highlighting.

## Run the app

From the project root on Windows:

```bat
run-nmr.bat
```

Modes:

```bat
run-nmr.bat all
run-nmr.bat backend
run-nmr.bat frontend
run-nmr.bat serve
```

- `all` starts backend and frontend dev servers in separate windows.
- `backend` starts only FastAPI on `http://127.0.0.1:8000`.
- `frontend` starts only Vite on `http://127.0.0.1:8080`.
- `serve` builds the frontend and serves both the SPA and API from FastAPI on
  `http://127.0.0.1:8000`.

Phase 1 (complete):

- FastAPI app ([backend/app/main.py](backend/app/main.py)) with `/health`,
  `/validate`, `/predict` endpoints.
- RDKit canonicalization
  ([backend/app/chem/canonical.py](backend/app/chem/canonical.py)) — single
  source of truth for atom ordering.
- ETKDGv3 conformer ensemble generator
  ([backend/app/chem/conformer.py](backend/app/chem/conformer.py)).
- Pydantic request/response schemas
  ([backend/app/schemas.py](backend/app/schemas.py)).
- Engine interface stubs
  ([backend/app/engines/base.py](backend/app/engines/base.py)).

Phase 2:

- **CDK engine** ([backend/app/engines/cdk.py](backend/app/engines/cdk.py)) —
  JPype bridge into the nmrshiftdb2 HOSE-code predictor. Atom ordering is
  anchored on RDKit's canonical SMILES and symbol-checked against CDK after
  hydrogen addition, so every atom index in the response matches the RDKit
  mol that canonicalization produced.
- **CASCADE engine** ([backend/app/engines/cascade.py](backend/app/engines/cascade.py))
  — the Paton-lab 3D graph neural network (DFTNN variant) ported from
  Keras 2.2 / TF 1.12 to Keras 3 + TensorFlow. The shipped HDF5 weights load
  by name against a rebuilt architecture; the `nfp` custom layers live in
  [backend/app/engines/cascade_nfp/](backend/app/engines/cascade_nfp/). Per
  prediction, the engine generates an ETKDGv3 ensemble (default 10
  conformers), runs the model per conformer, and Boltzmann-weights the
  per-atom shifts at 298.15 K.
- **ORCA engine** ([backend/app/engines/orca.py](backend/app/engines/orca.py)) —
  DFT NMR via subprocess. Cheap defaults
  (`! PBE def2-SVP NMR TightSCF`) are overridable through `ORCA_*` env
  vars. Two conformer strategies are selectable per request via
  `conformer_strategy`: `"fast"` (RDKit ETKDG+MMFF, default) or `"goat"`
  (ORCA XTB2 GOAT global search). Chemical shieldings are converted to δ
  ppm via a TMS reference computed once at the same (functional, basis)
  and cached on disk. All ORCA calls funnel through a single-worker job
  queue with an enforced timeout, bounded pending-request backpressure,
  and automatic workdir cleanup/pruning.
- Engine registry ([backend/app/engines/__init__.py](backend/app/engines/__init__.py))
  dispatches by name; missing/mis-configured engines return
  `status: "error"` rather than 500.
- Tests ([backend/tests/test_cdk_engine.py](backend/tests/test_cdk_engine.py),
  [backend/tests/test_cascade_engine.py](backend/tests/test_cascade_engine.py),
  [backend/tests/test_orca_engine.py](backend/tests/test_orca_engine.py))
  — unit checks always run; live prediction tests are skipped unless the
  respective assets (`CDK_JAR_PATH`, CASCADE model files, or
  `RUN_ORCA_TESTS=1` with ORCA on disk) are available.

## Run the backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate            # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

`backend/requirements.txt` is now a compiled lockfile with exact versions
and hashes. Edit [backend/requirements.in](backend/requirements.in) and
re-run `pip-compile` when you intentionally change backend dependencies.

Smoke tests:

```bash
cd backend
pytest
```

Sanity check:

```bash
curl -X POST http://localhost:8000/validate \
     -H "Content-Type: application/json" \
     -d '{"smiles": "c1ccccc1"}'
```

## Enabling the CDK engine

The CDK engine needs a Java runtime (JDK/JRE 11+ — JPype1 will pick it up
automatically if `JAVA_HOME` is set) plus `cdk-2.9.jar`. If you want
nmrshiftdb2-trained shift predictions, also drop `nmrshiftdb2.jar` into
the same folder.

1. Run the bundled fetch script (one-shot, ~43 MB download from the CDK
   GitHub release):

   ```bash
   python backend/scripts/fetch_cdk.py
   ```

   It drops `cdk-2.9.jar` into `backend/vendor/cdk/`. `run-nmr.bat`
   invokes this automatically on startup when the folder is empty.
2. (Optional) Download `nmrshiftdb2.jar` from
   <https://sourceforge.net/projects/nmrshiftdb2/> and drop it alongside
   the CDK bundle. Without it the engine still loads CDK, but shift
   prediction errors at runtime (the engine uses the nmrshiftdb HOSE
   tables).
3. No env var needed — `settings.cdk_jar_path` defaults to
   `backend/vendor/cdk/`. Override with `CDK_JAR_PATH` only if your jars
   live elsewhere.
4. Restart `uvicorn`. Run the live prediction tests:

   ```bash
   cd backend
   pytest tests/test_cdk_engine.py -v
   ```

Predict for ethanol:

```bash
curl -X POST http://localhost:8000/predict \
     -H "Content-Type: application/json" \
     -d '{"smiles": "CCO", "engines": ["cdk"], "nucleus": "13C"}'
```

If `CDK_JAR_PATH` is unset or the jar is incomplete, `/predict` still returns
a valid response — the CDK slot reports `status: "error"` with a message
pointing at the setup step that failed, so other engines continue to run.

## Enabling the CASCADE engine

CASCADE ships as a vendored clone of `patonlab/CASCADE`. Clone it into
`backend/vendor/cascade/` (expected layout: `backend/vendor/cascade/CASCADE/
cascade-Jupyternotebook-SMILES/models/cascade/` containing `preprocessor.p`
and `trained_model/best_model.hdf5`, `best_model_H_DFTNN.hdf5`). The default
`settings.cascade_path` resolves there automatically; override with
`CASCADE_PATH` if you keep the assets somewhere else.

Upstream CASCADE was written against Keras 2.2 / TensorFlow 1.12 (Python 3.5).
The backend ships a Keras 3 port of the custom `nfp` layers and the model
architecture in [backend/app/engines/cascade_nfp/](backend/app/engines/cascade_nfp/);
the ported architecture loads the shipped HDF5 weights by layer name.

```bash
# 1. Clone the upstream repo (once)
git clone https://github.com/patonlab/CASCADE backend/vendor/cascade/CASCADE

# 2. Install deps (tensorflow + keras + h5py are in requirements.txt)
cd backend && pip install -r requirements.txt

# 3. Smoke test — runs 10-conformer ethanol prediction for both nuclei
pytest tests/test_cascade_engine.py -v
```

Predict for ethanol via the API:

```bash
curl -X POST http://localhost:8000/predict \
     -H "Content-Type: application/json" \
     -d '{"smiles": "CCO", "engines": ["cascade"], "nucleus": "1H"}'
```

Notes on the install:

- TensorFlow dropped native Windows GPU after 2.10; the engine runs on CPU.
  For a 50-atom molecule × 10 conformers, a single-nucleus inference is
  typically sub-second.
- If the CASCADE assets are missing, `/predict` returns `status: "error"`
  for the CASCADE slot (same pattern as CDK) rather than failing the whole
  request.

## Enabling the ORCA engine

ORCA is invoked as a subprocess. Point the backend at the binary and pick
the level of theory you want; the defaults are tuned for speed, not
publication-quality accuracy.

Environment variables (all optional):

| Variable | Default | Notes |
| -- | -- | -- |
| `ORCA_EXE` | `C:\ORCA_6.1.1\orca.exe` | Absolute path to `orca[.exe]`. |
| `ORCA_FUNCTIONAL` | `PBE` | Any ORCA keyword (e.g. `B3LYP`, `B97-D3`). |
| `ORCA_BASIS` | `def2-SVP` | Any basis ORCA understands (e.g. `pcS-seg-1`). |
| `ORCA_CPUS` | `4` | `%pal nprocs` for each ORCA job. |
| `ORCA_RAM_MB` | `2000` | `%maxcore` per process, in MB. |
| `ORCA_WORK_DIR` | `./\_work/orca` | Where job dirs and `tms_refs.json` live. |
| `ORCA_TIMEOUT` | `600` | Hard timeout in seconds for each ORCA subprocess. |
| `ORCA_MAX_PENDING_REQUESTS` | `2` | Reject new ORCA-backed requests when the single-worker queue is already backed up. |
| `ORCA_JOB_TTL_SECONDS` | `3600` | Prune stale failed job directories older than this age. |
| `ORCA_RAM_CEILING_MB` | `8192` | Clamp `%maxcore` to a sane upper ceiling before writing ORCA inputs. |

Conformer strategy is picked per request (frontend-selectable later). Pass
`conformer_strategy` in the body:

- `"fast"` — RDKit ETKDG + MMFF, lowest-energy conformer. Default,
  sub-second overhead.
- `"goat"` — ORCA XTB2 GOAT global conformer search. Minutes of
  overhead; finds the global minimum across rotatable bonds.

The first prediction at a given `(functional, basis)` also runs a TMS
reference calculation to convert isotropic shielding σ → δ ppm. The
result is cached at `{ORCA_WORK_DIR}/tms_refs.json` so subsequent
predictions at the same level of theory skip TMS entirely.

Predict for ethanol via the API:

```bash
curl -X POST http://localhost:8000/predict \
     -H "Content-Type: application/json" \
     -d '{"smiles": "CCO", "engines": ["orca"], "nucleus": "13C", "conformer_strategy": "fast"}'
```

Run the ORCA engine tests — parser/unit tests always run; the live
end-to-end test is gated on `RUN_ORCA_TESTS=1`:

```bash
cd backend
pytest tests/test_orca_engine.py -v            # parser + registry checks
RUN_ORCA_TESTS=1 pytest tests/test_orca_engine.py -v   # also run the live methane test
```

Notes:

- All ORCA invocations are serialised through a single-worker thread
  queue so concurrent `/predict` calls don't trample each other (each
  ORCA job already saturates CPU via `%pal`). A hard per-job timeout is
  enforced, stale job directories are pruned automatically, and the
  pending-request queue is intentionally short so the service fails fast
  under load instead of growing unbounded.
- If `ORCA_EXE` is missing, the ORCA slot in `/predict` returns
  `status: "error"` with a path-specific message rather than failing
  the whole request.

Phase 3:

- **Consensus manager** ([backend/app/consensus.py](backend/app/consensus.py))
  — weighted reducer over per-engine results. Defaults follow the plan:
  `W_cdk=0.5`, `W_cascade=0.3`, `W_orca=0.2`. Engines with
  `status != "ok"` are dropped and the surviving weights are renormalised
  to sum to 1.0 so one failed engine does not bias the output. Per-atom
  output carries the weighted mean shift, the unweighted standard
  deviation across contributing engines (spread proxy), and the list of
  engines that reported for that atom.
- **`GET /engines`** — lists every registered engine with its
  `default_weight`, whether it is implemented, and readiness info the
  frontend can use to grey out unavailable engines before submit. CDK
  readiness now reflects a real warmup/import path rather than only file
  presence.
- **`GET /options`** — enumerates the valid values for `nuclei`,
  `modes`, `conformer_strategies`, and the set of engine names so the
  frontend can build dropdowns without hardcoding literals.
- **`POST /predict`** now accepts `mode: "consensus"` and an optional
  `weights` dict. When `mode == "consensus"` the response carries an
  extra `consensus` block with the merged shifts and the normalised
  weights actually applied.
- Tests ([backend/tests/test_consensus.py](backend/tests/test_consensus.py),
  [backend/tests/test_endpoints.py](backend/tests/test_endpoints.py))
  cover default weights, single/multi-engine averaging, error-drop
  renormalisation, override handling, partial atom coverage, and the
  HTTP shape of every endpoint.

## HTTP API

| Method & Path | Purpose |
| -- | -- |
| `GET /health` | Liveness probe — `{"status": "ok"}`. |
| `GET /engines` | Engine roster with default weights and readiness. |
| `GET /options` | Enumerates valid nuclei, modes, conformer strategies, and engine names for the UI. |
| `POST /validate` | Validates a SMILES string and returns its canonical form. |
| `POST /predict` | Runs the requested engines and (optionally) their weighted consensus. |

### `POST /predict` request body

```jsonc
{
  "smiles": "CCO",
  "engines": ["cdk", "cascade", "orca"],
  "mode": "consensus",                  // or "individual"
  "nucleus": "13C",                      // or "1H"
  "conformer_strategy": "fast",          // or "goat" (ORCA only)
  "weights": {"cdk": 0.6, "cascade": 0.3, "orca": 0.1}   // optional
}
```

The response is always `{canonical_smiles, atom_symbols, engines, consensus}`.
`consensus` is `null` when `mode == "individual"` and otherwise holds
`{shifts, weights_used}`, where `weights_used` reflects the
renormalisation applied after dropping any errored engines.

Consensus example for ethanol across all three engines:

```bash
curl -X POST http://localhost:8000/predict \
     -H "Content-Type: application/json" \
     -d '{"smiles": "CCO", "engines": ["cdk","cascade","orca"], "mode": "consensus", "nucleus": "13C"}'
```

Phase 4:

- **React + Vite frontend** ([frontend/](frontend/)) — TypeScript SPA
  served by Vite on `:8080`, talks to the FastAPI backend on `:8000`.
- **Explicit demo mode** — the frontend no longer fabricates chemistry
  responses when the backend is down. If you want demo data on purpose,
  set `VITE_NMR_ENABLE_DEMO_MODE=1`.
- **Ketcher molecule editor** ([frontend/src/components/nmr/MoleculeEditor.tsx](frontend/src/components/nmr/MoleculeEditor.tsx))
  — iframe-embedded Ketcher exposes a SMILES stream plus atom-click
  events that drive the highlight pipeline below.
- **Bare NMRIUM spectrum viewer**
  ([frontend/src/components/nmr/NmriumBareViewer.tsx](frontend/src/components/nmr/NmriumBareViewer.tsx))
  — composes NMRIUM's providers directly (no toolbar/panels) and feeds
  the viewer a synthetic `Spectrum1DSource` built from the per-atom
  shifts. The shape generator
  ([frontend/src/lib/nmr/nmrium.ts](frontend/src/lib/nmr/nmrium.ts))
  renders Lorentzian multiplets using backend-supplied `multiplicity`,
  `coupling_hz`, and `neighbor_count`; widths are tuned so J ≈ 7 Hz
  splittings resolve instead of blurring into one hump.
- **Bidirectional atom/peak highlighting** — an `InteractionBridge`
  inside the NMRIUM provider tree maps the pointer X-coordinate to ppm
  using the live `xDomain`/`margin`/`width` from `useChartData()`,
  finds the nearest signal, and drives Ketcher's
  `editor.selection({atoms: […]})` in [frontend/src/pages/Index.tsx](frontend/src/pages/Index.tsx).
  The inverse path — clicking an assignment card to jump to its atom —
  works the same way. A floating tooltip over the spectrum shows δ,
  integration, multiplicity, J, and the source engine.
- **Double-click zoom reset** — the bridge also attaches a native
  `dblclick` listener that dispatches `FULL_ZOOM_OUT` through the
  NMRIUM reducer, so double-clicking anywhere in the plot resets the
  view regardless of the current tool.
- **CDK bootstrap** — `settings.cdk_jar_path` now defaults to
  `backend/vendor/cdk/` and `run-nmr.bat` auto-runs
  [backend/scripts/fetch_cdk.py](backend/scripts/fetch_cdk.py) to pull
  `cdk-2.9.jar` from the CDK GitHub release when the folder is empty.
  No env var required for a fresh clone; drop `nmrshiftdb2.jar` into
  the same folder for the HOSE-code shift tables.
- **Signal grouping + splitting summary**
  ([frontend/src/lib/nmr/signals.ts](frontend/src/lib/nmr/signals.ts))
  — buckets per-atom shifts by `assignment_group`/engine, then emits a
  human-readable splitting line (e.g. `doublet: 1 neighbor (n+1 = 2
  lines) · J ≈ 7.2 Hz`) under each signal card.
- **ORCA Windows-path fix**
  ([backend/app/engines/orca.py](backend/app/engines/orca.py)) — the
  TMS subdir name is sanitised to `[A-Za-z0-9._-]` so basis strings
  like `def2-SVP` don't produce `pbe|def2-svp_…` which Windows rejects.

## Next phases (not yet implemented)

- **Phase 5** — strict QM timeouts, atom-map validation across engine
  outputs.
