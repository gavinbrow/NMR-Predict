# MALDI Reader — Large Change Request

## Context

The MALDI workspace is a frontend-only React app: pure logic in `frontend/src/lib/maldi/`,
UI in `frontend/src/components/maldi/`, orchestrated by the ~1450-line
[`Maldi.tsx`](frontend/src/pages/Maldi.tsx). This request is a batch of workflow-quality-of-life
upgrades from real use: the analyst wants to **name/annotate series after figuring out what they
are**, keep those annotations in a **reviewable table** and in **exports**, control **colours**,
triage **unexplained peaks**, make the **compare** view usable with already-open spectra, fix a
**highlight bug** that turns coloured ladders pink and makes them vanish, tidy the **Templates**
panel, and get **Ctrl+Z**.

Confirmed decisions (from clarifying questions):
- **Series sidebar panel: keep all existing controls** — only *add* the new table (remove nothing).
- **Labelled-series table lives in a new dedicated "Series" tab** on the right (next to Peak table / Compare / Report).
- **End groups: attach solver results to a series** (an "Assign to series" action on end-group candidates) **and** allow manual entry per series.
- **Ctrl+Z scope: per-spectrum analysis edits**, each open document with its own history; excludes the compare list, document open/close/switch, and the export log.

### Root causes already confirmed in code
- **Pink / vanishing series bug:** `highlightPeaks()` ([Maldi.tsx:328](frontend/src/pages/Maldi.tsx)) does three destructive things — `setRepeatGroups([])`, `setSelectedGroupKey(null)`, and `setHighlightedPeakIds(ids)`. Every series/end-group/loss/Kendrick selection routes through it, so the coloured split ladders are wiped and the plot falls back to a single colour `HIGHLIGHT = "#d946ef"` at [MaldiSpectrumPlot.tsx:350](frontend/src/components/maldi/MaldiSpectrumPlot.tsx) (`groupColor ?? HIGHLIGHT`). The plot already renders arbitrary per-group colours via the `highlightGroups` prop — only Maldi.tsx fails to feed series colours into it.
- **Monoisotopic default:** the "Monoisotopic peaks only" toggle ([PeakPickingPanel.tsx:152](frontend/src/components/maldi/PeakPickingPanel.tsx)) is backed by `pickParams.monoisotopicOnly`, unset in every preset → currently **off**.
- **Templates** is a plain, always-open `SidebarCard` ([Maldi.tsx:1167](frontend/src/pages/Maldi.tsx), def :1407).
- **Compare** only ingests uploaded files, chips just `flex-wrap` (no scroll), remove-only ([CompareView.tsx](frontend/src/components/maldi/CompareView.tsx)).
- **Peak table** already has multi-select + bulk delete/merge + inline labels, but no colour field and no series awareness ([PeakTable.tsx](frontend/src/components/maldi/PeakTable.tsx)).

---

## Data model changes — `frontend/src/lib/maldi/types.ts`

These persist automatically: `buildState()` assigns the whole `series`/`peaks` arrays and
`serializeProject()` spreads the whole state, so new fields round-trip through IndexedDB and JSON
export with no serializer edits.

- **`Series`** (add): `description?: string`, `endGroupLabel?: string` (assigned end-group *name*),
  `color?: string`, `endGroupLocked?: boolean`. (`label` and `endGroupMass` already exist.)
- **`Peak`** (add): `color?: string`.
- **`ProjectState`** (add, to close the snapshot/undo + doc-switch gap): `endGroupMass?`,
  `repeatIsotopeAware?`, `splitSeries?`, `copolymerA?`, `copolymerB?`. Extend `buildState()`
  ([Maldi.tsx:358](frontend/src/pages/Maldi.tsx)) and `loadState()` (:374) to write/read them.

---

## Change set

