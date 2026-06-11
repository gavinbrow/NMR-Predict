import { useMemo } from "react";
import { Section } from "@/components/ir/Section";
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
  type SeriesStyle,
} from "@/lib/ir/figure";

interface FigureControlsProps {
  data: FigureData;
  options: FigureOptions;
  onChange: (next: FigureOptions) => void;
}

const SIZE_PRESETS = [
  { key: "900x560", label: "Wide (900×560)", w: 900, h: 560 },
  { key: "800x600", label: "4:3 (800×600)", w: 800, h: 600 },
  { key: "1280x720", label: "16:9 (1280×720)", w: 1280, h: 720 },
  { key: "700x700", label: "Square (700×700)", w: 700, h: 700 },
];

const LINE_STYLES: LineStyle[] = ["solid", "dashed", "dotted", "none"];
const GRID_STYLES: GridStyle[] = ["solid", "dashed", "dotted"];
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
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
}) {
  return (
    <div className="grid gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step={step}
        min={min}
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
}: {
  style: SeriesStyle;
  onPatch: (p: Partial<SeriesStyle>) => void;
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

/**
 * The full styling panel: title & size, fonts, both axes, per-series styles,
 * and the legend — every visual aspect of the exported figure.
 */
export function FigureControls({ data, options, onChange }: FigureControlsProps) {
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

  const presetKey =
    SIZE_PRESETS.find((s) => s.w === options.width && s.h === options.height)?.key ?? "custom";

  // y-range seeding considers only the currently visible series.
  const visibleIds = new Set(options.series.filter((s) => s.visible).map((s) => s.id));
  const yValues = data.series.filter((s) => visibleIds.has(s.id)).flatMap((s) => s.y);

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

      <Section title="X axis" defaultOpen={false}>
        <AxisControls
          axis={options.x}
          values={data.x}
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
                  <SeriesRow key={s.id} style={s} onPatch={(p) => patchSeries(s.id, p)} />
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="grid gap-2">
              {options.series.map((s) => (
                <SeriesRow key={s.id} style={s} onPatch={(p) => patchSeries(s.id, p)} />
              ))}
            </div>
          )}
        </div>
      </Section>

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
