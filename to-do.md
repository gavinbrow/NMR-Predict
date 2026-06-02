# Tensile Analysis Tab — Build To-Do

A phase-by-phase guide for adding a **Tensile** tab to the existing frontend app
(`frontend/`, Vite + React + TS + shadcn + React Router). The tab ingests zwickRoell/Instron
tensile Excel exports, computes the standard mechanical properties **client-side**, lets you
**compare multiple files**, and **exports** to Excel + PDF. No backend.

**Reference inputs in repo root**
- `tensile_analyze.py` — the working Python tool; port its math to TypeScript.
- `tit2-1_DCPD_PETMP_4-29-26.xlsx` — a sample file (6 specimens) to develop against.

**Properties the engine computes per specimen** (from `extract_run`):
Young's modulus (MPa/GPa) · tensile strength / UTS · strain @ UTS · yield strength + strain ·
0.2% offset yield + strain · stress @ break · elongation @ break · toughness (MJ/m³).

**Legend:** `[chosen]` = decided · `[opt]` = pick during the phase · ☐ = task

---

## Phase 0 — Add the tab to the existing app
**Goal:** a new `/tensile` workspace wired into the app, building on what's already there.

- ✅ Create `src/pages/Tensile.tsx` and register it as a route — follow the existing tab pattern (`SpectrumAnalysis`, `Kinetics`, `Maldi`, `IrKinetics`): add to the `KEEP_ALIVE` list in `App.tsx` so its state survives tab switches, and a nav entry in `AppShell` + a workspace card on `Home`.
- ✅ Create feature folders: `src/lib/tensile/` (parsing + compute) created; `src/components/tensile/` (UI) lands with its first real component in Phase 4 (empty dirs aren't tracked).
- ✅ Add only the **missing** deps — already present in `frontend/`: `exceljs`, `jspdf`, `idb`, `recharts`, `uplot`, radix `slider`, `vitest`. **Added:** `xlsx` (SheetJS read) `[chosen]`, `react-dropzone` `[chosen]`. Phase 5's data table was built on the existing shadcn `Table` rather than adding TanStack Table — no new dep needed.
- ✅ Keep everything in the existing strict-TS setup; compute/parsing logic in pure modules (`parseSheets`) so it's unit-testable.

**Acceptance:** ✅ the Tensile tab appears in the nav, opens to an empty workspace, `npm run build` succeeds, and `npm run typecheck` is clean for the new files.

---

## Phase 1 — Parsing layer (the input contract)
**Goal:** turn an uploaded `.xlsx` into a normalized in-memory model, faithful to the Python parser.

- ✅ Read workbook in-browser with `xlsx` (SheetJS); get per-sheet cell arrays (`workbookToSheets` / `parseWorkbook`).
- ✅ Implement the **skip-list**: never treat `Parameters`, `Results`, `Statistics`, `Comb. Results` (and variants) as raw data — ported `SKIP_SHEETS`.
- ✅ Port `_find_header`: scan first ~12 rows; detect strain columns via `("elong","strain","extension")` and stress via `("stress","force","load")`; pair each strain col with the nearest stress col to its right.
- ✅ Port `_strain_is_percent`: read the units row (header+1) → `%` ⇒ percent, `mm/mm`/`ratio` ⇒ fraction; default to percent.
- ✅ Extract numeric `[strain, stress]` pairs below the header; require `≥ 10` points per run.
- ✅ Port the **legacy fallback** `_detect_runs_numeric`: adjacent numeric column-pairs on one sheet, with the increasing-monotonicity heuristic (`fracIncreasing`) to decide which column is strain.
- ✅ Don't hardcode specimen count — discovered by scanning; runs labelled `<sheet>` or `<sheet> – run k` like the Python driver.
- ✅ **Report per file**: `ParsedWorkbook` carries `{ runs (N specimens), skippedSheets, strainUnit, detection }`; zero runs ⇒ `detection: "none"` for the UI to surface visibly.

**Acceptance:** ✅ parsing the real sample file detects 6 specimen sheets, skips `Parameters`/`Results`/`Statistics`, and reports strain unit `%` (verified end-to-end); 9 unit tests cover the header path, skip-list, ≥10-point rule, legacy fallback + monotonicity swap, and labelling.

---

## Phase 2 — Compute engine (find the values)
**Goal:** a pure TypeScript module that computes the properties, ported from the Python.

- ✅ Port `_clean` (`cleanCurve`): drop non-finite, convert strain→% if needed, sort by strain ascending, trim non-increasing leading preload points.
- ✅ Port `_linfit` (`linfit`): least-squares slope/intercept/R² via summations (no heavy math lib).
- ✅ Port `youngs_modulus`: regression over the strain window `eLo`→`eHi` (defaults `0.05%`→`0.25%`) when `n ≥ 3`; **chord** fallback via `interp` otherwise; `E = slope × 100`.
- ✅ Port `offset_yield`: offset line (default `offsetPct = 0.2`), first downward crossing with linear interpolation; `NaN` (→ "N/A") if it never crosses.
- ✅ Port `yield_point`: first stress maximum (ASTM D638); distinct intermediate yield only if a local max drops by `≥ peakDropFrac × UTS` and is below UTS; else yield coincides with UTS.
- ✅ Port `extract_run`: UTS + index, modulus, both yields, **toughness** via trapezoidal integration of stress vs strain-as-fraction; stress/elong @break follow the break definition (default = last point, matching Python).
- ✅ Port pooled stats (`summarize`): mean, **SD with `ddof = 1`** (0 for n=1), CV%, n, min, max; non-finite dropped first.
- ✅ JS pitfalls handled: numeric `sort` comparator; `argmax` (first max), `searchSortedLeft`, and trapezoid semantics replicated as standalone helpers.
- ✅ **15 sanity tests** (vitest, `compute.test.ts`): every property finite on a realistic curve, % vs mm/mm equivalence, run-to-run stability, offset-yield N/A on a linear curve, empty-curve all-NaN, break-definition behavior, and the stat helpers. *(No specific target values asserted.)*

**Acceptance:** ✅ verified end-to-end against the real sample file — all 6 specimens get a computed value for every property (e.g. E = 291.3 ± 93.0 MPa, UTS = 49.95 ± 4.66 MPa; yield coincides with UTS as the Python notes for these materials).

---

## Phase 3 — State model & store
**Goal:** a single source of truth the whole tab reads from.

- ✅ Defined types (`types.ts`): `Specimen` (raw curve + derived `props` + `excluded` + source file), `Material` (named group), `LoadedFile`, `AnalysisParams` (`eLo`, `eHi`, `offsetPct`, `peakDropFrac`, `breakDefinition`, `strainUnitOverride`), `Selection` (materials/specimens/property), plus `MaterialView` (resolved specimens + pooled stats).
- ✅ Store via **React Context + `useReducer`** `[chosen]` (matches the app's local-state patterns; no new dep): pure reducer in `store-core.ts` (unit-testable), Provider/hook in `store.tsx`. Holds files, specimens, materials, params, selection.
- ✅ **Derived recompute** memoized: changing `AnalysisParams` re-runs `extractRun` over all specimens once (`useMemo` keyed on specimens + params); material pooled stats derived on top.

**Acceptance:** ✅ changing a param re-derives every specimen's `props` (verified: modulus changes with the window; strain-unit override flips the interpretation); selection lives in the store and is shared across table/panel/chart. **10 reducer tests** (`store-core` add/remove/move/merge/split/exclude + recompute).

---

## Phase 4 — Upload flow (multiple files)
**Goal:** drag-and-drop several `.xlsx` at once, each shown as a card.

- ✅ `react-dropzone` `[chosen]` (`FileDropzone.tsx`): multi-file, click-to-browse, drag styling, `.xlsx`/`.xls` filter; non-matching files rejected with a toast.
- ✅ Each file rendered as a **card** (`FileCard.tsx`): filename, # specimens detected, strain unit, detection path, skipped sheets, remove (×); empty files flagged "No specimens".
- ✅ Adding more files later appends without disturbing existing ones (store `ADD_FILE`); a compact dropzone stays in the left rail.
- ✅ On drop → `parseWorkbook` (Phase 1) → store (recompute is automatic via Phase 2/3) → default one material per file (Phase 5). "No runs detected" surfaces as a warning toast + a red card badge.

**Acceptance:** ✅ dropping a file adds a card with its specimen count; a second drop adds another card; removing one (and its specimens/material) leaves the other intact (covered by the `REMOVE_FILE` reducer test).

---

## Phase 5 — Organize & sort the data
**Goal:** group specimens into materials (editable) and a sortable/filterable specimen table.

- ✅ **Default grouping `[chosen]`:** each workbook → one material, auto-named from filename via `materialNameFromFile` (verified: `tit2-1_DCPD_PETMP_4-29-26.xlsx` → `tit2-1_DCPD_PETMP`).
- ✅ Side-panel actions (`MaterialsPanel.tsx`): inline **rename**; **move** a specimen to another material; **exclude from stats** (checkbox); **merge** two materials; **split** selected specimens into a new material.
- ✅ **Outlier handling:** excluded specimens stay visible (greyed, dashed) on the chart and in the table but are dropped from mean ± SD.
- ✅ **Data table** (`SpecimenTable.tsx`) — built on the app's existing shadcn `Table` (no new dep; TanStack Table deferred as `[opt]`): one row per specimen, a column per property, **sortable** (N/A sinks to the bottom), label **search**, and a **hide-excluded** filter.
- ✅ Quick filter: hide excluded (top/bottom-N and within-X%-of-mean left as future `[opt]`).
- ✅ **Linked selection:** clicking a row toggles the specimen in the shared selection (highlighted in the table and used to drive the chart); clicking a material name highlights it.

**Acceptance:** ✅ sample file → one material with its 6 specimens as replicates; the table sorts by any property; excluding a specimen drops it from the pooled n / mean ± SD (verified: 6 → 5 included).

---

## Phase 6 — Live parameter tuning
**Goal:** sliders that recompute everything instantly.

- ✅ **Modulus window** `eLo`/`eHi` **dual-handle slider** over % strain `[chosen]` (built on the radix slider primitive — two thumbs, since the shadcn wrapper renders one).
- ✅ Controls for the offset value, peak-drop fraction, and **break definition** (last point / % drop from peak / stress threshold, each with its own sub-control).
- ✅ **Strain-unit override** (auto / force % / force mm/mm) for when auto-detect is wrong.
- ✅ **Presets** `[opt]`: ISO 527 / ASTM D638 / Custom dropdown that snaps the window + offset (auto-detects "Custom").
- ✅ **Live recompute** `[chosen]`: slider drags update a local mirror instantly and commit to the store **coalesced to one recompute per animation frame**, so dragging stays smooth (Web Worker remains the Phase 10 escape hatch for very large drops).
- ✅ **Visual feedback** (`StressStrainChart.tsx`): overlaid stress–strain curves (colored by material, excluded greyed), the **shaded modulus window**, the **fitted modulus + 0.2% offset lines** for a focused specimen, UTS/offset-yield markers, and an "elastic zoom" toggle to make the small-strain region legible.

**Acceptance:** ✅ dragging the modulus window live-updates the modulus, the per-material mean ± SD (`SummaryPanel`), and the shaded region/fit lines without freezing.

---

## Phase 7 — Compare charts (four views)
**Goal:** four chart views `[chosen]`, driven by a shared selection — the heart of multi-file compare.

- ✅ **Charting lib `[chosen]`:** stayed on `recharts` (already installed) for all four views — the dot-plot distribution avoids needing Plotly box plots; figure export is done by rasterizing the recharts SVG (`chart-image.ts`). Plotly left as a future `[opt]` only if true box plots are wanted.
- ✅ **View 1 — Overlaid stress–strain curves** (`charts.tsx` `OverlaidCurvesChart`): every shown specimen on one axis, colored by material, excluded greyed/dashed, hover tooltip + legend (auto-hidden past 12 series). Curves are cleaned + **decimated** to ≤400 display points (`decimateCurve`), full data kept for math.
- ✅ **View 2 — Bar + error bars** (`BarErrorChart`): one bar per material at mean ± SD (recharts `ErrorBar`), per-bar material color, optional individual-specimen dots toggle.
- ✅ **View 3 — Property-vs-property scatter** (`ScatterCompareChart`): X/Y property pickers (default modulus vs toughness), one point per included specimen, colored + legended by material.
- ✅ **View 4 — Distribution / dot plot** (`DistributionChart`): per-material spread of one property as colored dots with a mean ± SD diamond marker, exposing outliers.
- ✅ **Shared "what's shown" selector** `[chosen]`: the store `Selection` (materials / specimens / property) drives all four views *and* the table — selecting materials/specimens filters every view; the focused property (shared with `SummaryPanel`) drives the bar/distribution views.

**Acceptance:** ✅ all four views render in a tabbed `ComparePanel`, populate across materials, and react to the shared selection; built on the same pure builders (`compare.ts`) the export uses. **5 builder tests** (`compare.test.ts`) cover decimation + each builder over included/excluded specimens.

---

## Phase 8 — Show the instrument's own numbers (optional, informational)
**Goal:** when present, surface the machine's values next to the computed ones — for reference, not a pass/fail gate.

- ✅ Ported `read_machine_results` (`parse.ts` `readMachineResults`): reads the `Results` sheet keyed by `Specimen N` (`Et, sM, eM, sB, eB`) when it exists, surfaced on `ParsedWorkbook.machine` and attached per-specimen in `buildFromParsed` (matched by label, then sheet).
- ✅ Display computed vs instrument side-by-side (`SpecimenTable`): a "vs instrument" toggle renders the machine value (`inst …`) beneath the computed value in the five mapped columns (`MACHINE_MAP` in `compute.ts`). No tolerance, no pass/fail.
- ✅ Carried into the Excel + CSV exports: instrument columns are appended **only when present** (`machineColumns` filter), otherwise omitted entirely.

**Acceptance:** ✅ verified on the real sample file — it has a `Results` sheet, so the instrument's `Et`/`sM`/… appear next to the computed values (e.g. Specimen 1 `Et` = 397.6 MPa); files without one render and export identically minus those columns.

---

## Phase 9 — Export: Excel + PDF
**Goal:** one-click full report **and** per-figure / per-table export `[chosen]`. Both libs are already installed.

**Excel (`exceljs` `[chosen]`):** (`export.ts` `downloadExcel`)
- ✅ Styled multi-sheet workbook: `Properties (per run)`, `Summary` (mean ± SD / CV / n / min / max per material + a methods note), and a **`Comparison`** cross-material matrix; the four figures are embedded on a `Charts` sheet (ExcelJS has no native chart API). Instrument columns appear only when a `Results` sheet was present.
- ✅ Per-property number formats driven by `PROPERTY_META.decimals` (`numFmt`: E in MPa → `0.0`, GPa → `0.000`, stresses → `0.00`); CV → `0.0`.

**PDF full report (`jsPDF` + chart image `[chosen]`):** (`export.ts` `downloadPdf`)
- ✅ Title + source files; a short **methods paragraph** (ported from the Python `Summary` text via `methodsParagraph`); per-material summary tables (headline properties, mean ± SD / CV / n); the four comparison figures rendered to PNG. *(Dropped `jspdf-autotable` — it isn't an app dependency; tables are laid out directly with jsPDF text, matching the IR/kinetics report style.)*
- ✅ Figures are rasterized off-screen (`chart-image.ts` `renderElementToPng`) so all four are captured regardless of which compare tab is on screen.

**Per-figure / per-table:**
- ✅ Every compare figure: **PNG / SVG** download from the `ComparePanel` "This figure" menu (`downloadChartPng` / `downloadChartSvg`, serializing the live recharts SVG). PDF of a single figure is covered by the full report.
- ✅ Tables: **Specimens CSV** (per-run) and **Summary CSV** (comparison matrix) from the `ExportMenu`; the full Excel covers the per-table Excel case.

**Acceptance:** ✅ the Excel builds per-run + Summary + Comparison (+ Charts) sheets with correct number formats; the PDF contains the methods text, per-material tables, and all four figures; per-figure PNG/SVG and per-table CSV downloads work. (Build + typecheck clean; figure capture verified via the offscreen-render path.)

---

## Phase 10 — Persistence + performance (optional)
**Goal:** remember work between sessions; stay smooth on big drops.

- ✅ **Persistence** `[chosen]`: IndexedDB via `idb` (`persistence.ts`) — a single snapshot of the raw store state (files, specimens, materials, params, selection) is saved (debounced 400 ms) on every change and restored once on mount via a `LOAD_STATE` action. Only inputs are persisted; derived props/stats recompute on load. Fails soft (corrupt/oversized snapshot → start fresh); `clearAll` clears the snapshot too.
- ☐ **Web Worker** `[opt]`: **deferred.** The memoized recompute + rAF-coalesced slider commits keep typical loads smooth, so the worker wasn't needed for v1; it remains the escape hatch for very large multi-file drops.

**Acceptance:** ✅ reload restores files/groupings/params (snapshot round-trips through IndexedDB; `LOAD_STATE` backfills any newer param defaults). Dropping many files stays responsive via the existing memoized/coalesced recompute (worker deferred as the future escape hatch).

---

## Phase 11 — Verify & ship
**Goal:** confirm end-to-end, then build with the rest of the app.

- ✅ **Find the values:** compute engine is a line-by-line faithful port of the Python (`_clean`, `youngs_modulus`, `offset_yield`, `yield_point`, `extract_run`, stats); 15 compute tests + real-file run (E = 291.3 ± 93.0 MPa, UTS = 49.95 ± 4.66 MPa). TS is additionally robust to empty curves where Python `IndexError`s.
- ✅ **Variable specimen count:** parser is per-sheet (N specimens → N runs); stats pool over *included* specimens only. Covered by parse/store tests.
- ✅ **Legacy fallback:** numeric side-by-side detection + monotonicity column-picking tested in `parse.test.ts`.
- ✅ **Multi-file compare:** four compare builders unit-tested (`compare.test.ts`); `ComparePanel` wired with shared selection + per-figure PNG/SVG.
- ✅ **Parameter tuning:** recompute is `useMemo`-keyed on `[specimens, params]` and stays pure — changing a param re-runs compute across all specimens exactly once. (Live "smoothness" is a runtime UX property; the design avoids redundant work.)
- ✅ **Export round-trip:** Excel + PDF build sequences executed in a Node harness with representative data (incl. NaN→N/A, present/absent instrument cols, empty-material) — Excel `writeBuffer` (12 KB) and jsPDF `addImage`/`output` (valid PNG) both succeed; CSV builders are pure/exported.
- ✅ `npm run build` succeeds (`✓ built in 2.8s`); tensile typecheck clean; lint 0 errors (1 pre-existing fast-refresh warning); 42 tensile tests pass.

**Phase 11 review fix:** hardened the Phase 10 hydration against a lazy-mount race — if a snapshot resolves *after* the user has already dropped a file, the live workspace now wins instead of being clobbered ([store.tsx](frontend/src/lib/tensile/store.tsx)).

---

## Stack notes
- **Build into** the existing `frontend/` (Vite + React + TS + shadcn + React Router) as a new `/tensile` tab.
- **Already available:** `exceljs`, `jspdf`, `idb`, `recharts`, `uplot`, radix `slider`, `vitest`.
- **Added:** `xlsx` (SheetJS read), `react-dropzone`. The Phase 5 table reuses the existing shadcn `Table` (TanStack Table not needed); Plotly.js still optional for Phase 7 box plots / built-in image export.
- **No backend** — all parsing, math, charting, and file generation run in the browser.
