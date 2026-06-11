import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  TrendlineConfig,
  TrendlineFit,
  TrendlineStyle,
  TrendlineType,
} from "@/lib/ir/trendline";

interface TrendlineControlsProps {
  config: TrendlineConfig;
  onChange: (next: TrendlineConfig) => void;
  /** The computed fit, used to show the equation / R² (or why it failed). */
  fit: TrendlineFit;
  /** Data x-extent, shown as the placeholder for the (auto) fit range. */
  dataMin: number;
  dataMax: number;
  /** x-axis unit label (e.g. "min") for the range inputs. */
  unit?: string;
}

const TYPES: { value: TrendlineType; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "polynomial", label: "Polynomial" },
  { value: "exponential", label: "Exponential" },
  { value: "logarithmic", label: "Logarithmic" },
  { value: "power", label: "Power" },
];
const STYLES: TrendlineStyle[] = ["solid", "dashed", "dotted"];

const num = (v: number) => (Number.isFinite(v) ? String(Number(v.toPrecision(4))) : "—");

/**
 * The "line of best fit" panel shown beneath a result plot. Toggles a regression
 * trendline and exposes its fit type, force-through-origin, fit range, and
 * appearance. The fitted equation and R² are reported live underneath.
 */
export function TrendlineControls({
  config,
  onChange,
  fit,
  dataMin,
  dataMax,
  unit,
}: TrendlineControlsProps) {
  const patch = (p: Partial<TrendlineConfig>) => onChange({ ...config, ...p });
  const allowsOrigin = config.type === "linear" || config.type === "polynomial";

  return (
    <div className="mt-2 rounded-lg border border-border/50 bg-background/40 p-3">
      <label className="flex items-center gap-2 text-xs font-medium text-foreground">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="h-3.5 w-3.5"
        />
        Line of best fit
      </label>

      {config.enabled && (
        <div className="mt-3 grid gap-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label className="text-[11px] text-muted-foreground">Fit type</Label>
              <Select
                value={config.type}
                onValueChange={(v) => patch({ type: v as TrendlineType })}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {config.type === "polynomial" && (
              <div className="grid gap-1">
                <Label className="text-[11px] text-muted-foreground">Degree</Label>
                <Select
                  value={String(config.degree)}
                  onValueChange={(v) => patch({ degree: Number(v) })}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[2, 3, 4, 5, 6].map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {allowsOrigin && (
            <label className="flex items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={config.throughOrigin}
                onChange={(e) => patch({ throughOrigin: e.target.checked })}
                className="h-3.5 w-3.5"
              />
              Force through origin (0, 0)
            </label>
          )}

          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">
              Fit range{unit ? ` (${unit})` : ""} — blank = all points
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="number"
                value={config.rangeMin ?? ""}
                placeholder={`from ${num(dataMin)}`}
                onChange={(e) =>
                  patch({ rangeMin: e.target.value === "" ? null : Number(e.target.value) })
                }
                className="h-8"
              />
              <Input
                type="number"
                value={config.rangeMax ?? ""}
                placeholder={`to ${num(dataMax)}`}
                onChange={(e) =>
                  patch({ rangeMax: e.target.value === "" ? null : Number(e.target.value) })
                }
                className="h-8"
              />
            </div>
          </div>

          <div className="grid grid-cols-[auto_1fr_1fr] items-end gap-2">
            <div className="grid gap-1">
              <Label className="text-[11px] text-muted-foreground">Colour</Label>
              <input
                type="color"
                value={config.color}
                onChange={(e) => patch({ color: e.target.value })}
                className="h-8 w-10 cursor-pointer rounded-md border border-border/60 bg-background p-0.5"
                title="Pick colour"
              />
            </div>
            <div className="grid gap-1">
              <Label className="text-[11px] text-muted-foreground">Width</Label>
              <Input
                type="number"
                step={0.5}
                min={0.5}
                value={config.width}
                onChange={(e) => patch({ width: Number(e.target.value) })}
                className="h-8"
              />
            </div>
            <div className="grid gap-1">
              <Label className="text-[11px] text-muted-foreground">Style</Label>
              <Select
                value={config.style}
                onValueChange={(v) => patch({ style: v as TrendlineStyle })}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STYLES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={config.showEquation}
              onChange={(e) => patch({ showEquation: e.target.checked })}
              className="h-3.5 w-3.5"
            />
            Show equation + R² on the plot
          </label>

          {/* Live fit status */}
          {fit.ok ? (
            <p className="rounded-md border border-border/50 bg-card px-2.5 py-1.5 text-[11px] tabular-nums text-foreground">
              <span className="font-medium" style={{ color: config.color }}>
                {fit.equation}
              </span>
              <span className="text-muted-foreground">
                {"  "}· R² = {Number.isFinite(fit.r2) ? fit.r2.toFixed(4) : "—"} · {fit.n} pts
              </span>
            </p>
          ) : (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
              {fit.error ?? "Could not fit a line to these points."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
