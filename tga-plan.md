# TGA workspace (`/tga`) — implementation plan

## Context

The site already has six analysis workspaces (Spectrum analysis, Prediction, NMR Kinetics, MALDI,
GC/MS, IR, Tensile). The user drops thermogravimetric analysis data from two different instruments —
a TA Q50 and a TRIOS-driven Discovery TGA 5500 — and currently has nowhere to look at it. They want a
seventh workspace that reads those files, computes the standard TGA numbers (T₅%/T₁₀%/T₅₀%,
extrapolated onset, DTG peak temperatures, residue, per-step mass loss), overlays multiple samples,
and — **the priority of this work** — has a publication figure maker as complete as MALDI's,
including a fullscreen mode and MALDI's figure defaults.

Sample files live in `TGA Test/` at the repo root. They were inspected during planning and every
format below was decoded successfully; the byte-level notes in §2 are verified findings, not guesses.

**User decisions already made** (do not relitigate):

- **No kinetics.** Kissinger / Flynn-Wall-Ozawa multi-heating-rate analysis is out of scope.
- **Secondary y-axis goes into the shared figure engine** (not a fake rescale, not a stacked
  two-panel figure). The stacked TGA-above/DTG-below figure mode was explicitly *not* chosen — do not
  build it.
- **Weight % normalizes to the first data point by default** (matches TA Universal Analysis). Other
  bases stay switchable.
- **Excel export includes native, editable charts**, which means generalizing
  `lib/maldi/excelChartInject.ts`.
- **All four sample formats plus generic CSV must work.**
- **Auto-fit first, zoom after**: on load, every axis range is auto (full data visible) and every
  analysis window (onset tangents, step boundaries) is auto-fitted; the user then zooms/adjusts.

---

## 1. What already exists and must be reused

Read these before writing anything. Almost every piece of this feature has a working precedent.

| Concern | Reuse | Path |
| --- | --- | --- |
| Publication figure engine (types, defaults, axis math, decimation) | `FigureData`, `FigureOptions`, `defaultFigureOptions`, `mergeSavedFigureOptions`, `reconcileFigureOptions`, `resolveAxis`, `niceTicks`, `decimateMinMax` | `frontend/src/lib/ir/figure.ts` |
| Figure UI: live preview, drag-zoom, **fullscreen portal**, export bar, PNG scale/DPI picker | `FigureMaker` (already has `allowFullscreen`, Esc handling, `fitFigureBox` sizing) | `frontend/src/components/ir/figure/FigureMaker.tsx` |
| Figure renderer (SVG, sticks, peak labels, legend drag) | `FigureSvg` | `frontend/src/components/ir/figure/FigureSvg.tsx` |
| Figure styling panel (Title/size, Fonts, Axes & frame, X, Y, Series, Peaks & labels, Legend) | `FigureControls` | `frontend/src/components/ir/figure/FigureControls.tsx` |
| Host-level figure state that survives tab switches | `useFigureOptions(data, seed)` | `frontend/src/components/ir/figure/useFigureOptions.ts` |
| Figure adapter pattern (host model → `FigureData`) | `buildGcmsFigureData` — closest model to follow | `frontend/src/lib/gcms/figure.ts` |
| Figure panel pattern (include-strip + pickers + `FigureMaker`) | `GcmsFigurePanel`, `MaldiFigurePanel` | `frontend/src/components/{gcms,maldi}/figure/` |
| SVG/PNG download + canvas-limit guard | `downloadFigureSvg`, `downloadFigurePng`, `pngExportSize` | `frontend/src/lib/ir/figure-export.ts` |
| Multi-file workspace store (reducer + context + derived memo) | `TensileProvider` / `store-core.ts` | `frontend/src/lib/tensile/store.tsx`, `store-core.ts` |
| IndexedDB workspace persistence (best-effort, fails soft) | `saveState` / `loadState` / `clearState` | `frontend/src/lib/tensile/persistence.ts` |
| Interactive dense-curve plot | uPlot patterns incl. multi-scale axes, hover readout, box zoom | `frontend/src/components/gcms/GcmsPlot.tsx` |
| Savitzky–Golay smoothing with endpoint padding | `smoothSG` | `frontend/src/lib/gcms/numerics.ts:77` |
| Min/max-envelope downsampling | `downsample` | `frontend/src/lib/gcms/view.ts` |
| Legacy `.xls` (BIFF8) and `.xlsx` reading | SheetJS `xlsx@0.18.5` (already a dependency) | see `frontend/src/lib/tensile/parse.ts` |
| Native Excel charts inside an ExcelJS workbook | `injectCharts`, `ChartSpec` | `frontend/src/lib/maldi/excelChartInject.ts` |
| PDF report | `exportReportPdf` (jsPDF) | `frontend/src/lib/maldi/export.ts:511` |
| Page shell, nav, keep-alive routing | `AppShell`, `KEEP_ALIVE` | `frontend/src/components/AppShell.tsx`, `frontend/src/App.tsx:25` |
| Collapsible left-rail sections | `CollapsibleSection` | `frontend/src/components/ui/CollapsibleSection.tsx` |
| Empty-state hero + capability tiles + dropzone | `EmptyWorkspace` | `frontend/src/pages/Tensile.tsx` |

Existing dependencies that cover every need here: `ml-savitzky-golay`, `xlsx`, `exceljs`, `jspdf`,
`jszip`, `idb`, `uplot`, `recharts`, `react-dropzone`. **Add no new dependencies.**

---

## 2. File formats — verified decode notes

All four were decoded during planning. Write parsers against these facts.

### 2.1 TA Q50 text export — `DAC1.txt`

- **UTF-16LE with BOM `FF FE`**, CRLF lines, tab-separated. Decode with
  `new TextDecoder("utf-16le").decode(buffer)`; strip the BOM.
