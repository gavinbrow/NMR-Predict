import { Download, FileSpreadsheet } from "lucide-react";
import { useMemo, useState } from "react";
import type { Series } from "uplot";
import { IrChart } from "@/components/ir/IrChart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { downloadSpectraCsv, downloadSpectraExcel } from "@/lib/ir/export";
import { interp } from "@/lib/ir/numerics";
import { buildTable, commonGrid, displayY } from "@/lib/ir/shared";
import { BASELINE_METHODS, type BaselineMethod, type Spectrum, type YAxis } from "@/lib/ir/types";

interface ViewExportProps {
  spectra: Spectrum[];
}

/** Distinct line colours, cycled across overlaid spectra. */
const PALETTE = [
  "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#ea580c", "#0d9488",
  "#9333ea", "#ca8a04", "#0284c7", "#e11d48", "#4f46e5",
];

/** Per-method one-line help shown under the baseline picker. */
const BASELINE_HELP: Record<BaselineMethod, string> = {
  None: "Use the spectra as-is.",
  Offset: "Subtract a constant equal to each spectrum's minimum absorbance.",
  "Linear (2-point)": "Subtract a straight line between two anchor wavenumbers.",
  Rubberband: "Subtract the lower convex-hull envelope (a flexible baseline).",
};

/** When more than this many spectra are loaded, the overlay defaults to a subset. */
const MANY = 15;

