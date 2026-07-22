import { Eye, EyeOff, RotateCcw } from "lucide-react";
import { useMemo } from "react";
import { Section } from "@/components/ir/Section";
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
import {
  FONT_FAMILIES,
  resolveAxis,
  type AxisOptions,
  type FigureData,
  type FigureOptions,
  type GridStyle,
  type LegendOptions,
  type LegendPosition,
  type LineStyle,
  type PeakLabelDatum,
  type PeakLabelOptions,
  type PeakLabelOverride,
  type SeriesKind,
  type SeriesStyle,
} from "@/lib/ir/figure";

interface FigureControlsProps {
  data: FigureData;
  options: FigureOptions;
  onChange: (next: FigureOptions) => void;
  /** MS-only (peak labels present): the selected label's id and a setter, shared
   *  with the live preview so clicking a label there opens its editor here. */
  selectedLabelId?: string | null;
  onSelectLabel?: (id: string | null) => void;
  /** MS-only: count of in-view labels the thinner dropped (surfaced as a hint). */
  hiddenByThinning?: number;
  /**
   * MS-only figure-only delete: remove the selected peak's stick AND label from
   * this figure (the peak stays in the Peak table / exports — see the MALDI
   * "delete from the figure is figure-only" decision). When a host wires it, the
   * selected-label editor grows a "Delete peak from figure" action. Absent for
   * IR/Kinetics, so the control never appears there. (WP6b)
   */
  onDeleteLabelPeak?: (id: string) => void;
}

const SIZE_PRESETS = [
  { key: "900x560", label: "Wide (900×560)", w: 900, h: 560 },
  { key: "800x600", label: "4:3 (800×600)", w: 800, h: 600 },
  { key: "1280x720", label: "16:9 (1280×720)", w: 1280, h: 720 },
  { key: "700x700", label: "Square (700×700)", w: 700, h: 700 },
];

const LINE_STYLES: LineStyle[] = ["solid", "dashed", "dotted", "none"];
const GRID_STYLES: GridStyle[] = ["solid", "dashed", "dotted"];
const SERIES_KINDS: { value: SeriesKind; label: string }[] = [
  { value: "line", label: "Line" },
  { value: "sticks", label: "Sticks" },
];
const LABEL_ROTATIONS: { value: number; label: string }[] = [
  { value: 0, label: "Horizontal" },
  { value: -45, label: "Diagonal (-45°)" },
  { value: -90, label: "Vertical (-90°)" },
];
const LEGEND_POSITIONS: { value: LegendPosition; label: string }[] = [
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
];

/** A small labelled numeric input. */
function NumField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <div className="grid gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step={step}
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8"
      />
    </div>
  );
}

/** A small labelled text input. */
function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="grid gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8"
      />
    </div>
  );
}

/** A checkbox line in the IR section's plain-input idiom. */
function CheckLine({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5"
      />
      {label}
    </label>
  );
}