- Header is `Key<TAB>Value` lines until a line equal to `StartOfData`. Repeated keys exist
  (`Xcomment` appears 5×, `OrgMethod` 3×) — collect repeats into arrays.
- Keys seen: `Version, Language, Mode, Run, RunSerial, Instrument, Module, InstSerial, Operator,
  File, FurnaceType, Sample, Size, ProcName, Method, Comment, Xcomment×5, Kcell, TempCal,
  InstCalDate, Controls, Nsig, Sig1..Sig4, AirCoolTime, AutoAnalysis, Date, Time, OrgMethod×3,
  OrgFile`.
- `Size` → `2.15200<TAB>mg`. `Sig1..SigN` name the columns:
  `Time (min)`, `Temperature (°C)`, `Weight (mg)`, `Deriv. Weight Change (%/°C)`.
  **Parse the column set from `Nsig`/`SigN`, do not hardcode 4 columns.**
- `OrgMethod` lines give the thermal program (`1: Ramp 10.00 °C/min to 600.00 °C`).
- Data: tab-separated floats, one row per line. Note values like `.00749511` (no leading zero) —
  `Number()` handles these; `parseFloat` on an empty cell must become `NaN`, not `0`.
- Degree signs arrive as `°`; the file also contains the Latin-1 `°` in places. Normalize.

### 2.2 TA Q50 raw binary — `DAC1.001`

- Same UTF-16LE header text at the start of the file (no BOM handling needed if you scan for the
  key names), then a float32 block.
- **Data block starts at byte 1865 in this file** — but do not hardcode. Scan forward for the first
  offset where 4 consecutive `(f32, f32, f32)` triplets are all plausible
  (0 ≤ t < 1e4, 15 < T < 1200, 0 < w < 1e4) and `t` is ascending.
- Layout: little-endian `float32` **triplets `(time_min, temperature_C, weight_mg)`**.
- **Terminator**: a triplet whose first value is `-100.0`. Stop there. (In `DAC1.001`: 69 points,
  then `-100.0, 20.0, 0.0`, then trailing garbage.)
- The derivative column is *not* stored — compute DTG (§4.2).
- Verified: the decoded triplets match `DAC1.txt` row for row.

### 2.3 TRIOS project — `Sample 1.tri`, `sample 1-analzyed.tri`

Discovery TGA 5500 project file. Proprietary but tractable.

- **Metadata header** (first ~750 bytes): a stream of length-prefixed ASCII strings — a single
  length byte followed by that many characters, alternating key/value. Keys observed:
  `instrumenttype` (`TGA5500`), `instrumentserialnumber`, `instrumentname`, `companyname`,
  `rundate`, `culture`, `operator`, `project`, `samplename`, `comments`, `instrumentmode`,
  `testtype`, `pantype` (`Platinum HT`), `samplepannumber{,b,c}`, `procedurename`,
  `proceduresegments`, **`proceduresignals`**, `procedureGUID`, `referencepannumber`,
  **`samplesize`** (`1.75864629698867E-05`, i.e. **kg** → 17.586 mg).
- `proceduresignals` gives the signal order:
  `Time; Temperature; Weight; Temperature Difference; Sample Purge; Balance Purge; Set Point`.
- **A full PNG preview image is embedded at byte 761** (`\x89PNG` … `IEND`, ends at 17914). Skip it.
  Optionally surface it as a thumbnail; not required.
- After the PNG: UTF-16/ASCII property blocks, then the **signal arrays**. In `Sample 1.tri` the
  first array starts at **byte 24064**: 601 × `float32` = time 0.0 → 60.0 min in 0.1 min steps.
- Between arrays sits a ~56-byte descriptor. It contains the point count as a little-endian
  `uint32` — `59 02 00 00` = 601 — appearing twice. The next array (temperature, first value
  23.658 °C) begins immediately after.
- **Parser strategy**: locate the first ascending float32 run as above to find array #1 and its
  length *N*; then walk forward, at each step scanning the next ≤128 bytes for a `uint32` equal to
  *N* and taking the following `N × 4` bytes as the next array. Assign arrays to the
  `proceduresignals` names in order. Stop when the names run out or a scan fails.
- **This is the riskiest parser.** Guard it: validate that Temperature is within 0–1500 and Weight
  within 0–1e4, and on any failure fail soft with a clear toast — *"Couldn't read the TRIOS binary.
  Export it from TRIOS as Excel and drop that instead."* Never throw into the UI.
- `sample 1-analzyed.tri` (6.7 MB) is the same file plus TRIOS's own analysis results. **Read the
  raw signals only; ignore the stored analyses.**

### 2.4 TRIOS Excel export — `sample 1.xls`

**This is the richest fixture and the one to build the generic table importer around.** Legacy
BIFF8 OLE2 (`D0 CF 11 E0`), 11 MB — SheetJS reads it (`XLSX.read(bytes, { type: "array" })`).

- Sheets: `Details`, then **one sheet per procedure segment**:
  `Isothermal 1.0 min`, `Ramp 10.00 °Cmin to 600.00 °C`.
- `Details`: 86 rows of `Key | Value`, including `Filename`, `Instrument name`, `Operator`,
  `rundate` (Excel serial), `Sample name`, `proceduresegments`, `Trios version`,
  `Original File Name`.
- Segment sheets hold **several samples side by side**. In the Ramp sheet (34 681 rows × 30 cols):
  - Row 0 = sample titles, row 1 = column headers, row 2 = units, rows 3+ = data.
  - Blocks start at columns **1, 9, 17, 25** — a 5-column block
    (`Time | Temperature | Weight | Weight | Deriv. Weight`, units `min | °C | mg | % | % / °C`)
    followed by 3 blank columns.
  - The sample name sits in row 0 **one column left of** the block's `Time` column. In this file:
    `tit 2-1 DCPD-PETMP`, `2-1 DCPD-PETMP 150C`, `2.791-1 DCPD-DPTH`, `1.25-1.5-1 DCPD-NORB-PETMP`.
  - **Do not hardcode 5/8/1.** Detect blocks by scanning the header row for cells equal to `Time`
    (case-insensitive, trimmed); the block runs from there to the next blank header cell.
  - **Blocks have different lengths** — trim each block's trailing all-null rows independently.
  - **The export contains duplicated consecutive rows** (the first three rows are identical). Dedupe
    by dropping rows whose time is not strictly greater than the previous kept row's.
  - The `Isothermal` sheet has a single block at column 0, no `Deriv. Weight` column, and a
    constant temperature.
