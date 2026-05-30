# MALDI Spectrum Interpretation — To-Do (frontend-only)

A new fourth top-level workspace (`/maldi`) alongside Spectrum analysis, Prediction, and
NMR Kinetics. **No backend** — all parsing, processing, peak picking, and interpretation run
in the browser, with heavy compute in a **Web Worker** so the UI never freezes. Persistence is
**IndexedDB**. Viewer = **uPlot**. Priority parser = **CSV/TXT**.
Raw data is preserved permanently; processed spectra are re-derived from stored parameters.

The existing FastAPI backend is **not touched** — it stays dedicated to NMR prediction.

Each phase below is self-contained and can be done independently in order.

---

## Phase 0 — Scaffold & shared infra ✅

- [x] Add deps to [package.json](frontend/package.json):
      `uplot`, `idb` (IndexedDB ergonomics), `ml-savitzky-golay`, `ml-matrix`,
      `ml-regression-polynomial`, `openchemlib` (isotope patterns).
- [x] `lib/maldi/elements.ts` — monoisotopic masses + natural isotope abundances for
      C, H, N, O, S, P, F, Cl, Br, I, Si, Na, K, Li, Ag, plus electron mass. Single source of truth.
- [x] `lib/maldi/types.ts` — shared types (Spectrum, Peak, Series, Adduct, ProjectState, request/result
      shapes for each worker op).
- [x] `lib/maldi/worker.ts` — Web Worker entry; message dispatcher routing to the compute modules.
      Instantiate via Vite: `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`.
- [x] `lib/maldi/workerClient.ts` — typed promise-based client wrapping the worker (request/response
      correlation, cancellation, error mapping). This replaces the old axios api layer.
- [x] `lib/maldi/project.ts` — IndexedDB open/save/load/list/delete skeleton (via `idb`).
- [x] `pages/Maldi.tsx` — workspace shell wrapped in `AppShell`.
- [x] Register route `{ path: "/maldi", element: <Maldi /> }` in `KEEP_ALIVE` in [App.tsx](frontend/src/App.tsx).
- [x] Add a MALDI `NavLink` in [AppShell.tsx](frontend/src/components/AppShell.tsx).
- [x] Add a MALDI `WorkspaceCard` in [Home.tsx](frontend/src/pages/Home.tsx).

---

## Phase 1 — Import + Viewer + Processing + Peak picking + Manual editing (MVP core) ✅

**Compute (`lib/maldi/`, runs in the worker)**
- [x] `parse.ts` — CSV/TXT: sniff comma/tab/space delimiters, optional headers,
      two-column (m/z, intensity) → `Float64Array` pair.
- [x] `processing.ts`:
  - [x] Baseline: SNIP, rolling-ball/top-hat (pure loops). ALS via a banded (pentadiagonal
        Cholesky) solver — all three ship behind the same UI.
  - [x] Smoothing: Savitzky–Golay (`ml-savitzky-golay`), Gaussian, moving average.
  - [x] Normalization: base peak, TIC, max intensity.
  - [x] Cropping: m/z range.
  - [x] Calibration: internal/external, linear + polynomial (`ml-regression-polynomial`) from a calibrant peak list.
  - [x] `downsample()` — min/max bucketing for full-spectrum view; full-res on zoom (in `view.ts`,
        dependency-free so it stays on the main thread without bloating the bundle).
- [x] `peaks.ts` — sliding-window local-noise S/N picking (no global threshold),
      min/max width, min intensity, local maxima, centroid, shoulder detection, isotope-aware mode.
      Presets: Conservative / Balanced / Sensitive / Low-res linear / High-res reflectron / Isotope-resolved.
      Each peak: m/z, intensity, local S/N, width, centroid, confidence.

**UI (`components/maldi/`)**
- [x] `ImportPanel.tsx` — CSV/TXT upload (drag-drop) + parse options.
- [x] `MaldiSpectrumPlot.tsx` — uPlot viewer: zoom / pan / reset, hover m/z+intensity readout,
      click-to-measure Δm, peak markers, linear & log y-scale,
      toggles (raw / processed / peak labels), export PNG.
      Downsampled full view; full-res on zoom. (SVG/PDF export deferred to Phase 3 `export.ts`.)