/** Colour swatch input (native picker). */
function ColorField({
  label,
  value,
  onChange,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const input = (
    <input
      type="color"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-10 cursor-pointer rounded-md border border-border/60 bg-background p-0.5"
      title="Pick colour"
    />
  );
  if (!label) return input;
  return (
    <div className="grid gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {input}
    </div>
  );
}

/** Range, ticks, and gridline controls shared by the X and Y axes. */
function AxisControls({
  axis,
  values,
  onPatch,
}: {
  axis: AxisOptions;
  values: number[];
  onPatch: (p: Partial<AxisOptions>) => void;
}) {
  const resolved = useMemo(() => resolveAxis(axis, values), [axis, values]);
  const auto = axis.min === null && axis.max === null;
  const invalid = axis.min !== null && axis.max !== null && !(axis.min < axis.max);

  return (
    <div className="grid gap-3">
      <TextField label="Label" value={axis.label} onChange={(v) => onPatch({ label: v })} />

      <CheckLine
        label="Auto range"
        checked={auto}
        onChange={(on) =>
          onPatch(on ? { min: null, max: null } : { min: resolved.lo, max: resolved.hi })
        }
      />
      {!auto && (
        <div className="grid grid-cols-2 gap-2">
          <NumField
            label="Min"
            value={axis.min ?? resolved.lo}
            onChange={(v) => onPatch({ min: v })}
            step={0.1}
          />
          <NumField
            label="Max"
            value={axis.max ?? resolved.hi}
            onChange={(v) => onPatch({ max: v })}
            step={0.1}
          />
        </div>
      )}
      {invalid && (
        <p className="text-[11px] text-destructive">
          Min must be below max — using the auto range instead.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Ticks</Label>
          <Select
            value={axis.tickCount === null ? "auto" : String(axis.tickCount)}
            onValueChange={(v) => onPatch({ tickCount: v === "auto" ? null : Number(v) })}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              {[3, 4, 5, 6, 8, 10].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  ~{n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Decimals</Label>
          <Select
            value={axis.decimals === null ? "auto" : String(axis.decimals)}
            onValueChange={(v) => onPatch({ decimals: v === "auto" ? null : Number(v) })}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              {[0, 1, 2, 3, 4].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <CheckLine
        label="Show tick labels"
        checked={axis.showTickLabels}
        onChange={(v) => onPatch({ showTickLabels: v })}
      />
      <CheckLine
        label="Gridlines"
        checked={axis.showGrid}
        onChange={(v) => onPatch({ showGrid: v })}
      />
      {axis.showGrid && (
        <div className="grid grid-cols-3 gap-2">
          <ColorField
            label="Colour"
            value={axis.gridColor}
            onChange={(v) => onPatch({ gridColor: v })}
          />
          <NumField
            label="Width"
            value={axis.gridWidth}
            onChange={(v) => onPatch({ gridWidth: v })}
            step={0.5}
            min={0.5}
          />
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Style</Label>
            <Select
              value={axis.gridStyle}
              onValueChange={(v) => onPatch({ gridStyle: v as GridStyle })}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GRID_STYLES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}

/** One series' style editor row. */
function SeriesRow({
  style,
  onPatch,
  showKind,
}: {
  style: SeriesStyle;
  onPatch: (p: Partial<SeriesStyle>) => void;
  /** Expose the line/sticks toggle (spectrum-style figures only). */
  showKind?: boolean;
}) {
  return (
    <div className="grid gap-2 rounded-lg border border-border/50 bg-background/40 p-2">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={style.visible}
          onChange={(e) => onPatch({ visible: e.target.checked })}
          className="h-3.5 w-3.5"
          title="Visible"
        />
        <ColorField value={style.color} onChange={(v) => onPatch({ color: v })} />
        <Input
          value={style.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          className="h-8 min-w-0 flex-1 text-xs"
          title={style.label}
        />
        {showKind && (
          <Select value={style.kind} onValueChange={(v) => onPatch({ kind: v as SeriesKind })}>
            <SelectTrigger className="h-8 w-24 shrink-0" title="Draw as a line or vertical sticks">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SERIES_KINDS.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="grid grid-cols-4 items-end gap-2">
        <NumField
          label="Width"
          value={style.lineWidth}
          onChange={(v) => onPatch({ lineWidth: v })}
          step={0.5}
          min={0.5}
        />
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Line</Label>
          <Select
            value={style.lineStyle}
            onValueChange={(v) => onPatch({ lineStyle: v as LineStyle })}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LINE_STYLES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="self-center pt-4">
          <CheckLine
            label="Markers"
            checked={style.markers}
            onChange={(v) => onPatch({ markers: v })}
          />
        </div>
        <NumField
          label="Size"
          value={style.markerSize}
          onChange={(v) => onPatch({ markerSize: v })}
          step={0.5}
          min={1}
        />
      </div>
    </div>
  );
}

/** One peak label's row in the label list: eye toggle, colour swatch, the label
 *  text (click to select for the placement editor), and a reset-placement button
 *  once it has been dragged. Mirrors {@link SeriesRow}'s bordered-row idiom. */
function PeakLabelRow({
  text,
  color,
  hidden,
  moved,
  selected,
  onSelect,
  onToggleHidden,
  onReset,
}: {
  text: string;
  color: string;
  hidden: boolean;
  moved: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggleHidden: () => void;
  onReset: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2 py-1 ${
        selected ? "border-primary/60 bg-primary/5" : "border-border/50 bg-background/40"
      }`}
    >
      <button
        type="button"
        onClick={onToggleHidden}
        title={hidden ? "Show label" : "Hide label"}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-border/60"
        style={{ backgroundColor: color }}
        title="Label colour (set per-peak in the Peak table)"
      />
      <button
        type="button"
        onClick={onSelect}
        title={text}
        className={`min-w-0 flex-1 truncate text-left text-xs ${
          hidden ? "text-muted-foreground line-through" : "text-foreground"
        }`}
      >
        {text}
      </button>
      {moved && (
        <button
          type="button"
          onClick={onReset}
          title="Reset placement"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * The full styling panel: title & size, fonts, both axes, per-series styles,
 * and the legend — every visual aspect of the exported figure.
 */
export function FigureControls({
  data,
  options,
  onChange,
  selectedLabelId,
  onSelectLabel,
  hiddenByThinning,
  onDeleteLabelPeak,
}: FigureControlsProps) {
  const patch = (p: Partial<FigureOptions>) => onChange({ ...options, ...p });
  const patchAxis = (key: "x" | "y", p: Partial<AxisOptions>) =>
    onChange({ ...options, [key]: { ...options[key], ...p } });
  const patchSeries = (id: string, p: Partial<SeriesStyle>) =>
    onChange({
      ...options,
      series: options.series.map((s) => (s.id === id ? { ...s, ...p } : s)),
    });
  const patchAllSeries = (p: Partial<SeriesStyle>) =>
    onChange({ ...options, series: options.series.map((s) => ({ ...s, ...p })) });
  const patchLegend = (p: Partial<LegendOptions>) =>
    onChange({ ...options, legend: { ...options.legend, ...p } });
  const patchPeakLabels = (p: Partial<PeakLabelOptions>) =>
    onChange({ ...options, peakLabels: { ...options.peakLabels, ...p } });

  // Patch one label's figure-only override (placement nudge / hide). Keys back at
  // their neutral default are dropped so an override never lingers as an empty
  // object (which would needlessly pin the label past the thinner); an override
  // left with nothing is removed entirely.
  const patchPeakLabelOverride = (id: string, p: Partial<PeakLabelOverride>) => {
    const merged = { ...(options.peakLabels.overrides[id] ?? {}), ...p };
    const cleaned: PeakLabelOverride = {};
    if (merged.hidden) cleaned.hidden = true;
    if (merged.dx) cleaned.dx = merged.dx;
    if (merged.dy) cleaned.dy = merged.dy;
    const overrides = { ...options.peakLabels.overrides };
    if (cleaned.hidden || cleaned.dx || cleaned.dy) overrides[id] = cleaned;
    else delete overrides[id];
    patchPeakLabels({ overrides });
  };

  // Bulk show/hide every label. "Hide all" marks each hidden; "Show all" clears
  // the hidden flag but keeps any placement nudge.
  const setAllLabelsHidden = (hidden: boolean) => {
    const overrides: Record<string, PeakLabelOverride> = { ...options.peakLabels.overrides };
    if (hidden) {
      for (const p of data.peakLabels ?? []) {
        overrides[p.id] = { ...(overrides[p.id] ?? {}), hidden: true };
      }
    } else {
      for (const id of Object.keys(overrides)) {
        const rest = { ...overrides[id] };
        delete rest.hidden;
        if (rest.dx || rest.dy) overrides[id] = rest;
        else delete overrides[id];
      }
    }
    patchPeakLabels({ overrides });
  };

  // Spectrum-style figures (the host supplied peak labels) unlock the line/sticks
  // per-series toggle and the "Peaks & labels" section.
  const msMode = data.peakLabels !== undefined;

  // Effective label colour/text (mirrors FigureSvg's resolution) for the swatches
  // and the selected-label heading in the list below.
  const seriesColorById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of options.series) m.set(s.id, s.color);
    return m;
  }, [options.series]);
  const labelColor = (d: PeakLabelDatum) =>
    d.color ??
    (options.peakLabels.colorBySeries && d.seriesId ? seriesColorById.get(d.seriesId) : undefined) ??
    options.peakLabels.color;
  const labelText = (d: PeakLabelDatum) =>
    !d.customText && options.peakLabels.decimals >= 0 && Number.isFinite(d.x)
      ? d.x.toFixed(options.peakLabels.decimals)
      : d.text;
  const selectedDatum = selectedLabelId
    ? data.peakLabels?.find((p) => p.id === selectedLabelId)
    : undefined;

  const presetKey =
    SIZE_PRESETS.find((s) => s.w === options.width && s.h === options.height)?.key ?? "custom";

  // Range seeding considers only the currently visible series. The x seed honours
  // per-series grids (mass-spectra overlays) when any series carries its own x.
  const visibleIds = new Set(options.series.filter((s) => s.visible).map((s) => s.id));
  const visibleSeries = data.series.filter((s) => visibleIds.has(s.id));
  const yValues = visibleSeries.flatMap((s) => s.y);
  const xValues = visibleSeries.some((s) => s.x)
    ? visibleSeries.flatMap((s) => s.x ?? data.x)
    : data.x;

  // Seed value for the "all line widths" control: the shared width if every
  // series matches, otherwise the first series' width (still applies to all).
  const widths = options.series.map((s) => s.lineWidth);
  const allLineWidth = widths.length ? widths[0] : 1.5;

  return (
    <div className="flex flex-col gap-4">
      <Section title="Title & size">
        <div className="grid gap-3">
          <TextField
            label="Title"
            value={options.title}
            onChange={(v) => patch({ title: v })}
            placeholder="(no title)"
          />
          <NumField
            label="Title font size"
            value={options.titleFontSize}
            onChange={(v) => patch({ titleFontSize: v })}
            min={6}
          />
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Size preset</Label>
            <Select
              value={presetKey}
              onValueChange={(v) => {
                const p = SIZE_PRESETS.find((s) => s.key === v);
                if (p) patch({ width: p.w, height: p.h });
              }}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIZE_PRESETS.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label}
                  </SelectItem>
                ))}
                {presetKey === "custom" && (
                  <SelectItem value="custom" disabled>
                    Custom
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumField
              label="Width (px)"
              value={options.width}
              onChange={(v) => patch({ width: v })}
              step={10}
              min={200}
            />
            <NumField
              label="Height (px)"
              value={options.height}
              onChange={(v) => patch({ height: v })}
              step={10}
              min={150}
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Background</Label>
            <RadioGroup
              value={options.background}
              onValueChange={(v) => patch({ background: v as "white" | "transparent" })}
              className="flex gap-4"
            >
              <label className="flex items-center gap-2 text-xs">
                <RadioGroupItem value="white" id="fig-bg-white" /> White
              </label>
              <label className="flex items-center gap-2 text-xs">
                <RadioGroupItem value="transparent" id="fig-bg-trans" /> Transparent
              </label>
            </RadioGroup>
          </div>
          <CheckLine
            label="Reverse x-axis (high values left)"
            checked={options.reversedX}
            onChange={(v) => patch({ reversedX: v })}
          />
        </div>
      </Section>

      <Section title="Fonts" defaultOpen={false}>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Family</Label>
            <Select value={options.fontFamily} onValueChange={(v) => patch({ fontFamily: v })}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_FAMILIES.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumField
              label="Axis label size"
              value={options.axisFontSize}
              onChange={(v) => patch({ axisFontSize: v })}
              min={6}
            />
            <NumField
              label="Tick label size"
              value={options.tickFontSize}
              onChange={(v) => patch({ tickFontSize: v })}
              min={6}
            />
          </div>
        </div>
      </Section>

      <Section title="Axes & frame" defaultOpen={false}>
        <div className="grid gap-3">
          <CheckLine
            label="Show border box"
            checked={options.frameShow}
            onChange={(v) => patch({ frameShow: v })}
          />
          <div className="grid grid-cols-2 items-end gap-2">
            <ColorField
              label="Axis & border colour"
              value={options.frameColor}
              onChange={(v) => patch({ frameColor: v })}
            />
            <NumField
              label="Border / tick width"
              value={options.frameWidth}
              onChange={(v) => patch({ frameWidth: v })}
              step={0.5}
              min={0.5}
            />
          </div>
          <div className="grid grid-cols-2 items-end gap-2">
            <ColorField
              label="Axis text colour"
              value={options.axisColor}
              onChange={(v) => patch({ axisColor: v })}
            />
            <div className="pb-2">
              <CheckLine
                label="Bold axis text"
                checked={options.axisBold}
                onChange={(v) => patch({ axisBold: v })}
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Turn off the border for an open look; gridlines are toggled per-axis below.
          </p>
        </div>
      </Section>

      <Section title="X axis" defaultOpen={false}>
        <AxisControls
          axis={options.x}
          values={xValues}
          onPatch={(p) => patchAxis("x", p)}
        />
      </Section>

      <Section title="Y axis" defaultOpen={false}>
        <AxisControls axis={options.y} values={yValues} onPatch={(p) => patchAxis("y", p)} />
      </Section>

      <Section title="Series" caption={`${options.series.length} series`}>
        <div className="grid gap-3">
          {/* Bulk control: set every series' line width in one go. */}
          <div className="flex items-end gap-2 rounded-lg border border-border/50 bg-background/40 p-2">
            <div className="w-24">
              <NumField
                label="All line widths"
                value={allLineWidth}
                onChange={(v) => patchAllSeries({ lineWidth: v })}
                step={0.5}
                min={0.5}
              />
            </div>
            <p className="pb-2 text-[11px] text-muted-foreground">
              Applies to every series at once.
            </p>
          </div>

          {options.series.length > 4 ? (
            <ScrollArea className="h-80 pr-3">
              <div className="grid gap-2">
                {options.series.map((s) => (
                  <SeriesRow key={s.id} style={s} showKind={msMode} onPatch={(p) => patchSeries(s.id, p)} />
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="grid gap-2">
              {options.series.map((s) => (
                <SeriesRow key={s.id} style={s} showKind={msMode} onPatch={(p) => patchSeries(s.id, p)} />
              ))}
            </div>
          )}
        </div>
      </Section>

      {msMode && (
        <Section title="Peaks & labels" caption={`${data.peakLabels?.length ?? 0} peaks`}>
          <div className="grid gap-3">
            <CheckLine
              label="Label peaks (m/z)"
              checked={options.peakLabels.show}
              onChange={(v) => patchPeakLabels({ show: v })}
            />
            {options.peakLabels.show && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1">
                    <Label className="text-[11px] text-muted-foreground">Decimals</Label>
                    <Select
                      value={String(options.peakLabels.decimals)}
                      onValueChange={(v) => patchPeakLabels({ decimals: Number(v) })}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="-1">As provided</SelectItem>
                        {[0, 1, 2, 3, 4].map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-[11px] text-muted-foreground">Orientation</Label>
                    <Select
                      value={String(options.peakLabels.rotation)}
                      onValueChange={(v) => patchPeakLabels({ rotation: Number(v) })}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LABEL_ROTATIONS.map((r) => (
                          <SelectItem key={r.value} value={String(r.value)}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 items-end gap-2">
                  <NumField
                    label="Max labels"
                    value={options.peakLabels.maxLabels}
                    onChange={(v) => patchPeakLabels({ maxLabels: Math.max(0, Math.round(v)) })}
                    step={5}
                    min={0}
                  />
                  <NumField
                    label="Min spacing (px)"
                    value={options.peakLabels.minGap}
                    onChange={(v) => patchPeakLabels({ minGap: Math.max(0, v) })}
                    step={2}
                    min={0}
                  />
                </div>
                <div className="grid grid-cols-3 items-end gap-2">
                  <NumField
                    label="Font size"
                    value={options.peakLabels.fontSize}
                    onChange={(v) => patchPeakLabels({ fontSize: v })}
                    min={6}
                    max={48}
                  />
                  <NumField
                    label="Offset (px)"
                    value={options.peakLabels.offset}
                    onChange={(v) => patchPeakLabels({ offset: v })}
                    step={1}
                    min={0}
                    max={200}
                  />
                  <ColorField
                    label="Colour"
                    value={options.peakLabels.color}
                    onChange={(v) => patchPeakLabels({ color: v })}
                  />
                </div>
                <CheckLine
                  label="Bold labels"
                  checked={options.peakLabels.bold}
                  onChange={(v) => patchPeakLabels({ bold: v })}
                />
                <CheckLine
                  label="Colour labels by series"
                  checked={options.peakLabels.colorBySeries}
                  onChange={(v) => patchPeakLabels({ colorBySeries: v })}
                />
                <p className="text-[11px] text-muted-foreground">
                  Labels track the data — only the tallest, non-overlapping peaks in view are
                  drawn (raise “Max labels” or lower “Min spacing” to show more). Drag a label in
                  the preview to move it; its text and colour come from the Peak table. Re-picking
                  peaks resets label placement.
                </p>
                {(hiddenByThinning ?? 0) > 0 && (
                  <p className="text-[11px] text-amber-600">
                    {hiddenByThinning} label{hiddenByThinning === 1 ? "" : "s"} in view hidden by
                    thinning — raise “Max labels” or lower “Min spacing” to show more.
                  </p>
                )}

                {/* Selected-label placement editor (opened by clicking a label in
                    the preview or the list below). */}
                {selectedDatum && (
                  <div className="grid gap-2 rounded-lg border border-primary/40 bg-primary/5 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-xs font-medium text-foreground">
                        Selected: {labelText(selectedDatum)}
                      </span>
                      <button
                        type="button"
                        onClick={() => onSelectLabel?.(null)}
                        className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        Deselect
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <NumField
                        label="Nudge X (px)"
                        value={options.peakLabels.overrides[selectedDatum.id]?.dx ?? 0}
                        onChange={(v) => patchPeakLabelOverride(selectedDatum.id, { dx: v })}
                      />
                      <NumField
                        label="Nudge Y (px)"
                        value={options.peakLabels.overrides[selectedDatum.id]?.dy ?? 0}
                        onChange={(v) => patchPeakLabelOverride(selectedDatum.id, { dy: v })}
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() => patchPeakLabelOverride(selectedDatum.id, { dx: 0, dy: 0 })}
                      >
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                        Reset placement
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() =>
                          patchPeakLabelOverride(selectedDatum.id, {
                            hidden: !options.peakLabels.overrides[selectedDatum.id]?.hidden,
                          })
                        }
                      >
                        {options.peakLabels.overrides[selectedDatum.id]?.hidden
                          ? "Show label"
                          : "Hide label"}
                      </Button>
                      {/* Figure-only delete (MALDI wires it): drops the peak's
                          stick + label from THIS figure; the peak is untouched in
                          the Peak table and every export. */}
                      {onDeleteLabelPeak && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-destructive hover:text-destructive"
                          onClick={() => {
                            onDeleteLabelPeak(selectedDatum.id);
                            onSelectLabel?.(null);
                          }}
                        >
                          Delete peak from figure
                        </Button>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Edit the label’s text and colour in the Peak table.
                      {onDeleteLabelPeak
                        ? " Deleting only removes it from this figure — the peak stays in the table and exports."
                        : ""}
                    </p>
                  </div>
                )}

                {/* Every label, with an eye toggle, colour swatch and reset. */}
                {(data.peakLabels?.length ?? 0) > 0 && (
                  <div className="grid gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-[11px] text-muted-foreground">Individual labels</Label>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => setAllLabelsHidden(false)}
                        >
                          Show all
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => setAllLabelsHidden(true)}
                        >
                          Hide all
                        </Button>
                      </div>
                    </div>
                    {(data.peakLabels?.length ?? 0) > 4 ? (
                      <ScrollArea className="h-56 pr-3">
                        <div className="grid gap-1.5">
                          {(data.peakLabels ?? []).map((d) => {
                            const ov = options.peakLabels.overrides[d.id];
                            return (
                              <PeakLabelRow
                                key={d.id}
                                text={labelText(d)}
                                color={labelColor(d)}
                                hidden={ov?.hidden === true}
                                moved={!!(ov?.dx || ov?.dy)}
                                selected={d.id === selectedLabelId}
                                onSelect={() => onSelectLabel?.(d.id === selectedLabelId ? null : d.id)}
                                onToggleHidden={() =>
                                  patchPeakLabelOverride(d.id, { hidden: !ov?.hidden })
                                }
                                onReset={() => patchPeakLabelOverride(d.id, { dx: 0, dy: 0 })}
                              />
                            );
                          })}
                        </div>
                      </ScrollArea>
                    ) : (
                      <div className="grid gap-1.5">
                        {(data.peakLabels ?? []).map((d) => {
                          const ov = options.peakLabels.overrides[d.id];
                          return (
                            <PeakLabelRow
                              key={d.id}
                              text={labelText(d)}
                              color={labelColor(d)}
                              hidden={ov?.hidden === true}
                              moved={!!(ov?.dx || ov?.dy)}
                              selected={d.id === selectedLabelId}
                              onSelect={() => onSelectLabel?.(d.id === selectedLabelId ? null : d.id)}
                              onToggleHidden={() =>
                                patchPeakLabelOverride(d.id, { hidden: !ov?.hidden })
                              }
                              onReset={() => patchPeakLabelOverride(d.id, { dx: 0, dy: 0 })}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </Section>
      )}

      <Section title="Legend" defaultOpen={false}>
        <div className="grid gap-3">
          <CheckLine
            label="Show legend"
            checked={options.legend.show}
            onChange={(v) => patchLegend({ show: v })}
          />
          {options.legend.show && (
            <>
              <div className="grid gap-1">
                <Label className="text-[11px] text-muted-foreground">Position</Label>
                <Select
                  value={options.legend.position}
                  onValueChange={(v) =>
                    patchLegend({ position: v as LegendPosition, custom: null })
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEGEND_POSITIONS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  {options.legend.custom
                    ? "Custom position set by dragging — pick a corner to reset."
                    : "Or drag the legend in the preview to place it anywhere."}
                </p>
              </div>
              <div className="grid grid-cols-2 items-end gap-2">
                <NumField
                  label="Font size"
                  value={options.legend.fontSize}
                  onChange={(v) => patchLegend({ fontSize: v })}
                  min={6}
                />
                <div className="pb-2">
                  <CheckLine
                    label="Frame"
                    checked={options.legend.frame}
                    onChange={(v) => patchLegend({ frame: v })}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </Section>
    </div>
  );
}
