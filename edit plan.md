# GPC & ESI Reader — Implementation Plan

## Goal
Add a new "GC/MS & ESI" tab to the NMR Predict app that reads Agilent 6890/5973
`.D` folder output (GC/MS) plus common ESI-MS file formats, and provides basic
analysis: metadata view, chromatogram (TIC), mass spectrum, peak table, export.

## The GPC Example folder (sample data)
An Agilent ChemStation `.D` directory containing:
- `DATA.MS`        — binary scan data (575 KB). Header = "GC / MS DATA FILE".
                     First ~0x2000 bytes: UTF-16LE / latin1 text descriptors
                     (operator, date, instrument, method, tune file, paths).
                     Scan records follow, each begins with marker
                     `00 05 00 04 00 00 00 00`, then a 16-byte scan header
                     (retention time, point count, m/z range), then packed
                     (mz, intensity) pairs. Scan range from acqmeth.txt:
                     50–550 Da, 22 min run, scan mode.
- `acqmeth.txt`    — plain-text GC + MS acquisition method (oven ramps, inlet,
                     column, MS zones, tune params, scan parameters).
- `PRE_POST.INI`   — INI run metadata (instrument SN, tune, scan params,
                     firmware, sequence, factors).
- `cnorm.ini`      — INI tune calibration (target masses, atune/stune norms).

## Scope (basics first)
### Reliable (MVP)
1. Parse text metadata: `acqmeth.txt`, `PRE_POST.INI`, `cnorm.ini` — 100%
   reliable; structured into typed objects.
2. Parse `DATA.MS` header descriptors (operator, date, instrument, method, tune,
   paths) — reliable.
3. ESI formats: mzML / mzXML / MGF — reuse the existing MALDI `parseMs` logic
   (copy/adapt into `lib/gpc/parseMs.ts`).
4. Spectrum viewer (m/z vs intensity) for ESI files, using recharts.
5. Metadata panel showing all parsed method/run/tune info.
6. Peak table (m/z, intensity) with CSV export.
7. Drag-and-drop / file-picker import; folder import (webkitdirectory) for `.D`.

### Best-effort (improve later)
8. `DATA.MS` scan index: locate scan records, extract retention time + TIC,
   build a TIC chromatogram. m/z-intensity decoding is best-effort given the
   packed binary encoding; clearly mark as approximate.

## Architecture (mirrors existing IR / MALDI workspaces)
```
frontend/src/lib/gpc/
  types.ts        — GpcSpectrum, GpcMetaData, GpcRunInfo, Peak types
  parseMetadata.ts — parse acqmeth.txt / PRE_POST.INI / cnorm.ini
  parseDataMs.ts  — parse DATA.MS header + best-effort scan/TIC extraction
  parseMs.ts      — mzML/mzXML/MGF (adapted from lib/maldi/parseMs.ts)
  load.ts         — dispatch by extension: .D folder, .mzML/.mzXML/.mgf
  export.ts       — CSV (peaks, spectrum), metadata text export
  numerics.ts     — helpers (sort, peak-find simple threshold)

frontend/src/components/gpc/
  ImportPanel.tsx       — dropzone / picker / folder picker + loaded file list
  MetadataPanel.tsx     — method / run / tune metadata viewer
  ChromatogramPlot.tsx  — TIC vs retention time (recharts)
  SpectrumPlot.tsx      — m/z vs intensity (recharts)
  PeakTable.tsx         — sortable peak list
  ExportPanel.tsx       — CSV / text export buttons

frontend/src/pages/GpcEsi.tsx — page: AppShell + sidebar + main panel
```

## Routing / nav (Phase 3)
- Add `/gpc` route + keep-alive in App.tsx
- Add "GC/MS" NavLink in AppShell.tsx
- Add WorkspaceCard on Home.tsx

## Delegation
- Phase 1: build `lib/gpc/` parser lib (1 subagent, thorough)
- Phase 2: build `components/gpc/` + `pages/GpcEsi.tsx` (1 subagent)
- Phase 3: wire routing/nav/home (done alongside Phase 2 or after)
- Phase 4: final bug + usability review