### 1. Label series + assign end groups + Series tab (Requests: label, end groups, table, colour)
- **New component `frontend/src/components/maldi/SeriesTable.tsx`**, rendered in a **new "Series" tab**
  in the right-hand `Tabs` ([Maldi.tsx:1290](frontend/src/pages/Maldi.tsx)). Columns: colour swatch
  (opens a colour input → `onSetColor`), **Label** (editable), **Description** (editable), adduct,
  repeat, **End group** (mass + assigned name), #peaks, err/R² (read-only), and row-click → highlight
  that series. Empty state mirrors other tabs.
- **Maldi.tsx handlers** (all `setSeries(prev => prev.map(...))`, patterned on `handleToggleSeriesMember`
  [:720](frontend/src/pages/Maldi.tsx)): `handleRenameSeries(id, label)`, `handleSetSeriesDescription(id, desc)`,
  `handleSetSeriesColor(id, color)`, plus the end-group assignment below.
- **Assign end groups:** add `onAssign?(candidate)` + an explicit **"Assign to series"** button per candidate
  in [`EndGroupPanel.tsx`](frontend/src/components/maldi/EndGroupPanel.tsx) (do **not** overload the existing
  highlight-toggle `onClick` at :52). `handleAssignEndGroup(candidate)` finds the `Series` with matching
  `adductId` whose `members` overlap the candidate's, then writes `endGroupMass = candidate.endGroupFit`
  (the fitted neutral mass — `residualMass` is only modulo the repeat), `endGroupLabel = candidate.libraryMatch`,
  and `endGroupLocked = true`. Manual entry is available directly in the Series-tab End-group cell.
- **Guard:** `handleToggleSeriesMember` re-fits and overwrites `endGroupMass` on every member add/remove
  ([:731](frontend/src/pages/Maldi.tsx)) — skip that overwrite when `endGroupLocked` so a manual/assigned
  end group isn't clobbered.
- Sidebar `SeriesPanel` is left intact (remove nothing); optionally surface `s.label` in its card title
  when set (fallback to the adduct label) so the sidebar and tab agree.

### 2. Labels/descriptions/end-group in exports — `frontend/src/lib/maldi/export.ts`
Series objects already flow through `ReportPayload` and `buildReportPayload` intact — export-only edit:
- `exportSeriesCsv` header (:97) + row (:102) — add `label`, `description`, `endGroupLabel` columns.
- `exportReportPdf` series line (:467) — append label / end-group name / description.
- `exportReportExcel` series sheet header (:587) + row (:591) — add the columns.

