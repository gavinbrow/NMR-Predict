# IR Kinetics — To-Do (frontend-only add-on tab)

A new top-level workspace (`/ir`) alongside Spectrum analysis, Prediction, NMR Kinetics, and
MALDI. **No backend** — all `.ispd` parsing, baseline math, peak measurement, and kinetics
fitting run entirely in the browser. Files are read locally, never uploaded, never modified.
The existing FastAPI backend is **not touched**.

This is a faithful port of a working Streamlit/Python app. Treat all numeric constants, byte
offsets, and formulas as **exact** — get the parser and numerics right first (load-bearing),
then build the UI on top.

**Stack note:** the repo already has `exceljs`, `jspdf`, `ml-matrix`, `uplot`, `recharts`.
The original spec was written against Plotly, but to stay consistent with the existing codebase
this port uses **uPlot** for all charts (it's already used in the MALDI workspace). uPlot covers
everything the spec needs: canvas rendering for many spectra × many points (the spec's `scattergl`
intent), reversed x-axis via `scales.x.dir = -1`, drag-selection via the `setSelect` hook (powers
box-select-to-window), drag-zoom, and PNG export for the PDF via the chart canvas `toDataURL`.
Only a **Levenberg–Marquardt** fitter (`ml-levenberg-marquardt`) must be added.

**uPlot mapping cheatsheet** (referenced throughout):
- Reversed x: `scales: { x: { dir: -1 } }` (high cm⁻¹ on the left).
- Many series: one `series` entry per spectrum; canvas keeps it fast — no WebGL needed.
- Box-select-to-window: enable `select` + listen to the `setSelect` hook, read
  `u.posToVal(u.select.left, "x")` and `u.posToVal(u.select.left + u.select.width, "x")`.
- Zoom vs set-window: toggle behavior in the `setSelect` hook (zoom = `u.setScale`, set-window =
  apply the band to peak state); a custom cursor/drag flag stands in for Plotly's dragmode radio.
- Tracked/reference window shading: a custom `drawClear`/`draw` plugin that fills the vrect band(s).
- PNG for PDF: grab `u.ctx.canvas.toDataURL("image/png")` after render.

Each phase is self-contained and can be completed independently in order.

---

## Phase 0 — Scaffold, deps & tab wiring

- [x] Add dep to [package.json](frontend/package.json): `ml-levenberg-marquardt` (`^5.0.1`).
      (`uplot`, `exceljs`, `jspdf` already present.) Installed with `--legacy-peer-deps` (the repo's
      existing vite@8 / plugin-react-swc peer mismatch requires it).
- [x] [IrChart.tsx](frontend/src/components/ir/IrChart.tsx) — thin reusable uPlot wrapper (sizing via
      ResizeObserver, imperative `getPng`/`getPlot` handle, `reversedX` option, window-shading plugin
      via the `drawClear` hook, `dragMode` zoom/select toggle with `onSelectWindow` callback). Recreates
      only on structural change; data/band updates take cheap `setData`/`redraw` paths.
- [x] [types.ts](frontend/src/lib/ir/types.ts) — shared types: `Spectrum` (§2c), `KineticsResult`,
      `OrderFit`, `KineticsReport`, `BaselineMethod` enum (+`BASELINE_METHODS`), `PeakConfig`,
      `MeasureMode`/`WindowBaseline`/`TimeUnit`/`YAxis`.
- [x] [IrKinetics.tsx](frontend/src/pages/IrKinetics.tsx) — workspace shell wrapped in `AppShell`
      (empty state with the View & Export / Kinetics blurbs; file picker & modes land in Phase 4).
- [x] Registered route `{ path: "/ir", element: <IrKinetics /> }` in `KEEP_ALIVE` in
      [App.tsx](frontend/src/App.tsx).
- [x] Added an IR `NavLink` (to `/ir`) in [AppShell.tsx](frontend/src/components/AppShell.tsx).
- [x] Added an IR `WorkspaceCard` (Waves icon) in [Home.tsx](frontend/src/pages/Home.tsx).
- [x] Typecheck + lint clean on all new/edited files; tab renders and routes (no functionality yet).

---

## Phase 1 — `.ispd` parser (Berkeley DB → records) — load-bearing, build first

**[bdb.ts](frontend/src/lib/ir/bdb.ts)** — pure byte math over an `ArrayBuffer` via `DataView`. No
native lib. Exposes `parseBdb(buffer) → { byteOrder, pageSize, records }`.

- [x] Read meta page 0: magic `uint32 @12 == 0x00061561`; detect byte order (LE first, then BE,
      else error "not a BDB hash file"). Page size `uint32 @20` ∈ {512…65536} and an exact divisor
      of file length; `npages = fileLength / pagesize`.
- [x] Per-page 26-byte header; byte 25 = page type.
- [x] Hash data pages (type 2 or 13): entry count `u16 @20`; `inp` offset array `u16` from `@26`
      (`inp[i] = u16(base+26+2i)`). Item ends at next-higher valid offset in `inp` (or pagesize).
- [x] Items alternate key, data, key, data… Item type byte at `off`:
      - type 1 (inline): bytes `off+1 .. itemEnd`.
      - type 3 (off-page): first-page `u32 @off+4`, total length `u32 @off+8`; follow overflow chain.
      - else: skip (null).
- [x] Overflow pages (type 7): bytes-on-page `u16 @22`, next-page `u32 @16` (0 = end), payload `@26`.
      Walk chain reading `min(u16@22, remaining)` from `@26`; stop on pgno 0, out-of-range, repeat
      (seen-set cycle guard), or page type ≠ 7.
- [x] Assemble `records` (`Map<string, Uint8Array>`, key = raw key bytes encoded 1:1 as latin1 so it
      round-trips as a Map key), pairing `vals[2k]`/`vals[2k+1]` when both non-null.
- [x] **All BDB structure reads use detected byte order; scientific-payload doubles are always
      little-endian** (do NOT apply detected order to doubles — enforced downstream in spectrum.ts).

---

## Phase 2 — records → `Spectrum`

**[spectrum.ts](frontend/src/lib/ir/spectrum.ts)** — `recordsToSpectrum(records, name)` + the browser
loader `loadSpectra(files)`.

- [x] Key lookup helper: keys are ASCII `"<id> <code> "` possibly with trailing `\x00`; `keyParts`
      strips trailing NULs (via `stripTrailingNuls`, not a control-char regex — ESLint `no-control-regex`),
      trims, splits on whitespace, drops empties. `indexRecords` keys by `"<id> <code>"`.
- [x] Object selection: collect ids whose key second-part is `"100008"` (discovery order); read each
      object's `100001`, decode x-unit, select first whose normalized unit ∈ {`cm-1`, `1/cm`, `cm^-1`};
      else error "No wavenumber spectrum found." (interferogram `cm` objects are skipped).
- [x] Unit-string decode (100001/100003): `decodeUnitLabel` — length < 13 → `""`; else NUL-terminated
      latin1 from byte 12.
- [x] Data array (100008): `readFloat64ArrayLE` — `n = floor(byteLength/8)`, `n` **LE** float64.
- [x] Wavenumber range from 100001: `findWavenumberRange` scans `pos`; matches `u32==n`, needs
      `pos+60 <= length`, reads LE `xmin@+20`/`xmax@+36`/`interval@+52`; requires all finite,
      `20 < xmin < xmax < 9000`, `interval > 0`, `abs(interval − step)/step < 0.01`. First valid wins,
      else error "Could not locate a valid wavenumber axis."
- [x] Build `x = linspace(xmin, xmax, n)` (no reverse), argsort ascending, reorder x and y together.
- [x] A/%T: read 100003 y-unit; if lowercased contains "t" OR `max(y) > 5` → %T (`absorbance =
      2 − log10(max(y,1e-6))`); else A (`transmittance = 100·10^(−y)`).
- [x] Returns `Spectrum` (§2c): `wavenumber`, `absorbance`, `transmittance`, `name`, `rawYUnit`,
      `meta {nPoints, xmin, xmax}`.
- [x] `loadSpectra(files)` reads each File → ArrayBuffer (never mutated), parses via Phase 1–2, caches
      by `name:size:FNV-1a(content)`, and collects per-file errors as `"<filename>: <message>"`.

---

## Phase 3 — Numeric helpers & baseline correction

**[numerics.ts](frontend/src/lib/ir/numerics.ts)**

- [x] `linspace(a,b,n)` (endpoint pinned), `trapezoid(y,x)` (non-uniform x), `interp(xNew, xp, fp)`
      (numpy-style linear, binary search, clamped ends), `polyfitDeg1(x,y) → {slope, intercept}` (OLS).
- [x] `naturalKey(name)` (digit runs → numbers, other runs → lowercased) + `naturalCompare` (numbers
      before strings on type clash) so `file2 < file10`.
- [x] `convexHull` — Andrew's monotone chain, CCW vertices (for rubberband).

**[baseline.ts](frontend/src/lib/ir/baseline.ts)** — re-exports `METHODS`; `computeBaseline` returns the
baseline, `correctBaseline` returns `absorbance − baseline`. All in absorbance space.

- [x] None → zeros. Offset → constant NaN-ignoring `min(absorbance)`.
- [x] Linear (2-point) → anchors `x1` (default `wn.max()`), `x2` (default `wn.min()`) or user `p1/p2`;
      anchor value = NaN-ignoring mean of `absorbance[i-3 .. i+3]` (clamped) at nearest index; line
      through `(x1,y1),(x2,y2)`; `x1==x2` → constant `y1`.
- [x] Rubberband → lower convex-hull envelope: <3 pts → constant min; else `convexHull`, roll to
      lowest-x vertex, forward run to highest-x vertex, interp across all wavenumbers; on failure
      (try/catch) fall back to constant min.

**Shared ([shared.ts](frontend/src/lib/ir/shared.ts))**

- [x] `commonGrid(specs)` = wavenumber of densest spectrum. `displayY(spec, yaxis, method, p1, p2)` —
      baseline-correct in A; return A or `100·10^(−A)`. `buildTable(...)` → `{headers, grid, rows}`:
      interp each `displayY` onto the common grid; wide table `wavenumber_cm-1` + one column per
      `spec.name`.

---

## Phase 4 — App shell, file input & empty state

[IrKinetics.tsx](frontend/src/pages/IrKinetics.tsx) rewritten with a persistent sidebar + main panel.

- [x] Sidebar (always visible): title "IR Kinetics", caption "Shimadzu IRAffinity-1S .ispd reader";
      multi-file picker accepting `.ispd` only; after load, a **Mode** radio (View & Export, Kinetics)
      and "N spectrum/spectra loaded" (correct singular/plural). Per-file errors surfaced in a
      destructive-styled panel.
- [x] Empty state (no files): centered "IR Kinetics" + View & Export / Kinetics blurbs (`EmptyState`).
      Sidebar-left / main-right flex layout.
- [x] File reading via `<input type="file" multiple accept=".ispd">` → `loadSpectra` (Phase 1–2);
      results sorted by `naturalCompare(name)`; per-file errors collected and shown. Kinetics mode shows
      a `KineticsPlaceholder` until Phases 7–9.

---

## Phase 5 — Mode: View & Export

**[ViewExport.tsx](frontend/src/components/ir/ViewExport.tsx)** (title "View & Export") +
**[export.ts](frontend/src/lib/ir/export.ts)** (CSV/Excel downloads).

- [x] Y-axis radio (%T default, Absorbance), horizontal.
- [x] Baseline select (§6 methods, default None) + per-method help text. If "Linear (2-point)":
      Anchor 1 default `round(grid.max())`, Anchor 2 default `round(grid.min())`, step 1 → `p1,p2`.
- [x] "Spectra to display" checkbox list (scrollable, with All/None); if >15 files default to a thinned
      `names[::max(1, len//12)]` subset, else all; resets when the loaded set changes; help text noting
      export always uses all.
- [x] Overlay uPlot chart (via `IrChart`): one line series per selected spectrum, interp'd onto the
      common grid (uPlot needs one shared x), y=`displayY(...)`, label=spec name, palette stroke.
      **X-axis reversed**. Y label "Transmittance (%T)" / "Absorbance". Legend only when ≤20 displayed.
      Height 560. Empty-selection guard message.
- [x] Export section: `buildTable` over **all** spectra; caption with N, M-point grid, yaxis, baseline
      note (anchors shown for Linear); preview first 20 rows (wavenumber `.1f`, values `.4f`).
- [x] Downloads: CSV (`ir_spectra.csv`, hand-rolled `tableToCsv`) and Excel (`ir_spectra.xlsx`, one sheet
      named after the y-axis, data table only via `exceljs`); Excel bytes cached by FNV-1a content hash.

---

## Phase 6 — Mode: Kinetics — measurement & fitting math

**[kinetics.ts](frontend/src/lib/ir/kinetics.ts)** (port exactly — §8) +
**[kinetics.test.ts](frontend/src/lib/ir/__tests__/kinetics.test.ts)**.

- [x] `measurePeak(wn, abs, center, halfwidth, mode, baseline)`: window mask
      `center−hw ≤ wn ≤ center+hw` (empty → NaN); per-window baseline ("none"/<2pts → zeros; "linear" →
      `k=max(1,floor(len/10))`, line through means of first/last k points, constant `y0` if `x1==x0`);
      `corrected = windowAbs − baseline`; area → `trapezoid(clip(corrected,0,∞), wn)`, height →
      `max(corrected)` (NumPy-style, NaN-propagating).
- [x] First-order model `S(t) = S∞ + (S0−S∞)·exp(−k·t)` (`firstOrder`).
- [x] `analyze(time, signal, reference?)`: reference-divide (r=0/non-finite → NaN → dropped); keep
      finite pairs; `s0=s[0]`, `s_min=nanmin(s)`; conversion `(s0−s)/s0` (zeros if s0==0); if ≥3 pts
      LM-fit (`ml-levenberg-marquardt`, central differences) with `p0=(s0, s_min, 1/max(tmax,1e-9))`;
      derive R², `half_life=ln2/k` (NaN if k≤0), `final_conversion=(fittedS0−S∞)/fittedS0`,
      `fit_ok = isFinite(k)&&k>0`; 200-pt `tFit/sFit` only when fit ok; on failure `fit_ok=false` but
      still return points + conversion. Returns `KineticsResult`.
- [x] `fitOrders(time, signal, reference?, timeUnit, signalUnit)`: ref-normalize, keep finite; three
      models — 0: `y=S`, `k=−slope`, units `S/t`, valid all; 1: `y=ln(S)`, `k=−slope`, units `1/t`,
      valid `S>0`; 2: `y=1/S`, `k=+slope`, units `1/(S·t)`, valid `S≠0`. Drop invalid/non-finite; <3 →
      `ok=false`; else deg-1 fit, R², record `t,y,y_fit,n`. Returns `OrderFit[]`.
- [x] Unit tests (11) for measurePeak / analyze / fitOrders against hand-computed values — all pass
      (LM recovers k≈0.5 at R²>0.999 on a synthetic first-order decay).

---

## Phase 7 — Kinetics UI: steps 1–4 (setup & overlay)

**`src/components/ir/Kinetics.tsx`** (title "Kinetics" + caption)

- [x] **Step 1 — Time series order & spacing** (expanded): sort by `naturalCompare`; controls Time
      between spectra (default 1, min 0), Time unit (min default, s, h), Start t₀ (default 0);
      default times `t0 + interval*[0,1,…]`; editable table (order, file read-only; time editable).
      Default times regenerate when the spectra set / interval / t₀ change (render-time key compare);
      per-row edits persist until then.
- [x] **Step 2 — Baseline correction** (collapsed): §6 options (Linear → two anchors defaults
      `round(grid.max())`, `round(grid.min())`). Builds `absStack` `[nSpectra][nGrid]`:
      `correctBaseline` in A then `interp` onto the common grid.
- [x] **Step 3 — Peak to track** (expanded): Peak center (default 2570), Half-width (default 25,
      min 1), Measure (height/area), per-window Baseline (linear/none). Checkbox "Normalize to a
      reference (non-reacting) peak" → Ref center (1730), Ref half-width (25, min 1), Ref measure,
      Ref baseline.
- [x] **Step 4 — Overlay with tracked window**: Display y-axis radio (%T default, Absorbance —
      overlay only), Drag-on-plot radio (Zoom default, Set window). Set-window reads the dragged band's
      `[lo,hi]` via `IrChart`'s `onSelectWindow` → `center=round((lo+hi)/2,1)`,
      `half=max(round((hi−lo)/2,1),1)`. Reference + Set-window → third radio "Band sets": Track /
      Reference (routes the band to the tracked or reference peak).
- [x] Step-4 chart ([Kinetics.tsx](frontend/src/components/ir/Kinetics.tsx) via `IrChart`): one line
      per spectrum over the grid; y from `dispStack` (absStack or `100·10^(−A)`), label=`"{time} {unit}"`;
      **x reversed**; legend ≤20. Translucent bands for the tracked window (light salmon) and reference
      window (green, when enabled). Initial visible x-range `[center−pad, center+pad]` (orientation via
      `reversedX`), `pad=max(hw*4,150)`. Drag behavior toggles on the radio: Zoom → `dragMode="zoom"`
      (uPlot zoom, double-click resets); Set window → `dragMode="select"`, the band updates peak state.

---

## Phase 8 — Kinetics UI: steps 5–7 (gated run, results, order comparison)

- [x] **Step 5 — Measure & analyze** (gated): primary button "▶ Run / Update analysis". Input
      signature = JSON of (center, halfwidth, measure, per-window baseline, use-ref, ref tuple, step-2
      baseline + anchors, timeUnit, times, nSpectra); if signature ≠ last run, amber "Inputs changed
      since the last run…" warning. On run: measure tracked peak in every spectrum, optionally
      reference, call `analyze` + `fitOrders`, store results (with the finite-pair-aligned raw/ref
      arrays); the export cache key is the signature, so a new run invalidates prior PDF/Excel. Until
      the first run, an info note + nothing below.
- [x] **Step 6 — Result plots & fit summary**: two side-by-side `IrChart`s —
      Peak disappearance (markers via a points-only series with a null path builder + dashed fitted
      `S(t)` line on the 200-pt dense grid; markers/fit share an x = union of measured times and `tFit`,
      NaN-gapped; y label "peak signal (ratio to ref)" or "peak signal ({mode})");
      Conversion (conversion·100% markers + dashed first-order trend from the fitted S(t) normalized by
      measured S₀ + dotted horizontal at fitted final conversion). 4-metric row: fit OK → Rate k
      `{:.4g}/{unit}`, Half-life `{:.4g} {unit}`, Final conversion `{:.1f}%` (+ help), R² `{:.4f}`;
      else amber warning + Final conversion (data) = `nanmax(conv)·100%`.
- [x] **Step 7 — Reaction order (0/1/2)**: table (Order, Linearized "{transform} vs t", R² `.4f`,
      Rate k `.4g`, k units) with the best-fit row highlighted; best-fit summary + caption "Signal S
      measured as {ratio to reference|height|area}"; all orders `<3` valid → warn. Select "Show
      linearized plot for" (default = best, invalid orders disabled) → `IrChart` of the chosen order's
      transformed points + straight-line fit, captioned with R²; too-few-points → info note.

---

## Phase 9 — Kinetics exports (CSV / PDF / Excel)

**[report.ts](frontend/src/lib/ir/report.ts)** — consumes a `KineticsReport` (§9 shape).

- [x] Output table columns `time_{unit}, signal_{unit}, conversion_pct`; with a reference also
      `raw_{mode}_{center}` and `ref_{rmode}_{rcenter}` (`buildReportTable`). Conversion exported as %.
- [x] CSV (`kinetics.csv`, CRLF, non-finite → blank cell).
- [x] Shared summary lines (`summaryLines`: peak tracked, reference, spectra count, k, half-life,
      final conversion, R²; or the not-converged message + data-based final conversion).
- [x] PDF (`kinetics_report.pdf`, jsPDF **portrait letter**): bold title, monospace summary block, the
      two chart PNGs (Peak disappearance, Conversion) grabbed from the live uPlot canvases via the
      `IrChart` `getPng()` handle, and — when order rows exist — a second page "Reaction order — fit &
      compare (0/1/2)" with an em-dash table for non-finite/failed orders.
- [x] Excel (`kinetics.xlsx`, ExcelJS): Summary sheet (title A1 bold 14, summary lines down col A from
      row 3, width 60, order-comparison table); Kinetics sheet (data block `time_{unit}`,
      `signal_{unit}`, `conversion_pct` + raw/ref cols; fit block a couple columns to the right); Charts
      sheet embedding the two plot PNGs. **Note:** ExcelJS has no native chart API, so per the spec's
      fallback the charts are embedded as the captured images (data blocks are written alongside so the
      reader can build native Excel charts).
- [x] PDF/Excel bytes cached by the run signature (passed as the cache key); a new run → new signature
      → fresh bytes.

---

## Phase 10 — Acceptance pass (§11)

- [x] Reads a real `.ispd` purely in-browser (no network); selects the cm-1 object; ascending
      wavenumber with both A and %T. Verified against a genuine Shimadzu file
      (`1.5_1_1_DCPD_NORB_PETMP_3-18-26_150C_Very_Yellow1.ispd`) via a `describe.skipIf` smoke test
      ([realfile.smoke.test.ts](frontend/src/lib/ir/__tests__/realfile.smoke.test.ts)) — parsed 1868
      points over 399.3–4000.4 cm⁻¹, %T y-unit, finite A/%T, strictly ascending. (Test skips itself when
      the fixture is absent, so removing the local file keeps the suite green.)
- [x] View & Export: reversed-x overlay, all four baselines, matching CSV + Excel on common grid.
- [x] Kinetics: natural-sort + editable times; full-spectrum baseline; type-or-drag window (+ ref);
      gated Run; first-order fit (k, half-life, final conversion, R²); 0/1/2 comparison + linearized
      plot; CSV/PDF/Excel (charts embedded as captured PNGs — ExcelJS has no native chart API).
- [x] Math matches §6 and §8 exactly (kinetics math unit-tested, 11 cases); no input-file mutation
      (files read into ArrayBuffers, never written); graceful per-file errors (collected as
      `"<filename>: <message>"`).
- [x] Domain conventions (§10): x always reversed (`reversedX`); all math in absorbance; %T↔A clamp
      (`max(v,1e-6)`); conversion vs S₀; final conversion from the fitted plateau; formatting (`g()`
      4-sig k, `.4f` R², `.1f%` conversion); reference = divide before analysis. Lint (0 errors),
      `tsc -p tsconfig.app.json` (no IR errors), `vitest` (12 passing), and `vite build` all clean.