- [x] `ProcessingPanel.tsx` — baseline / smoothing / normalization / crop / calibration controls;
      **show active params** (assumptions visible), reorderable, individually toggleable.
- [x] `PeakPickingPanel.tsx` — preset selector + parameters + run (dispatch to worker).
- [x] `PeakTable.tsx` — shadcn `Table`: m/z, intensity, S/N, width, centroid,
      confidence, accept/reject; manual add / delete / merge / relabel / lock / ignore.
- [x] IndexedDB: persist raw + processed + ordered params + peaks; raw never overwritten.

---

## Phase 2 — MALDI interpretation differentiators ✅

**Compute (`lib/maldi/`, in the worker)**
- [x] `adducts.ts` — built-in [M+H]+, [M+Na]+, [M+K]+, [M+Li]+, [M+NH4]+, [M+Ag]+ +
      custom adducts; deltas from `elements.ts`.
- [x] `library.ts` — matrix/background library (DHB, DCTB, CHCA, dithranol, SA, matrix
      clusters, Na/K salt peaks, plasticizer, slip-agent contaminants). **Flag**, never delete.
- [x] `polymers.ts` — pairwise Δm histogram → candidate repeat units; build series
      `m/z ≈ end_group + n·repeat + adduct` (residual-modulo-repeat clustering per adduct);
      score (matched peaks, consecutive run, mean error); multiple overlapping
      series + multiple adduct series; accept user-supplied or auto-detected repeat unit.
- [x] `kendrick.ts` — Kendrick mass + mass defect for a base repeat unit (auto-filled from
      detected spacing); KMD cluster → peak/series mapping.
- [x] `endgroups.ts` — solve residual end-group masses given repeat + adduct; match library;
      return residual, error, compatible adduct, matching oligomer count, confidence.

**UI (`components/maldi/`)**
- [x] `AdductPanel.tsx` — choose likely adducts before annotation; custom adducts.
- [x] `SeriesPanel.tsx` — detected repeat units + candidate series with scores,
      matched/unmatched peaks, manual correction, rerun after edits.
- [x] `KendrickPlot.tsx` — uPlot scatter KMD plot; base repeat-unit selector
      (auto-filled); click cluster → highlight matching spectrum series.
- [x] `EndGroupPanel.tsx` — end-group inputs + candidate table.
- [x] Background/matrix flagging in viewer + table; warning chips (low confidence, possible
      matrix/salt/isotope peak, overlapping series, insufficient consecutive peaks).

---

## Phase 3 — Formula/isotope tools, molecular weight, export & report ✅

**Compute (`lib/maldi/`, in the worker)**
- [x] `formula.ts` — formula mass calculator (exact + nominal) from `elements.ts`; isotope pattern
      simulation (convolve element abundances; correct Cl/Br/Ag/S envelopes);
      formula-candidate generator within tolerance over the supported element set.
      (Convolution is hand-rolled from `elements.ts`, so `openchemlib` is not needed here.)
- [x] `molweight.ts` — MALDI-apparent Mn, Mw, Đ, peak max, DPn, DPw from all peaks /
      assigned-series / manually selected / intensity-thresholded subsets; results labelled MALDI-apparent.

**UI (`components/maldi/`)**
- [x] `FormulaTools.tsx` — formula calc; overlay simulated isotope pattern on a peak (green sticks).
- [x] `MolWeightPanel.tsx` — Mn/Mw/Đ/DPn/DPw with MALDI-apparent labels + source selector.
- [x] `lib/maldi/export.ts` — annotated PNG (uPlot), processed-spectrum CSV, peak-table CSV,
      series table CSV, full project JSON (also import format), Excel + PDF report
      (reuse [kineticsExport.ts](frontend/src/lib/nmr/kineticsExport.ts) patterns).
- [x] Full project save/load/import via IndexedDB + export history; reloading reproduces the exact view.

---

## Phase 4 — Later (out of MVP) ✅

