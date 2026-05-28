import { useState } from "react";
import { FileSpreadsheet, FileText, Plus, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  MODEL_LABELS,
  formatHalfLife,
  formatRate,
  type AnalysisColumn,
  type FitResult,
  type KineticModelKind,
  type KineticSpectrum,
  type PeakRole,
  type TimeUnit,
  type Timepoint,
  type TrackedPeak,
} from "@/lib/nmr/kinetics";

interface KineticsPanelProps {
  spectra: KineticSpectrum[];
  analysisColumns: AnalysisColumn[];
  onImportAnalysisColumns: () => void;
  timepoints: Record<string, Timepoint | undefined>;
  onTimepointChange: (spectrumId: string, timepoint: Timepoint | undefined) => void;
  trackedPeaks: TrackedPeak[];
  onAddPeak: (peak: { label: string; from: number; to: number; role: PeakRole }) => void;
  onRemovePeak: (id: string) => void;
  onPeakRoleChange: (id: string, role: PeakRole) => void;
  model: KineticModelKind;
  onModelChange: (model: KineticModelKind) => void;
  displayUnit: TimeUnit;
  onDisplayUnitChange: (unit: TimeUnit) => void;
  fitByPeak: Record<string, FitResult | null>;
  showConnectingLine: boolean;
  onShowConnectingLineChange: (value: boolean) => void;
  showFitLine: boolean;
  onShowFitLineChange: (value: boolean) => void;
  onExportPdf: () => void;
  onExportExcel: () => void;
  exporting: boolean;
}

const TIME_UNITS: TimeUnit[] = ["s", "min", "h"];
const MODELS: KineticModelKind[] = ["zero", "first", "second", "growth"];

const ROLE_LABELS: Record<PeakRole, string> = {
  reactant: "Reactant",
  product: "Product",
  standard: "Standard",
};
const ROLES: PeakRole[] = ["reactant", "product", "standard"];

function roleOf(peak: TrackedPeak): PeakRole {
  return peak.role ?? "reactant";
}

type FillPreset = "exponential" | "linear";

const FILL_PRESET_LABELS: Record<FillPreset, string> = {
  exponential: "Exponential (0, ½×, doubling)",
  linear: "Linear (even steps)",
};

/**
 * Generate a sequence of timepoint values for `count` spectra in acquisition order.
 *  - exponential: 0, base, base·2, base·4, … (the common 0, 0.5, 1, 2, 4 ramp)
 *  - linear:      0, step, 2·step, 3·step, …
 */
function buildPresetTimes(preset: FillPreset, count: number, step: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (preset === "linear") {
      values.push(i * step);
    } else {
      values.push(i === 0 ? 0 : step * 2 ** (i - 1));
    }
  }
  return values;
}