- **One file therefore yields N runs**, exactly like Tensile's workbook → specimens. The store's
  unit must be a *run*, not a *file*.

### 2.5 Generic CSV / XLSX

Any delimited text or spreadsheet. Sniff the delimiter (`,` `;` `\t`), find the header row, then
open a **column-mapping dialog**: which column is Time, Temperature, Weight, and (optionally) Weight
% / Deriv. Weight, plus the weight unit (mg/g/%) and temperature unit (°C/K). Pre-select by header
name matching (`temp`, `weight`, `mass`, `time`, `deriv`, `dtg`). Remember the mapping per header
signature in `localStorage` via `usePersistedState` so a repeat import of the same layout is
one click.

### 2.6 `DAC1.001.pdf`

A Universal Analysis printout. **Not parsed** — ignore `.pdf` in the dropzone (silently skip, don't
error).

---

## 3. Module layout

New files (mirroring the GC/MS + Tensile conventions):

```
frontend/src/pages/Tga.tsx

frontend/src/lib/tga/
  types.ts            TgaRun, TgaSignals, TgaMetadata, AnalysisParams, Step, Marker, TgaState
  numerics.ts         derivative helpers, monotone dedupe, index/value lookups
  compute.ts          normalization, DTG, Td, onset/endset, Tmax, residue, step detection
  blank.ts            buoyancy / blank-run subtraction
  compare.ts          cross-run summary rows + material mean±SD
  figure.ts           buildTgaFigureData()  ← the adapter
  export.ts           CSV, Excel (+charts), PDF, project JSON
  view.ts             re-exports gcms/view downsample+sliceRange for TGA arrays (thin)
  store-core.ts       reducer + INITIAL_STATE + pure state helpers
  store.tsx           TgaProvider + useTgaStore (derived memo layer)
  persistence.ts      IndexedDB snapshot (copy tensile/persistence.ts, DB name "tga-workspace")
  parse/
    index.ts          sniffFormat() + parseTgaFiles() dispatcher
    taText.ts         §2.1
    taBinary.ts       §2.2
    triosTri.ts       §2.3
    triosXls.ts       §2.4
    genericTable.ts   §2.5 (shared by CSV and non-TRIOS xlsx)
  __tests__/          one test file per module + realfile tests

frontend/src/components/tga/
  FileDropzone.tsx        ImportPanel.tsx        ColumnMapDialog.tsx
  RunCard.tsx             MetadataPanel.tsx      ParamControls.tsx
  TgaPlot.tsx             StepTable.tsx          MarkersPanel.tsx
  SummaryTable.tsx        MaterialsPanel.tsx     ComparePanel.tsx
  BlankPanel.tsx          ExportMenu.tsx
  figure/TgaFigurePanel.tsx
```

Modified files:

- `frontend/src/App.tsx` — import `Tga`, add `{ path: "/tga", element: <Tga /> }` to `KEEP_ALIVE`.
- `frontend/src/components/AppShell.tsx` — a `<NavLink to="/tga">TGA</NavLink>` after Tensile.
- `frontend/src/pages/Home.tsx` — a tile with `href="/tga"`, matching the existing tiles.
- `frontend/src/lib/ir/figure.ts` + `components/ir/figure/{FigureSvg,FigureControls}.tsx` — the y2
  axis (WP5).
- `frontend/src/lib/gcms/numerics.ts` — add a `derivative` parameter to `smoothSG`.
- `frontend/src/lib/maldi/excelChartInject.ts` — generalize `ChartSpec` (WP8).
- `.gitignore` — add `TGA Test/` (the `.tri`/`.xls` samples total ~20 MB; `GCMS Example/` was
  removed from the repo for the same reason).

---

## 4. Work packages

WP5 (the figure engine) is independent of WP1–WP4 and can be done first or in parallel. WP6 depends
on both WP3 and WP5.

### WP0 — Route, shell, empty state

Copy `pages/Tensile.tsx`'s structure exactly: `TgaProvider` → `TgaWorkspace` → `AppShell`, with
`EmptyWorkspace` (hero blurb + `FileDropzone` + four `CapabilityTile`s) and `PopulatedWorkspace`
(left rail + main column). Header accessory: run/sample counts, `ExportMenu`, Clear all.

Main column is a `Tabs` with **Analysis** and **Figure** (MALDI/GC-MS idiom). The Figure tab's state
is owned by `Tga.tsx`, never by the panel — `TabsContent` has no `forceMount`, so panel-local state
would be destroyed on every tab switch. This is the mistake `MaldiFigurePanel`'s doc comment calls
out; do not repeat it.

**Done when**: `/tga` renders the empty workspace, the nav tab highlights, and switching away and
back preserves state.

### WP1 — Types + parsers

`types.ts` core shape:

```ts
interface TgaRun {
  id: string;                 // crypto.randomUUID()
  fileId: string;             // grouping key — one file can yield many runs
  fileName: string;
  label: string;              // sample name from metadata, else file stem
  color: string;              // from PALETTE, via a monotonic counter (see nextDocColor)
  meta: TgaMetadata;          // instrument, operator, sampleSizeMg, pan, gases, method steps, date…
  segments: TgaSegment[];     // TRIOS segments; TA files produce exactly one
  timeMin: Float64Array;      // concatenated across segments
  tempC: Float64Array;
  weightMg: Float64Array;
  weightPctFile?: Float64Array;   // vendor-supplied % when present
  dtgFile?: Float64Array;         // vendor-supplied deriv when present
  scale: number;              // per-run display multiplier (default 1)
  offset: number;             // per-run vertical offset (default 0)
  visible: boolean;
  materialId: string | null;
}
```