- [x] mzML / mzXML / MGF parsing (`parseMs.ts`, pure-JS, runs in the worker; native DecompressionStream for zlib).
- [x] Batch processing + batch repeat-unit detection (`BatchPanel.tsx`, sequential worker runs).
- [x] Multi-spectrum comparison, overlay, difference spectrum, before/after reaction
      (`CompareView.tsx` + multi-document tray with overlay / stacked view modes).
- [x] Copolymer / alternating repeat detection (`detectCopolymer` in `polymers.ts`).
- [x] Fragment / loss detection (`losses.ts` + `LossPanel.tsx`).
- [x] AI-assisted explanation of assignments — implemented as a **transparent rule-based**
      interpretation (`interpret.ts`); no cloud/LLM is used (frontend-only constraint).
- [x] Built-in polymer repeat-unit / matrix / adduct libraries + user chemistry templates
      (`repeatLibrary.ts`, `TemplatePanel.tsx`, templates persisted in IndexedDB).
- [x] Negative-mode adducts (`NEGATIVE_ADDUCTS`: [M−H]⁻, [M+Cl]⁻, [M+HCOO]⁻, [M+CH3COO]⁻).
- [ ] ProteoWizard / msconvert vendor-RAW conversion — a native binary, run outside the app (out of scope).
- [x] Publication-ready report builder (PDF + Excel report in `export.ts`).

### Viewer fixes / polish (post-Phase-4 requests)
- [x] x-axis renders m/z (uPlot `scales.x.time = false`) — was showing a time axis.
- [x] No more crash when zooming far in (`buildView` always returns ≥2 points).
- [x] Double-click to zoom out / step back (zoom history) + a Reset-zoom button.
- [x] Scroll wheel scales the y-axis to reveal small peaks without zooming x.
- [x] Selected-series peaks drawn as bright bold stems; "Highlight all series" + per-series.
- [x] "Isolate selection" mode hides everything except the selection for a clean diagram.
- [x] KOtBu and other alkoxide/alcohol-base end groups added to the auto-detect library.

---

## Guardrails (enforce throughout)

- Run all non-trivial compute in the Web Worker; keep the main thread responsive. Support cancel.
- Never assume all peaks are [M+H]+; require user-selected adducts and offer Na/K/etc.
- No single global intensity threshold — use local-S/N windows.
- Never auto-delete isotope or matrix/background peaks — flag them.
- Never overwrite raw data; processed is always re-derivable from stored params.
- Keep all processing parameters visible.
- Label molecular-weight values MALDI-apparent; don't imply quantitative intensities.
- Don't assign formulas peak-by-peak without series-level evidence.
- Keep automation reversible (manual accept/reject everywhere); show multiple plausible
  assignments with confidence rather than one "answer."

---

## Verification

**Unit tests (vitest, `frontend/src/lib/maldi/__tests__/*.test.ts`)**
- [x] Synthetic PEG MALDI fixture (Δm = 44.0262 Da, +Na adduct, H/OH end groups, ¹³C isotopes,
      noise gradient + baseline).
- [x] `parse` delimiter/header variants → correct arrays.
- [x] `processing` round-trips; raw array unchanged.
- [x] `peaks` recovers known synthetic peaks; local-S/N beats global threshold on noise-gradient.
- [x] `polymers` detects ~44 Da repeat + correct consecutive series & scores.
- [x] `kendrick`, `endgroups` (residual + library match, incl. alkoxide bases).
- [x] `formula` (exact/nominal mass, RDBE, Cl/Br/Ag/S isotope envelopes, candidate search).
- [x] `molweight` (Mn/Mw/Đ/DPn/DPw), `losses`, `copolymer`, `parseMs` (mzML/mzXML/MGF),
      negative-mode `adducts`. (68 MALDI unit tests total.)

**End-to-end (manual)**
- [ ] `npm run dev` (vite :8080) — no backend needed for `/maldi`. Open `/maldi`.
- [ ] Upload CSV → process → pick peaks → detect repeat (~44 Da) → assign series → Kendrick
      (cluster click highlights series) → export PNG + CSV + project JSON.
- [ ] Save project, reload page, reopen from IndexedDB → identical view & results.
- [ ] Re-run series detection after a manual peak edit → assignments update.
- [ ] Confirm the UI stays responsive during peak picking / isotope sims (worker offloading).