export function KineticsPanel({
  spectra,
  analysisColumns,
  onImportAnalysisColumns,
  timepoints,
  onTimepointChange,
  trackedPeaks,
  onAddPeak,
  onRemovePeak,
  onPeakRoleChange,
  model,
  onModelChange,
  displayUnit,
  onDisplayUnitChange,
  fitByPeak,
  showConnectingLine,
  onShowConnectingLineChange,
  showFitLine,
  onShowFitLineChange,
  onExportPdf,
  onExportExcel,
  exporting,
}: KineticsPanelProps) {
  const [label, setLabel] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [role, setRole] = useState<PeakRole>("reactant");
  const [fillPreset, setFillPreset] = useState<FillPreset>("exponential");
  const [fillStep, setFillStep] = useState("0.5");
  const [fillUnit, setFillUnit] = useState<TimeUnit>("min");

  const hasStandard = trackedPeaks.some((peak) => roleOf(peak) === "standard");
  const hasFittable = trackedPeaks.some((peak) => roleOf(peak) !== "standard");

  const handleApplyPreset = () => {
    const step = Number(fillStep);
    if (!Number.isFinite(step)) return;
    const times = buildPresetTimes(fillPreset, spectra.length, step);
    spectra.forEach((spectrum, index) => {
      onTimepointChange(spectrum.id, { value: times[index], unit: fillUnit });
    });
  };

  const canAdd =
    label.trim().length > 0 && from.trim().length > 0 && to.trim().length > 0 &&
    Number.isFinite(Number(from)) && Number.isFinite(Number(to));

  const handleAdd = () => {
    if (!canAdd) return;
    const a = Number(from);
    const b = Number(to);
    onAddPeak({ label: label.trim(), from: Math.max(a, b), to: Math.min(a, b), role });
    setLabel("");
    setFrom("");
    setTo("");
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 1. Timepoints */}
      <Card className="border-border/70 shadow-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Timepoints</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {spectra.length === 0 ? (
            <p className="px-6 pb-2 text-xs text-muted-foreground">
              Drop spectra into the viewer to assign acquisition times.
            </p>
          ) : (
            <>
            {/* Auto-fill: prefill times in acquisition order, then edit any row. */}
            <div className="mb-3 flex flex-wrap items-end gap-2 px-6">
              <div className="grid flex-1 gap-1.5">
                <Label className="text-[11px] text-muted-foreground">Auto-fill pattern</Label>
                <Select value={fillPreset} onValueChange={(value) => setFillPreset(value as FillPreset)}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(FILL_PRESET_LABELS) as FillPreset[]).map((preset) => (
                      <SelectItem key={preset} value={preset}>
                        {FILL_PRESET_LABELS[preset]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid w-20 gap-1.5">
                <Label className="text-[11px] text-muted-foreground">
                  {fillPreset === "linear" ? "Step" : "Base"}
                </Label>
                <Input
                  className="h-8"
                  type="number"
                  inputMode="decimal"
                  value={fillStep}
                  onChange={(event) => setFillStep(event.target.value)}
                />
              </div>
              <div className="grid w-16 gap-1.5">
                <Label className="text-[11px] text-muted-foreground">Unit</Label>
                <Select value={fillUnit} onValueChange={(value) => setFillUnit(value as TimeUnit)}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIME_UNITS.map((unit) => (
                      <SelectItem key={unit} value={unit}>
                        {unit}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" variant="secondary" className="h-8" onClick={handleApplyPreset}>
                <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                Fill
              </Button>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Spectrum</TableHead>
                  <TableHead className="w-24">Time</TableHead>
                  <TableHead className="w-20 pr-6">Unit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {spectra.map((spectrum) => {
                  const tp = timepoints[spectrum.id];
                  return (
                    <TableRow key={spectrum.id}>
                      <TableCell className="max-w-[160px] truncate pl-6 text-xs" title={spectrum.name}>
                        {spectrum.name}
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          inputMode="decimal"
                          className="h-8"
                          value={tp?.value ?? ""}
                          onChange={(event) => {
                            const raw = event.target.value;
                            if (raw === "") {
                              onTimepointChange(spectrum.id, undefined);
                              return;
                            }
                            onTimepointChange(spectrum.id, {
                              value: Number(raw),
                              unit: tp?.unit ?? "min",
                            });
                          }}
                        />
                      </TableCell>
                      <TableCell className="pr-6">
                        <Select
                          value={tp?.unit ?? "min"}
                          onValueChange={(unit) =>
                            onTimepointChange(spectrum.id, {
                              value: tp?.value ?? 0,
                              unit: unit as TimeUnit,
                            })
                          }
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {TIME_UNITS.map((unit) => (
                              <SelectItem key={unit} value={unit}>
                                {unit}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </>
          )}
        </CardContent>
      </Card>

      {/* 2. Tracked peaks */}
      <Card className="border-border/70 shadow-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Tracked peaks</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="grid gap-1.5">
              <Label className="text-[11px] text-muted-foreground">Label</Label>
              <Input
                className="h-8"
                placeholder="e.g. Product"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="grid w-20 gap-1.5">
                <Label className="text-[11px] text-muted-foreground">From ppm</Label>
                <Input
                  className="h-8"
                  type="number"
                  inputMode="decimal"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </div>
              <div className="grid w-20 gap-1.5">
                <Label className="text-[11px] text-muted-foreground">To ppm</Label>
                <Input
                  className="h-8"
                  type="number"
                  inputMode="decimal"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-[11px] text-muted-foreground">Role</Label>
            <Select value={role} onValueChange={(value) => setRole(value as PeakRole)}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {ROLE_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" className="w-full" disabled={!canAdd} onClick={handleAdd}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add tracked peak
          </Button>

          {analysisColumns.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={onImportAnalysisColumns}
            >
              Import {analysisColumns.length} range
              {analysisColumns.length === 1 ? "" : "s"} from multiple-spectra analysis
            </Button>
          )}

          {trackedPeaks.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {trackedPeaks.map((peak) => (
                <li
                  key={peak.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5"
                >
                  <span className="flex min-w-0 items-center gap-2 text-xs">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: peak.color }}
                    />
                    <span className="truncate font-medium text-foreground">{peak.label}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {peak.from.toFixed(2)}–{peak.to.toFixed(2)} ppm
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <Select
                      value={roleOf(peak)}
                      onValueChange={(value) => onPeakRoleChange(peak.id, value as PeakRole)}
                    >
                      <SelectTrigger className="h-7 w-[104px] text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((kind) => (
                          <SelectItem key={kind} value={kind}>
                            {ROLE_LABELS[kind]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <button
                      type="button"
                      aria-label={`Remove ${peak.label}`}
                      className="text-muted-foreground transition-smooth hover:text-destructive"
                      onClick={() => onRemovePeak(peak.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 3 + 4. Model, display, results, export */}
      <Card className="border-border/70 shadow-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Analysis</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-[11px] leading-4 text-muted-foreground">
            {hasStandard
              ? "Peaks marked “Standard” normalize the others — they are not plotted or fit."
              : "Mark a peak “Standard” to normalize the others, or fit reactant/product peaks directly."}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label className="text-[11px] text-muted-foreground">Kinetic model</Label>
              <Select value={model} onValueChange={(value) => onModelChange(value as KineticModelKind)}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {MODEL_LABELS[kind]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-[11px] text-muted-foreground">Rate unit</Label>
              <Select
                value={displayUnit}
                onValueChange={(value) => onDisplayUnitChange(value as TimeUnit)}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIME_UNITS.map((unit) => (
                    <SelectItem key={unit} value={unit}>
                      {unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Chart display toggles */}
          <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/60 p-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="toggle-connect" className="text-xs font-normal text-foreground">
                Connect data points
              </Label>
              <Switch
                id="toggle-connect"
                checked={showConnectingLine}
                onCheckedChange={onShowConnectingLineChange}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="toggle-fit" className="text-xs font-normal text-foreground">
                Show fit line
              </Label>
              <Switch
                id="toggle-fit"
                checked={showFitLine}
                onCheckedChange={onShowFitLineChange}
              />
            </div>
          </div>

          {/* Results */}
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
            {trackedPeaks.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Add a tracked peak to fit a rate constant.
              </p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {trackedPeaks.map((peak) => {
                  const fit = fitByPeak[peak.id];
                  const isStandard = roleOf(peak) === "standard";
                  return (
                    <div key={peak.id} className="text-xs">
                      <div className="flex items-center gap-2 font-medium text-foreground">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: peak.color }}
                        />
                        {peak.label}
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                          {ROLE_LABELS[roleOf(peak)].toLowerCase()}
                        </span>
                      </div>
                      {isStandard ? (
                        <p className="mt-0.5 pl-4 text-muted-foreground">
                          Used to normalize other peaks.
                        </p>
                      ) : !fit || !Number.isFinite(fit.k) ? (
                        <p className="mt-0.5 pl-4 text-muted-foreground">
                          Need ≥2 timepoints with this peak integrated.
                        </p>
                      ) : (
                        <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pl-4 text-muted-foreground">
                          <dt>k</dt>
                          <dd className="font-mono text-foreground">
                            {formatRate(fit.k, fit.model, displayUnit)}
                          </dd>
                          {fit.model === "first" && (
                            <>
                              <dt>t½</dt>
                              <dd className="font-mono text-foreground">
                                {formatHalfLife(fit.halfLife, displayUnit)}
                              </dd>
                            </>
                          )}
                          <dt>R²</dt>
                          <dd className="font-mono text-foreground">{fit.rSquared.toFixed(4)}</dd>
                          <dt>points</dt>
                          <dd className="font-mono text-foreground">{fit.pointCount}</dd>
                        </dl>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Export */}
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={exporting || !hasFittable}
              onClick={onExportPdf}
            >
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              Export PDF
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={exporting || !hasFittable}
              onClick={onExportExcel}
            >
              <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />
              Export Excel
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