### 3. Manual series colours (Request: change colours)
- Colour stored on `Series.color`; colour picker in the Series tab (and reuse for the split-ladder swatches).
- Colour source becomes `series.color ?? SERIES_COLORS[index % len]` everywhere colour is derived, so the
  swatch and the plot stems stay in sync (feeds the highlight unification in #8).

### 4. Monoisotopic default (Request: make monoisotopic the default)
- Add `monoisotopicOnly: true` to the `PEAK_PRESETS` entries in
  [`peaks.ts`](frontend/src/lib/maldi/peaks.ts:78) (so switching presets keeps it on) and update the
  "default off" doc comment (:70). Change `PeakPickingPanel` default read to `?? true` (:154). Initial
  `pickParams` state already spreads `balanced`, so it inherits the new default.

### 5. Unexplained peaks: show-only / delete / colour-label, 1-or-many — `PeakTable.tsx` + `MaldiSpectrumPlot.tsx`
- Compute `explainedPeakIds` in Maldi.tsx (union of `series[].members[].peakId`, pattern at
  [:757](frontend/src/pages/Maldi.tsx)) and pass into `PeakTable`.
- **"Unexplained only" filter** toggle in the table toolbar (:138). Unexplained = `accepted !== false &&
  !ignored && !flag && id ∉ explainedIds`. Apply by wrapping `sortedPeaks`; **intersect the `selected` Set
  with visible ids** when the filter changes (bulk delete/merge operate on the full array).
- **Bulk label + colour on 1..N:** existing checkbox multi-select stays; add a select-all header checkbox
  and toolbar controls (colour input + label input) next to Merge/Delete that map over `selected`
  (`onChange(peaks.map(p => selected.has(p.id) ? {...p, color, label} : p))`). Bulk **delete** already exists.
- Render `peak.color` as an inline row tint/swatch (arbitrary colours → `style`, not `FLAG_STYLES`). Store
  labels/colours on the **`color`/`label`** user fields (not `flag`, which `flagBackground` overwrites on every re-pick).
- **Plot:** honour `peak.color` in `drawPeaks` / `peakColor()` ([MaldiSpectrumPlot.tsx:131,350](frontend/src/components/maldi/MaldiSpectrumPlot.tsx))
  and add the new colour/filter state to the redraw effect deps (:567). Optional "show unexplained only"
  filter mode on the plot mirrors the table (inverse of `isolate`, guard at :339).

### 6 & 7. Compare: add open spectra + scrolling + per-item controls — `CompareView.tsx` + `Maldi.tsx`
- **Add currently-loaded spectra:** new props `openDocuments: {id,name}[]` + `onAddFromOpen(docId)`; a
  dropdown beside "Add spectra" (:114). Handler in Maldi.tsx (beside `handleAddComparisons` :788) reads the
  active doc's `processed ?? raw` and others' `state.processedSpectrum ?? state.rawSpectrum` (mirroring
  `docSpectra` :245), pushes a fresh `cmp-…` id. Pass `documents` filtered to exclude the active doc (it is
  already `current`).
- **Scrolling + functions:** promote the comparison chips into a dedicated vertical list with
  `max-h-[…] overflow-y-auto`. Move `color`, `offset`, `visible` onto `ComparisonSpectrum`; add an
  `onUpdate(id, patch)` prop and per-row controls (visibility toggle, colour, vertical offset — offset done
  like [StackedSpectraPlot.tsx:57](frontend/src/components/maldi/StackedSpectraPlot.tsx)). The uPlot builder
  (:64) filters hidden traces, uses per-item stroke, applies offset. Difference mode currently assumes
  `comparisons[0]` — pin it to the first **visible** comparison.

### 8. Highlight series = same colours, don't disappear (the core bug)
Unify all series/ladder highlighting onto the plot's existing **`highlightGroups`** colour channel; reserve
the flat pink `highlightedPeakIds` only for genuinely single/uncoloured clicks (peak click, neutral loss,
Kendrick cluster).
- Give every assigned `Series` a stable colour (`series.color ?? SERIES_COLORS[i]`).
- Rework the `plotHighlightGroups` memo ([:236](frontend/src/pages/Maldi.tsx)) so it builds coloured groups
  from **whichever source is active**: split-preview `repeatGroups` (existing) **or** the highlighted
  series (one `{color, ids}` group per series). Remove the `repeatGroups.length`-only gate (:237).
- `handleSelectSeries` (:709) and `handleHighlightAllSeries` (:750) stop calling `highlightPeaks()` (which
  wipes `repeatGroups` and forces pink) and instead set series-highlight state that feeds
  `plotHighlightGroups`. Keep `isolateSelection` working (plot isolates whenever any highlight is present,
  guard :339). Net effect: highlighting shows each series in its own colour and the split ladders no longer
  vanish.

### 9. Templates minimized by default — `Maldi.tsx`
- Add optional `collapsible` + `defaultCollapsed` props to the local `SidebarCard` ([:1407](frontend/src/pages/Maldi.tsx)),
  wrapping its body in the existing Radix wrapper [`components/ui/collapsible.tsx`](frontend/src/components/ui/collapsible.tsx)
  with a chevron in the header. Pass `collapsible defaultCollapsed` **only** on the Templates card (:1167);
  the other nine cards keep their always-open behaviour.

### 10. Ctrl+Z — per-spectrum undo (+ redo) — new `frontend/src/hooks/useMaldiUndo.ts` + `Maldi.tsx`
- **Prerequisite:** the `buildState`/`loadState` gap fields from the data-model section (also fixes a latent
  doc-switch/save bug where those fields are dropped).
- **Snapshot** = extended `ProjectState` + `projectName`. Drop `processed` from the snapshot (re-derived by
  the effect at [:297](frontend/src/pages/Maldi.tsx)); share `raw` by reference (immutable after import).
  Exclude `comparisons` and the append-only `exportHistory`.
- **Per-document history** in a `useRef<Map<docId, {past: Snapshot[], future: Snapshot[]}>>` (a ref, not
  state, so checkpoints don't re-render). Cap ~50 entries; dedup against the top.
- **Checkpointing:** an effect watching the undoable state pushes the previous committed snapshot on settle,
  **debounced ~400 ms** (rapid inputs: projectName, repeat-mass, PeakTable edits, pick sliders), guarded by
  an `isRestoring` ref so `loadState` during undo doesn't re-checkpoint.
- **Keydown:** a window listener (attached in the mount effect :282) for `(ctrl|meta)+z` (undo) and
  `shift+z`/`ctrl+y` (redo). **Bail when the event target is input/textarea/contentEditable** so native
  text-undo still works in fields. On fire: move a snapshot between `past`/`future` and call
  `loadState(snapshot)` + `setProjectName`.
- **Document lifecycle:** swap the active history with `activeDocId` on `switchToDoc`/`closeDoc`; clear all on
  `handleNew`; never let undo cross a document boundary.

---

## Files touched
- **Types/logic:** `lib/maldi/types.ts`, `lib/maldi/peaks.ts`, `lib/maldi/export.ts`
- **Components:** `components/maldi/PeakTable.tsx`, `EndGroupPanel.tsx`, `CompareView.tsx`,
  `MaldiSpectrumPlot.tsx`, `PeakPickingPanel.tsx`, **new** `SeriesTable.tsx`
- **Page/orchestration:** `pages/Maldi.tsx` (largest surface — series handlers, highlight unification, new
  Series tab, PeakTable/compare wiring, collapsible Templates, monoisotopic default, undo)
- **New hook:** `hooks/useMaldiUndo.ts`

## Verification
- `cd frontend && npm run typecheck` and `npm run lint` clean.
- `npm run test` (vitest) — existing `lib/maldi/__tests__` stays green; add a small unit test for the
  series↔end-group assignment matcher and the "unexplained" predicate.
- Drive it in the app (`npm run dev`, MALDI page) with a real/sample spectrum:
  1. Pick peaks → confirm **monoisotopic-only is on by default**.
  2. Detect + Split a repeat, Assign → **Highlight all series shows each series in its own colour and the split ladders stay visible** (no pink collapse); change a series colour and see the plot + swatch update.
  3. In the **Series tab**, set label/description, **Assign** an end group from the End-groups panel → the row and a re-export (CSV/PDF/Excel) show label + description + end-group name.
  4. Peak table: toggle **Unexplained only**, multi-select, **bulk-colour + label**, and **delete**; colours show on the plot.
  5. Compare tab: **add an open spectrum**, toggle its visibility/offset/colour, and scroll a long list.
  6. **Templates** card starts collapsed.
  7. Make several edits (label a peak, recolour a series, delete peaks) → **Ctrl+Z** reverts each; open a second spectrum and confirm undo is per-document; verify Ctrl+Z inside a text field does normal text undo.

## Sequencing (suggested)
1. Types + `buildState`/`loadState` gap → 2. Monoisotopic default (quick win) →
3. Highlight unification (#8) + series colours (#3) → 4. Series tab + end-group assign (#1) + exports (#2) →
5. Unexplained peaks (#5) → 6. Compare (#6/#7) → 7. Templates collapse (#9) → 8. Undo (#10, last, it depends on the settled state shape).