Each parser returns `ParsedTgaFile { fileName, runs: ParsedRun[], warnings: string[] }`. Keep every
parser **pure over an `ArrayBuffer`/cell-grid** so it is unit-testable without the DOM — the same
split `lib/tensile/parse.ts` uses (`parseSheets` pure, `parseWorkbook` the thin browser entry).

`sniffFormat(file, headBytes)`:
1. `D0 CF 11 E0` → `.xls`; `PK\x03\x04` → `.xlsx`. Read with SheetJS, then check for a `Details`
   sheet or a `Time`/`Temperature`/`Weight` header trio → `triosXls`, else `genericTable`.
2. `FF FE` + `CLOSED`/`Version` in UTF-16 → `taText`.
3. UTF-16 `instrumenttype` within the first 512 bytes, or extension `.tri` → `triosTri`.
4. Extension matching `/\.\d{3}$/` (`.001`, `.002`, …) → `taBinary`.
5. `.csv`/`.txt`/`.tsv` otherwise → `genericTable`.
6. `.pdf` → skip silently.

**Tests** (`lib/tga/__tests__/`):
- Pure unit tests over small inline fixtures for each parser's header and data logic.
- `parse.realfile.test.ts` following `lib/gcms/__tests__/chrom.realfile.test.ts`: resolve
  `TGA Test/` from the repo root, `const present = existsSync(...)`, `describe.skipIf(!present)`.
  Assert: `DAC1.txt` → 68 points, first row `(0.3568687, 14.20423, 2.154049)`, `Size` 2.152 mg;
  `DAC1.001` → 69 points, and its rows equal `DAC1.txt`'s within 1e-4 where they overlap;
  `Sample 1.tri` → 7 signals × 601 points, time 0→60 min, `samplesize` 17.586 mg;
  `sample 1.xls` → 4 runs from the Ramp sheet with those exact four names, ascending dedup'd time.

### WP2 — Store, persistence, import UI

- `store-core.ts`: `useReducer` state `{ runs, materials, params, selection, blankRunId }` plus
  actions `addParsedFiles`, `removeRun`, `removeFile`, `clearAll`, `setParams`, `setRunColor`,
  `setRunScale`, `setRunOffset`, `toggleRunVisible`, `renameRun`, material CRUD, `setBlankRun`.
  Copy the reducer shape from `lib/tensile/store-core.ts`.
- `store.tsx`: provider + memoized derived layer — per-run `TgaAnalysis` (§WP3) keyed on
  `(run.weightMg, run.tempC, params)` so a param change recomputes every run exactly once.
- `persistence.ts`: copy `lib/tensile/persistence.ts` verbatim, changing `DB_NAME` to
  `"tga-workspace"`. Same `hydrated` / `latestState` guards.
- `ImportPanel` + `FileDropzone` via `react-dropzone`, accepting
  `.txt,.csv,.tsv,.001,.002,.003,.tri,.xls,.xlsx`. Multi-file. When `genericTable` can't confidently
  map columns, open `ColumnMapDialog` per distinct header signature.
- `RunCard`: colour swatch (click to recolour), name (editable), sample mass, method summary,
  visibility toggle, ×/offset numeric fields, remove.

### WP3 — Compute engine (`compute.ts`)

Pure functions over `Float64Array`s. Everything below is unit-tested against a synthetic
two-step curve with a known analytical answer plus the real `DAC1` fixture.

**4.1 Normalization.** `normalize(weightMg, mode, params)` → `weightPct`.
Modes: `"first"` (**default**), `"sampleSize"` (metadata `Size`), `"max"`, `"atTemperature"` (re-zero
at a user T, e.g. 120 °C to discount moisture). Return the divisor too, so the UI can show it.

**4.2 DTG.** Weight is sampled on a non-uniform temperature grid, so a plain SG derivative in *T* is
wrong. Compute both derivatives with respect to **index** and divide:

```
dW/dT = (dW/di) / (dT/di)
```

Both numerator and denominator from Savitzky–Golay with `derivative: 1`. **Extend
`smoothSG(y, window, polynomial = 2, derivative = 0)` in `lib/gcms/numerics.ts`** — pass `derivative`
straight through to `savitzkyGolay`; the existing padding/clamping and the `derivative: 0` default
keep every current caller unchanged. Guard `|dT/di| < eps` (isothermal segments) → emit `NaN`, which
the renderer already treats as a gap.

Sign convention: report DTG as **positive for mass loss** in `%/°C` (what TA prints). Window is a
user parameter (`dtgWindow`, default 21 points, forced odd, min 5). Also offer `dW/dt` (`%/min`) as a
display option since the file's own column is `%/°C`.

**4.3 Td at thresholds.** `tdAt(tempC, weightPct, threshold)` — first temperature where weight% drops
below `100 − threshold`, **linearly interpolated** between bracketing points. Default thresholds
`[5, 10, 50]`, user-editable list.

**4.4 Extrapolated onset / endset.** Per step. Auto-fit first, then adjustable:
- *Baseline tangent*: least-squares line over the window from the step's start to where the mass loss
  first exceeds 0.5 % of the step's total loss. Reuse `polyfitDeg1` (`lib/ir/numerics.ts:63`).