export function ViewExport({ spectra }: ViewExportProps) {
  const [yaxis, setYaxis] = useState<YAxis>("%T");
  const [method, setMethod] = useState<BaselineMethod>("None");

  const grid = useMemo(() => commonGrid(spectra), [spectra]);
  const gridMin = grid.length ? Math.round(grid[0]) : 0;
  const gridMax = grid.length ? Math.round(grid[grid.length - 1]) : 0;

  // Linear-baseline anchors (default: full grid span; only used when "Linear").
  const [p1, setP1] = useState<number>(gridMax);
  const [p2, setP2] = useState<number>(gridMin);

  // Which spectra to overlay (export always uses all). Default: a thinned subset
  // when many files are loaded, otherwise everything.
  const defaultSelected = useMemo(() => {
    const names = spectra.map((s) => s.name);
    if (names.length <= MANY) return new Set(names);
    const stride = Math.max(1, Math.floor(names.length / 12));
    return new Set(names.filter((_, i) => i % stride === 0));
  }, [spectra]);
  const [selected, setSelected] = useState<Set<string>>(defaultSelected);

  // Reset the selection whenever the loaded set changes.
  const [selectionKey, setSelectionKey] = useState("");
  const currentKey = spectra.map((s) => s.name).join("|");
  if (currentKey !== selectionKey) {
    setSelectionKey(currentKey);
    setSelected(defaultSelected);
  }

  const usesAnchors = method === "Linear (2-point)";
  const displayed = useMemo(
    () => spectra.filter((s) => selected.has(s.name)),
    [spectra, selected],
  );

  // Overlay data on the common grid: interp each displayed spectrum's y onto it.
  const { data, series } = useMemo(() => {
    const columns = displayed.map((spec) =>
      interp(grid, spec.wavenumber, displayY(spec, yaxis, method, p1, p2)),
    );
    const seriesDefs: Series[] = displayed.map((spec, i) => ({
      label: spec.name,
      stroke: PALETTE[i % PALETTE.length],
      width: 1.5,
      points: { show: false },
    }));
    return {
      data: [grid, ...columns] as [number[], ...number[][]],
      series: seriesDefs,
    };
  }, [displayed, grid, yaxis, method, p1, p2]);

  const yLabel = yaxis === "Absorbance" ? "Absorbance" : "Transmittance (%T)";
  const showLegend = displayed.length <= 20;

  // Export table over ALL spectra (not just the displayed subset).
  const table = useMemo(
    () => buildTable(spectra, yaxis, method, p1, p2),
    [spectra, yaxis, method, p1, p2],
  );
  const previewRows = table.rows.slice(0, 20);
  const [exporting, setExporting] = useState(false);

  const baselineNote = usesAnchors ? `${method} (anchors ${p1}, ${p2} cm⁻¹)` : method;

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">View &amp; Export</h2>
        <p className="text-sm text-muted-foreground">
          Overlay spectra, correct the baseline, and export the aligned data.
        </p>
      </header>

      {/* Controls */}
      <div className="grid gap-5 rounded-2xl border border-border/60 bg-card p-5 shadow-card lg:grid-cols-3">
        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground">Y-axis</Label>
          <RadioGroup
            value={yaxis}
            onValueChange={(v) => setYaxis(v as YAxis)}
            className="flex gap-4"
          >
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="%T" id="vx-pct" />
              %T
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="Absorbance" id="vx-abs" />
              Absorbance
            </label>
          </RadioGroup>
        </div>

        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground">Baseline correction</Label>
          <Select value={method} onValueChange={(v) => setMethod(v as BaselineMethod)}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BASELINE_METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{BASELINE_HELP[method]}</p>
          {usesAnchors && (
            <div className="mt-1 grid grid-cols-2 gap-2">
              <div className="grid gap-1">
                <Label className="text-[11px] text-muted-foreground">Anchor 1 (cm⁻¹)</Label>
                <Input
                  type="number"
                  step={1}
                  value={p1}
                  onChange={(e) => setP1(Number(e.target.value))}
                  className="h-8"
                />
              </div>
              <div className="grid gap-1">
                <Label className="text-[11px] text-muted-foreground">Anchor 2 (cm⁻¹)</Label>
                <Input
                  type="number"
                  step={1}
                  value={p2}
                  onChange={(e) => setP2(Number(e.target.value))}
                  className="h-8"
                />
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">
              Spectra to display ({displayed.length}/{spectra.length})
            </Label>
            <div className="flex gap-2 text-[11px]">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setSelected(new Set(spectra.map((s) => s.name)))}
              >
                All
              </button>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setSelected(new Set())}
              >
                None
              </button>
            </div>
          </div>
          <ScrollArea className="h-28 rounded-lg border border-border/60 bg-background/40 p-2">
            <div className="grid gap-1">
              {spectra.map((s) => (
                <label key={s.name} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selected.has(s.name)}
                    onChange={() => toggle(s.name)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="truncate" title={s.name}>
                    {s.name}
                  </span>
                </label>
              ))}
            </div>
          </ScrollArea>
          <p className="text-[11px] text-muted-foreground">Export always uses all spectra.</p>
        </div>
      </div>

      {/* Overlay chart */}
      <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-card">
        {displayed.length === 0 ? (
          <p className="py-20 text-center text-sm text-muted-foreground">
            Select at least one spectrum to display.
          </p>
        ) : (
          <IrChart
            data={data}
            series={series}
            reversedX
            legend={showLegend}
            yLabel={yLabel}
            height={560}
          />
        )}
      </div>

      {/* Export */}
      <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Export</h3>
            <p className="text-xs text-muted-foreground">
              {spectra.length} spectra · {grid.length}-point grid · {yaxis} · baseline:{" "}
              {baselineNote}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadSpectraCsv(table)}>
              <Download className="mr-1.5 h-4 w-4" />
              CSV
            </Button>
            <Button
              size="sm"
              disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  await downloadSpectraExcel(table, yaxis);
                } finally {
                  setExporting(false);
                }
              }}
            >
              <FileSpreadsheet className="mr-1.5 h-4 w-4" />
              Excel
            </Button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                {table.headers.map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-1.5 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, r) => (
                <tr key={r} className="border-t border-border/40">
                  {row.map((v, c) => (
                    <td key={c} className="whitespace-nowrap px-3 py-1 tabular-nums">
                      {Number.isFinite(v) ? v.toFixed(c === 0 ? 1 : 4) : ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Preview of the first {previewRows.length} of {table.rows.length} rows.
        </p>
      </div>
    </div>
  );
}