- *Inflection tangent*: least-squares line over a window centred on the step's DTG extremum, spanning
  ±(25 % of the step's half-width), min 5 points.
- *Onset* = x-intersection of the two lines. *Endset* = intersection of the inflection tangent with
  the post-step plateau line (fitted the same way from the step's end).
- Each window is stored in state as `[tLo, tHi]` in °C so the user can drag it; `autoFit: true` until
  they touch it, after which it stays theirs (same "user touch wins" idiom as
  `useFigureOptions`'s `userSetDecimals`).
- Degenerate cases (near-parallel lines, |Δslope| below eps) → return `null`, and the UI shows "—"
  rather than a wild extrapolation.

**4.5 Step detection.** Find DTG extrema whose prominence exceeds `stepMinLossPct` (default 1 % of
the initial mass). Step bounds = the DTG minima either side (or the run's ends). Per step report
`tOnset, tEndset, tMax, lossPct, lossMg, tRange`. Steps are **editable**: drag bounds, add, delete,
rename. Store user edits as an override list keyed by step index so a param change doesn't wipe them;
mark a run "steps edited" and stop re-deriving until the user hits Re-detect.

**4.6 Residue.** `residueAt(T)` — weight% and mg at a user temperature, default the run's final
temperature. Interpolated.

**4.7 Blank subtraction (`blank.ts`).** Designate one run as the blank. Interpolate the blank's
weight onto the sample's temperature grid (`interp` from `lib/ir/numerics.ts:31`) and subtract, then
re-normalize. Warn when the temperature ranges overlap by less than 90 %. Non-destructive: keep the
raw arrays, expose a `corrected` view.

**Result type**: one `TgaAnalysis` per run —
`{ weightPct, dtg, td: Record<number, number|null>, steps: Step[], residue, normDivisor, warnings }`.

### WP4 — On-screen plot and analysis UI

`TgaPlot.tsx` — uPlot, modelled on `GcmsPlot.tsx`:
- x-axis toggle **Temperature (°C) ⇄ Time (min)**; y toggle **Weight % ⇄ Weight (mg)**.
- **DTG on a second uPlot scale drawn as a right-hand axis** (uPlot supports this natively via a
  second `scales` key and an `axes[].side: 1` entry — no engine work needed here; the shared *figure*
  engine is what needs WP5).
- Overlay every visible run in its own colour; per-run `scale`/`offset` applied exactly as
  `GcmsPlot`'s `scaleColumn`/`applyOffset` do, so the figure can mirror the screen (WYSIWYG).
- Box-zoom drag, double-click reset, hover crosshair with a readout of `T`, `wt%`, `dW/dT` for every
  visible run.
- Auto-range on load (the user's "autofit to show everything first").
- Downsample to ~4000 points/run via `downsample` from `lib/gcms/view.ts`.
- Marker overlays: onset tangent lines, Td drop-lines, Tmax verticals, residue horizontal — each
  independently toggleable from `MarkersPanel`.

Left rail (`CollapsibleSection`s): **Files/Runs** · **Analysis parameters** (normalization mode +
re-zero T, DTG window, Td thresholds, step threshold, residue T) · **Blank subtraction** ·
**Materials**.

Main column: **Summary strip** (per active run: T₅%, T₁₀%, T₅₀%, Tonset, Tmax, residue) · **Plot** ·
**Steps table** · **Metadata panel** (instrument, operator, pan, gases, method program, sample mass,
run date — from `TgaMetadata`).

### WP5 — Secondary y-axis in the shared figure engine ⚠️ core

Off by default; **every existing host must render byte-identically**. Add tests proving it.

**`lib/ir/figure.ts`:**
1. `FigureData` gains `y2Label?: string`. Its presence is what tells `defaultFigureOptions` to build a
   secondary axis — data-driven, exactly like `xLabel`/`yLabel`.
2. `SeriesStyle` gains `axis?: "y" | "y2"` (absent ⇒ `"y"`).
3. `FigureSeriesData.styleHints` adds `"axis"` to its `Pick<>` list; `defaultSeriesStyle` reads
   `hints.axis ?? "y"`.
4. `FigureOptions` gains `y2: AxisOptions | null`. `defaultFigureOptions` sets it to
   `data.y2Label ? defaultAxisOptions(data.y2Label, false) : null` — grid **off** for y2, since two
   gridded axes double-draw.
5. `mergeSavedFigureOptions`: `y2: saved.y2 === undefined ? base.y2 : saved.y2 && { ...(base.y2 ?? defaultAxisOptions("", false)), ...saved.y2 }`.
6. `FigureOptionSeed` gains `y2?: Partial<AxisOptions>` for host preferences.

**`components/ir/figure/FigureSvg.tsx`** (inside the `fig` `useMemo`, lines ~132–219):
1. Partition `visible` into `primary` / `secondary` by `st.axis === "y2"`.
2. `yValues` from `primary` only; `y2Values` from `secondary` (including `baseline`).
3. `const y2Axis = options.y2 && secondary.length > 0 ? resolveAxis(options.y2, y2Values) : null` —
   **the right axis is drawn only when some visible series actually uses it.** No extra visibility
   flag; the user hides it by hiding those series.
4. `marginRight` becomes `16 + (y2Axis ? y2TickW + y2LabelW : 0)`, computed with the same
   `formatTick`-length arithmetic the left margin uses.
5. `sy2(v) = marginTop + ((y2Axis.hi - v) / y2Span) * plotH`; each entry in `paths` picks `sy` or
   `sy2` from its `st.axis`. Same for the stick baseline.
6. Render a right-hand axis block mirroring the left one: tick marks outside the frame at
   `marginLeft + plotW`, tick labels to their right, and the axis label rotated **+90°** at the far
   right so it reads bottom-to-top on the correct side. Reuse `options.axisColor`/`axisBold`/
   `tickFontSize` — the two axes share text styling; only ranges/labels differ.
7. Peak labels: resolve the owning series' axis via `datum.seriesId` →
   `options.series.find(s => s.id === seriesId)?.axis`, and anchor through `sy2` when `"y2"`.
   No new field on `PeakLabelDatum`.
8. **Drag-zoom and wheel-scale act on the primary y only.** y2 stays on its own (auto or manual)
   range. Document this in a comment and expose explicit y2 min/max in the controls — trying to
   couple two independent scales through one gesture is worse than leaving them independent.

**`components/ir/figure/FigureControls.tsx`:**
1. A `<Section title="Y2 axis (right)" defaultOpen={false}>` rendered only when
   `options.y2 != null`, reusing the same axis-field component the X/Y sections use.
2. In the **Series** section, next to the existing line/sticks `Select`, add a `Left`/`Right`
   `Select` bound to `st.axis`, rendered only when `options.y2 != null`.

**Tests:**
- `lib/ir/__tests__/figure.test.ts`: `defaultFigureOptions` leaves `y2` null with no `y2Label` and
  builds it with one; `mergeSavedFigureOptions` round-trips it; `defaultSeriesStyle` honours
  `hints.axis`.
- `components/ir/figure/FigureSvg.test.tsx`: with a two-series `y2Label` figure, the SVG contains
  right-side tick text at the y2 range and the y2 series' path y-coordinates map through the second
  scale (not the first). **Add a regression case asserting a figure with no `y2Label` produces
  identical markup to before.**

### WP6 — TGA figure adapter + panel ⭐ the priority

**`lib/tga/figure.ts` — `buildTgaFigureData(args)`.** Follow `buildGcmsFigureData`'s structure and
comment density. Inputs: visible runs + their `TgaAnalysis`, the x/y mode toggles, which marker
families to draw, and the figure-only exclusion set.

Emits:
- One **line series per run** on the TGA quantity: `id: "tga:{runId}"`, `label: run.label`,
  `x` = temperature or time per the mode, `y` = weight % or mg, `group: run.label`,
  `styleHints: { kind: "line", lineWidth: 1.5, color: run.color, axis: "y" }`.
  Apply the run's `scale`/`offset` exactly as the on-screen plot does (`v * scale + offset`), so the
  figure matches the screen.
- One **DTG line series per run** when DTG is enabled: `id: "dtg:{runId}"`,
  `styleHints: { ..., axis: "y2", lineStyle: "dashed", color: run.color }`, same `group`.
- **Marker series**, each `legendHidden: true` and `group: "Analysis markers"`, so they appear in the
  Series controls but never clutter the legend unless the user opts one in:
  - onset/endset tangent lines — 2-point line series;
  - residue level — a horizontal 2-point line series;
  - Td drop-lines and Tmax verticals — 2-point vertical line series.
- **`peakLabels`** for every callout (onset `234.5 °C`, `T₅% 265 °C`, `Tmax 412 °C`,
  `residue 4.5 %`), each with `customText: true` (so the Decimals control never mangles them),
  `seriesId` pointing at the owning run's series (so "colour labels by series" works), and the run's
  colour. These are **draggable and individually hideable for free** via the engine's existing
  `PeakLabelOverride` mechanism — that is the whole reason to express markers this way rather than as
  `FigureAnnotation`s, which have no controls UI.
- `xLabel` / `yLabel` / **`y2Label`** follow the mode toggles (`"Temperature (°C)"`,
  `"Weight (%)"`, `"Deriv. weight (%/°C)"`).
- `sourceName` = the active run's stem, else `"tga"`.
- **Always supply `peakLabels`** (possibly empty) so the maker's "Peaks & labels" section always
  appears — the convention both existing adapters follow.
- Decimate each run to `DEFAULT_MAX_TRACE_POINTS = 2000` with `downsample` before it reaches the SVG.

**`components/tga/figure/TgaFigurePanel.tsx`.** Copy `GcmsFigurePanel`'s shape: **completely
stateless**, every prop owned by `Tga.tsx`.

Include strip (top bar):
- x-axis: Temperature / Time · y-axis: Weight % / Weight mg
- toggles: **Show TGA** · **Show DTG (right axis)** · **Label markers** · **Stack runs**
  (vertical offset per run, as MALDI stacks spectra)
- a per-run picker with colour swatches and a `×` scale field, mirroring `MaldiFigureFileInfo`
- a Markers group: Onset tangents · Endset · Td callouts · Tmax · Residue line · Step shading
- `N hidden · Restore all` when marker labels have been individually hidden

Then a single `<FigureMaker data={…} options={…} onChange={…} onDeletePeak={…} />`.
`FigureMaker` already provides: fullscreen portal with controls pinned right, drag-zoom, legend drag,
label drag, SVG/PNG export, and the 1×–10× / 150–600 dpi picker. **Do not reimplement any of it, and
leave `allowFullscreen` at its default `true`.**

**Figure defaults — bring MALDI's over verbatim** (`Maldi.tsx:234`, `Gcms.tsx:152`):

```ts
const TGA_FIGURE_SEED: FigureOptionSeed = {
  fontFamily: "Times New Roman",
  width: 800,
  height: 600,
  pngScale: 10,
  showGrid: false,
  background: "transparent",
  axisBold: true,
  peakLabels: { rotation: 0, maxLabels: 40, minGap: 6, decimals: 1 },
  legend: { show: true },
};
```

Differences from MALDI, and why: `rotation: 0` — TGA callouts are sparse, so diagonal labels (which
exist to pack dense m/z sticks) would only hurt legibility. `decimals: 1` matches how onset and Td
are quoted. Everything else is MALDI's.

Wire it with `useFigureOptions(figureData, TGA_FIGURE_SEED)` at the `Tga.tsx` level.

**Done when**: two runs loaded, DTG on, markers on → the figure shows weight % left, DTG right, both
axes labelled and ticked; fullscreen fills the viewport with controls on the right; every callout
drags; PNG at 600 dpi and SVG both export matching the preview.

### WP7 — Comparison

- `SummaryTable`: one row per run — label, sample mass, T₅%, T₁₀%, T₅₀%, Tonset, Tmax(s), residue %.
  Sortable, filterable, CSV-copyable. Model on `components/tensile/SpecimenTable.tsx`.
- `MaterialsPanel`: group runs into named materials, mean ± SD per metric. Copy
  `components/tensile/MaterialsPanel.tsx` and `lib/tensile/compute.ts`'s `summarize`.
- `ComparePanel`: a recharts bar chart of one selected metric across runs or materials, with error
  bars for materials. Copy `components/tensile/ComparePanel.tsx`.

### WP8 — Exports

- **CSV**: processed curves (T, time, wt %, wt mg, DTG) per run; and the summary table.
  Use `triggerDownload` from `lib/maldi/export.ts`.
- **Excel** (`exportTgaExcel`): ExcelJS workbook — `Summary` sheet, `Steps` sheet, one `Curve` sheet
  per run, then **two native charts**: weight % vs temperature (all runs) and DTG vs temperature.
  This requires generalizing `lib/maldi/excelChartInject.ts`:
  - `ChartSpec` gains an optional `series: { name, xRange, yRange }[]` that, when present, supersedes
    the current single `seriesName`/`xRange`/`yRange` fields (which stay working);
  - `ChartSpec` gains an optional `style?: { line: "solid" | "dotted"; markers: boolean;
    trendline: boolean; smooth: boolean }`, **defaulting to exactly today's MALDI values** (dotted,
    markers on, trendline on) so MALDI's output and its tests are unchanged;
  - `xTitle`/`yTitle` become per-spec instead of hardcoded `"Repeat Units (n)"` / `"m/z"`.
  - `lib/maldi/__tests__/excelChartInject.test.ts` must still pass untouched; add TGA cases beside it.
  Two separate charts, deliberately — an Excel secondary-axis chart is far more XML for no gain here.
- **PDF** (`exportTgaReportPdf`): jsPDF, following `exportReportPdf` — metadata block, summary table,
  steps table, and the figure PNG rendered via `downloadFigurePng`'s offscreen path.
- **Project JSON** (`.tgaproj`): serialize runs + params + materials + figure options, mirroring
  `serializeProject`/`deserializeProject` in `lib/maldi/export.ts`. Restore figure options through
  `mergeSavedFigureOptions(defaultFigureOptions(data, TGA_FIGURE_SEED), saved)` — the exact pattern at
  `Maldi.tsx:1153`.

---

## 5. Verification

**Automated** — from `frontend/`:

```bash
npm run test && npm run typecheck && npm run lint
```

New tests to land: per-parser unit tests; `parse.realfile.test.ts` with the §WP1 assertions;
`compute.test.ts` (synthetic two-step curve with analytically known onset/Td/Tmax/residue, plus
`DAC1` regression values); `figure.test.ts` for the adapter (series ids, `axis` hints, marker series
`legendHidden`, label `customText`); and the WP5 engine tests including the **no-`y2Label`
byte-identical regression**.

**Manual, in the preview browser** — the dev server is `/maldi` on port 8080 per the existing setup;
use `preview_start` then navigate to `/tga`:

1. Drop all four sample files at once. Expect **7 runs**: DAC1 (from `.txt`), DAC1 (from `.001`),
   Sample 1 (from `.tri`), and 4 runs from `sample 1.xls`. The `.pdf` is skipped silently.
2. Confirm the `.txt` and `.001` DAC1 curves overlay exactly.
3. Check the summary strip against the values in `DAC1.001.pdf` (the instrument's own printout) —
   T₅%, onset and residue should agree to within a degree or two.
4. Toggle x to Time, y to mg, and back. Toggle DTG on and confirm the right-hand axis appears on the
   uPlot with sane `%/°C` values (~0.09 max for DAC1).
5. Open the **Figure** tab. Verify: both axes labelled and ticked, legend on, Times New Roman,
   transparent background, bold axes — MALDI's look.
6. Click **Fullscreen**. The preview must fill the viewport with the styling panel pinned right;
   Esc exits; opening a Select inside the panel must **not** exit fullscreen.
7. Drag an onset callout, hide another, drag the legend, box-zoom, double-click to reset.
8. Export SVG and 600 dpi PNG; confirm the file matches the preview exactly, including the right
   axis.
9. Export Excel; open it and confirm both charts render and are editable.
10. Reload the page — the workspace and the figure styling must both come back.
11. **Regression check**: open `/maldi`, `/gcms`, `/ir` and confirm their figure makers are visually
    unchanged and show no "Y2 axis" section.

---

## 6. Explicitly out of scope

- Multi-heating-rate kinetics (Kissinger / FWO) — cut by the user.
- The stacked TGA-above/DTG-below two-panel figure — the user chose the y2 axis instead.
- Reading TRIOS's *stored* analysis results from `sample 1-analzyed.tri` (raw signals only).
- Parsing `DAC1.001.pdf`.
- Mettler / Netzsch / PerkinElmer / Hitachi binary formats — the generic CSV/XLSX importer covers
  their text exports; native readers need sample files that don't exist yet.

---

## 7. Corrections found during implementation

The format notes in §2 were decoded from a partial read of the files. Building
the parsers against real data turned up three places where §2 is wrong. The
code and its tests are the authority; this section records the corrections so
the plan is not read as gospel later.

### 7.1 `Sample 1.tri` has TWO signal blocks, not one (§2.3)

§2.3 describes the array at byte 24064 as *the* signal set: "601 × float32 =
time 0.0 → 60.0 min". It is only the **`Isothermal 1.0 min` segment**. The
`Ramp 10.00 °C/min to 600.00 °C` segment is a second block of **34 673** points
per signal (the same count the TRIOS Excel export writes for that ramp),
beginning at byte 65689. Reading the first block alone yields a "run" that sits
at 23.7 °C for its whole length and loses no mass — the bug the first
implementation shipped with.

Corrected framing, verified byte-for-byte: each array's length appears as a
little-endian `uint32` at `start − 22` **and** `start − 4`, and arrays within a
block are a fixed `N × 4 + 72` bytes apart. **Blocks are not 4-byte aligned** —
the isothermal block's arrays are (24064, 26540, …) but the ramp block's are at
odd offsets (65689, 204453, …), so every scan must step one byte at a time. The
blocks are concatenated in file order; their time axes are already continuous.

### 7.2 `.tri` stores Time in SECONDS and Weight in KILOGRAMS (§2.3)

§2.3 reads the first array as "time 0.0 → 60.0 min in 0.1 min steps". It is
0 → 60 **seconds**, which is exactly the declared `Isothermal 1.0 min`. The
units are settled by the ramp: read as seconds it works out at 10.0 °C/min,
matching the method line; read as minutes it would be 0.17 °C/min over 58 hours.
The decoded run reaches 597.7 °C and 13.1 % residue, matching both the PNG
preview embedded in the file itself and the same sample in `sample 1.xls`.

### 7.3 `sample 1.xls` yields 4 runs, and the `Isothermal` sheet is furniture

§2.4 is right that the workbook has one sheet per procedure segment, but the
`Isothermal 1.0 min` sheet is the balance equilibration hold: ambient
temperature, 0.02 °C of span, no mass change. Imported as a run it is pure
noise — it stretches the figure's axes and skews the compare chart. Blocks that
are simultaneously at ambient (< 40 °C), isothermal (< 1 °C span) and
featureless (< 1 % mass change) are skipped, with a warning naming the sheet so
nothing disappears silently. A genuine isothermal-stability experiment sits
above ambient (or actually loses mass) and is kept.

### 7.4 Two compute-engine guards the plan did not anticipate

- **DTG needs a relative division guard.** `dW/dT = (dW/di)/(dT/di)` explodes
  wherever `dT/di` approaches zero, and an `EPS`-sized guard is not nearly
  enough: on a run with an isothermal prefix it reported a peak of 148 %/°C
  against a real peak near 1 %/°C. Points below 5 % of the run's median
  `|dT/di|` are masked to NaN, and a run whose total temperature span is under
  1 °C has no `dW/dT` at all.
- **Step detection needs both a rate gate and a mass gate.** The peak-area
  proxy (prominence × half-width in *index* units) scales with sampling density,
  so a 35 000-point run produced steps out of baseline wobble. Candidates now
  need a DTG peak ≥ 5 % of the run's tallest, and surviving steps are filtered
  on their REAL mass loss against `stepMinLossPct` — the quantity that
  parameter actually names.

### 7.5 Marker geometry: verticals must live in their run's own band

§WP6 specifies the marker series but not their extent, and the first
implementation drew every vertical from `y = 0` to `y = 100`. That is wrong in
three modes at once: on the mg axis it lands off the data entirely, stacked it
sits under the bottom run regardless of which run it annotates, and even
overlaid it says nothing about which curve it belongs to. Each vertical now
runs from its run's floor (the stack baseline, or the run's own minimum) up to
the run's curve **at that temperature**, and its callout is anchored on the
curve — so a marker is legible as belonging to one sample. The same anchoring
went into `lib/tga/plot.ts` for the on-screen overlay.

The temperature-only markers (onset, endset, Tmax, Td) are withheld on a time
x-axis, which `plot.ts` already did and `figure.ts` did not.

Stacking gained two more corrections: the DTG traces stack on y2 as well (all
seven derivatives otherwise pile into the same band in the middle of the plot),
and both y-axis labels pick up an ", offset" suffix — the stack shifts each
run's origin but keeps the scale, so the ticks still measure a step correctly
and the label should say so rather than implying an absolute weight.

### 7.6 `minGap` cannot declutter a figure whose labels are all pinned

`PeakLabelOptions.maxLabels` / `minGap` thin labels that crowd in x, which is
the right tool for a spectrum's peak ladder. But a label carrying
`customText` is *pinned* — it bypasses thinning so a user edit can never make it
vanish — and every TGA callout carries custom text. Seven runs × five marker
families is 42 pinned labels inside about 150 px of x, all drawn on top of each
other.

The engine gained `peakLabels.declutter` (default **off**, so IR/MALDI/GC-MS
render exactly as before; on in the TGA seed, and a checkbox in Peaks & labels).
It packs the drawn labels vertically: hand-placed labels never move and act as
fixed obstacles, the rest take the nearest free slot above (then below) their
anchor, and past the point where no arrangement is collision-free it takes the
least-overlapping position rather than leaving the label where it started. On
the seven-run fixture that is 42 labels with zero collisions overlaid, one
stacked.

### 7.7 Exports carry every point

§WP8's Excel workbook wrote a separate `Chart data` sheet decimated to 900
points per run, so the native charts — the part of the workbook anyone actually
looks at — showed a sketch of each curve. The charts now read each run's own
full-resolution data sheet directly (`ChartSeriesSpec` gained an optional
`sheet`), which also removes the duplicate copy of the data. The one exception
is Excel's own 32 000-point-per-series ceiling: a longer run (a TRIOS `.tri` is
~35 000) gets a decimated copy in spare columns on its own sheet, since Excel
would otherwise drop the overflow silently.

The figure adapter's per-run cap went from 2 000 to 20 000 points. The preview
decimates again to the plot width, so this only bounds the exported SVG.

### 7.8 Scroll-to-scale reaches y2

§WP5's note that "drag-zoom and wheel-scale act on the primary y only" holds for
drag-zoom — a box drawn over the plot has no reading on a second, independent
scale — but not for the wheel, where the pointer's position is a perfectly good
way to say which axis you mean. Over the plot the wheel scales both y-axes
together; over the left gutter only the primary; over the right gutter only y2.
`TgaPlot` does the same, holding a per-axis gain that multiplies the auto-fitted
span so a scaled axis keeps auto-fitting as the x-window changes.
