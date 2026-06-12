import { Download, FileSpreadsheet, FileText, Play } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { Series } from "uplot";
import { FigurePopout } from "@/components/ir/figure/FigureDialog";
import { IrChart, type IrChartHandle } from "@/components/ir/IrChart";
import { Section } from "@/components/ir/Section";
import { TrendlineControls } from "@/components/ir/TrendlineControls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { correctBaseline } from "@/lib/ir/baseline";
import {
  PALETTE,
  type FigureAnnotation,
  type FigureData,
  type FigureSeriesData,
} from "@/lib/ir/figure";
import { analyze, fitOrders, measurePeak } from "@/lib/ir/kinetics";
import {
  defaultTrendlineConfig,
  fitTrendline,
  type TrendlineConfig,
  type TrendlineFit,
  type TrendlineStyle,
} from "@/lib/ir/trendline";
import { interp, naturalCompare } from "@/lib/ir/numerics";
import {
  downloadKineticsCsv,
  downloadKineticsExcel,
  downloadKineticsPdf,
} from "@/lib/ir/report";
import { commonGrid } from "@/lib/ir/shared";
import {
  BASELINE_METHODS,
  type BaselineMethod,
  type KineticsReport,
  type KineticsResult,
  type MeasureMode,
  type OrderFit,
  type PeakConfig,
  type Spectrum,
  type TimeUnit,
  type WindowBaseline,
  type YAxis,
} from "@/lib/ir/types";

interface KineticsProps {
  spectra: Spectrum[];
}

const TRACK_FILL = "rgba(251, 146, 60, 0.18)"; // light salmon — tracked window
const REF_FILL = "rgba(34, 197, 94, 0.16)"; //   light green  — reference window

const TIME_UNITS: TimeUnit[] = ["min", "s", "h"];

/** %g-style formatting (4 sig-figs, trimmed). */
function g(x: number, sig = 4): string {
  if (!Number.isFinite(x)) return "—";
  if (x === 0) return "0";
  return Number(x.toPrecision(sig)).toString();
}

/** A completed analysis run — measured arrays, fit results, and the input stamp. */
interface RunState {
  result: KineticsResult;
  orders: OrderFit[];
  /** Raw tracked-peak measure, filtered to the finite pairs `analyze` kept. */
  rawKept: number[];
  /** Reference-peak measure on the same finite pairs (only when a reference is used). */
  refKept?: number[];
  signalUnit: string;
  peak: PeakConfig;
  refPeak?: PeakConfig;
  useReference: boolean;
  signature: string;
}

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

export function Kinetics({ spectra }: KineticsProps) {
  // Spectra in natural order (file2 before file10).
  const ordered = useMemo(
    () => [...spectra].sort((a, b) => naturalCompare(a.name, b.name)),
    [spectra],
  );
  const grid = useMemo(() => commonGrid(ordered), [ordered]);
  const gridMin = grid.length ? Math.round(grid[0]) : 0;
  const gridMax = grid.length ? Math.round(grid[grid.length - 1]) : 0;

  // --- Step 1: time series order & spacing ---------------------------------
  const [interval, setInterval] = useState(1);
  const [timeUnit, setTimeUnit] = useState<TimeUnit>("min");
  const [startT0, setStartT0] = useState(0);
  const [times, setTimes] = useState<number[]>([]);
  const [timesKey, setTimesKey] = useState("");
  const tKey = `${ordered.map((s) => s.name).join("|")}|${interval}|${startT0}`;
  if (tKey !== timesKey) {
    setTimesKey(tKey);
    setTimes(ordered.map((_, i) => startT0 + interval * i));
  }
  const setTimeAt = (i: number, v: number) =>
    setTimes((prev) => prev.map((t, j) => (j === i ? v : t)));

  // --- Step 2: full-spectrum baseline --------------------------------------
  const [method, setMethod] = useState<BaselineMethod>("None");
  const [bp1, setBp1] = useState(0);
  const [bp2, setBp2] = useState(0);
  const [anchorKey, setAnchorKey] = useState("");
  const gKey = `${gridMin}:${gridMax}`;
  if (gKey !== anchorKey) {
    setAnchorKey(gKey);
    setBp1(gridMax);
    setBp2(gridMin);
  }

  // absStack[i]: baseline-corrected absorbance for spectrum i, on the common grid.
  const absStack = useMemo(
    () =>
      ordered.map((s) =>
        interp(grid, s.wavenumber, correctBaseline(method, s.wavenumber, s.absorbance, bp1, bp2)),
      ),
    [ordered, grid, method, bp1, bp2],
  );

  // --- Step 3: peak (and optional reference) to track ----------------------
  const [center, setCenter] = useState(2570);
  const [halfwidth, setHalfwidth] = useState(25);
  const [measure, setMeasure] = useState<MeasureMode>("height");
  const [winBaseline, setWinBaseline] = useState<WindowBaseline>("linear");
  const [useReference, setUseReference] = useState(false);
  const [rcenter, setRcenter] = useState(1730);
  const [rhalf, setRhalf] = useState(25);
  const [rmeasure, setRmeasure] = useState<MeasureMode>("height");
  const [rbaseline, setRbaseline] = useState<WindowBaseline>("linear");

  // --- Step 4: overlay display + drag mode ---------------------------------
  const [dispYaxis, setDispYaxis] = useState<YAxis>("%T");
  const [setWindowMode, setSetWindowMode] = useState(false); // false = Zoom, true = Set window
  const [bandSets, setBandSets] = useState<"track" | "reference">("track");

  // disp_stack: the y the overlay actually plots (absorbance or %T).
  const dispStack = useMemo(
    () =>
      dispYaxis === "Absorbance"
        ? absStack
        : absStack.map((row) => row.map((a) => 100 * Math.pow(10, -a))),
    [absStack, dispYaxis],
  );

  const overlay = useMemo(() => {
    const seriesDefs: Series[] = ordered.map((_, i) => ({
      label: `${times[i] ?? i} ${timeUnit}`,
      stroke: PALETTE[i % PALETTE.length],
      width: 1.25,
      points: { show: false },
    }));
    return {
      data: [grid, ...dispStack] as [number[], ...number[][]],
      series: seriesDefs,
    };
  }, [ordered, grid, dispStack, times, timeUnit]);

  const bands = useMemo(() => {
    const list = [{ lo: center - halfwidth, hi: center + halfwidth, fill: TRACK_FILL }];
    if (useReference) list.push({ lo: rcenter - rhalf, hi: rcenter + rhalf, fill: REF_FILL });
    return list;
  }, [center, halfwidth, useReference, rcenter, rhalf]);

  const handleSelectWindow = (lo: number, hi: number) => {
    const c = Math.round(((lo + hi) / 2) * 10) / 10;
    const h = Math.max(Math.round(((hi - lo) / 2) * 10) / 10, 1);
    if (useReference && bandSets === "reference") {
      setRcenter(c);
      setRhalf(h);
    } else {
      setCenter(c);
      setHalfwidth(h);
    }
  };

  // --- Step 5: gated run ----------------------------------------------------
  const signalUnit = useReference ? "ratio" : measure;
  const signature = JSON.stringify({
    center, halfwidth, measure, winBaseline,
    useReference, rcenter, rhalf, rmeasure, rbaseline,
    method, bp1, bp2, timeUnit, times, n: ordered.length,
  });

  const [run, setRun] = useState<RunState | null>(null);
  const peakChartRef = useRef<IrChartHandle>(null);
  const convChartRef = useRef<IrChartHandle>(null);

  const runAnalysis = () => {
    const signal = absStack.map((row) =>
      measurePeak(grid, row, center, halfwidth, measure, winBaseline),
    );
    const refSignal = useReference
      ? absStack.map((row) => measurePeak(grid, row, rcenter, rhalf, rmeasure, rbaseline))
      : null;

    const result = analyze(times, signal, refSignal);
    const orders = fitOrders(times, signal, refSignal, timeUnit, signalUnit);

    // Re-derive the finite-pair mask analyze used, so raw/ref align to result.time.
    const divided = refSignal ? signal.map((s, i) => (refSignal[i] ? s / refSignal[i] : NaN)) : signal;
    const keep = times.map((t, i) => Number.isFinite(t) && Number.isFinite(divided[i]));
    const rawKept = signal.filter((_, i) => keep[i]);
    const refKept = refSignal ? refSignal.filter((_, i) => keep[i]) : undefined;

    setRun({
      result,
      orders,
      rawKept,
      refKept,
      signalUnit,
      peak: { center, halfwidth, measure, baseline: winBaseline },
      refPeak: useReference ? { center: rcenter, halfwidth: rhalf, measure: rmeasure, baseline: rbaseline } : undefined,
      useReference,
      signature,
    });
  };

  const stale = run !== null && run.signature !== signature;

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">Kinetics</h2>
        <p className="text-sm text-muted-foreground">
          Order the time series, track a disappearing peak, and fit a first-order rate constant.
        </p>
      </header>

      {/* Step 1 — time series */}
      <Section
        title="1 · Time series order & spacing"
        caption="Spectra are sorted naturally; set the spacing or edit individual times."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <NumField label="Time between spectra" value={interval} onChange={setInterval} min={0} step={0.1} />
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Time unit</Label>
            <Select value={timeUnit} onValueChange={(v) => setTimeUnit(v as TimeUnit)}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_UNITS.map((u) => (
                  <SelectItem key={u} value={u}>
                    {u}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <NumField label={`Start t₀ (${timeUnit})`} value={startT0} onChange={setStartT0} step={0.1} />
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">#</th>
                <th className="px-3 py-1.5 text-left font-medium">File</th>
                <th className="px-3 py-1.5 text-left font-medium">Time ({timeUnit})</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((s, i) => (
                <tr key={s.name} className="border-t border-border/40">
                  <td className="px-3 py-1 tabular-nums text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-1">
                    <span className="block max-w-[28rem] truncate" title={s.name}>
                      {s.name}
                    </span>
                  </td>
                  <td className="px-3 py-1">
                    <Input
                      type="number"
                      step={0.1}
                      value={Number.isFinite(times[i]) ? times[i] : ""}
                      onChange={(e) => setTimeAt(i, Number(e.target.value))}
                      className="h-7 w-28"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Step 2 — baseline */}
      <Section
        title="2 · Baseline correction"
        caption="Applied to every spectrum (in absorbance) before the peak is measured."
        defaultOpen={false}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as BaselineMethod)}>
              <SelectTrigger className="h-8">
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
          </div>
          {method === "Linear (2-point)" && (
            <div className="grid grid-cols-2 gap-2 self-end">
              <NumField label="Anchor 1 (cm⁻¹)" value={bp1} onChange={setBp1} />
              <NumField label="Anchor 2 (cm⁻¹)" value={bp2} onChange={setBp2} />
            </div>
          )}
        </div>
      </Section>

      {/* Step 3 — peak to track */}
      <Section title="3 · Peak to track" caption="Define the window and how its signal is quantified.">
        <div className="grid gap-4 sm:grid-cols-4">
          <NumField label="Peak center (cm⁻¹)" value={center} onChange={setCenter} step={0.1} />
          <NumField label="Half-width (cm⁻¹)" value={halfwidth} onChange={setHalfwidth} min={1} step={0.1} />
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Measure</Label>
            <Select value={measure} onValueChange={(v) => setMeasure(v as MeasureMode)}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="height">height</SelectItem>
                <SelectItem value="area">area</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Window baseline</Label>
            <Select value={winBaseline} onValueChange={(v) => setWinBaseline(v as WindowBaseline)}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="linear">linear</SelectItem>
                <SelectItem value="none">none</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={useReference}
            onChange={(e) => setUseReference(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Normalize to a reference (non-reacting) peak
        </label>

        {useReference && (
          <div className="mt-3 grid gap-4 rounded-lg border border-border/50 bg-background/40 p-3 sm:grid-cols-4">
            <NumField label="Ref center (cm⁻¹)" value={rcenter} onChange={setRcenter} step={0.1} />
            <NumField label="Ref half-width (cm⁻¹)" value={rhalf} onChange={setRhalf} min={1} step={0.1} />
            <div className="grid gap-1">
              <Label className="text-[11px] text-muted-foreground">Ref measure</Label>
              <Select value={rmeasure} onValueChange={(v) => setRmeasure(v as MeasureMode)}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="height">height</SelectItem>
                  <SelectItem value="area">area</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label className="text-[11px] text-muted-foreground">Ref baseline</Label>
              <Select value={rbaseline} onValueChange={(v) => setRbaseline(v as WindowBaseline)}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="linear">linear</SelectItem>
                  <SelectItem value="none">none</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </Section>

      {/* Step 4 — overlay with tracked window */}
      <Section title="4 · Overlay with tracked window" caption="The shaded band(s) mark the tracked (and reference) windows.">
        <div className="flex flex-wrap items-end gap-6">
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Display y-axis (overlay only)</Label>
            <RadioGroup
              value={dispYaxis}
              onValueChange={(v) => setDispYaxis(v as YAxis)}
              className="flex gap-4"
            >
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="%T" id="kx-pct" /> %T
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="Absorbance" id="kx-abs" /> Absorbance
              </label>
            </RadioGroup>
          </div>
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Drag on plot</Label>
            <RadioGroup
              value={setWindowMode ? "set" : "zoom"}
              onValueChange={(v) => setSetWindowMode(v === "set")}
              className="flex gap-4"
            >
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="zoom" id="kd-zoom" /> Zoom
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="set" id="kd-set" /> Set window
              </label>
            </RadioGroup>
          </div>
          {useReference && setWindowMode && (
            <div className="grid gap-1">
              <Label className="text-[11px] text-muted-foreground">Band sets</Label>
              <RadioGroup
                value={bandSets}
                onValueChange={(v) => setBandSets(v as "track" | "reference")}
                className="flex gap-4"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="track" id="kb-track" /> Track
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="reference" id="kb-ref" /> Reference
                </label>
              </RadioGroup>
            </div>
          )}
        </div>

        <div className="mt-4">
          <IrChart
            data={overlay.data}
            series={overlay.series}
            reversedX
            legend={ordered.length <= 20}
            yLabel={dispYaxis === "Absorbance" ? "Absorbance" : "Transmittance (%T)"}
            bands={bands}
            dragMode={setWindowMode ? "select" : "zoom"}
            onSelectWindow={handleSelectWindow}
            height={460}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Tracked window: {g(center - halfwidth)}–{g(center + halfwidth)} cm⁻¹
          {useReference && ` · reference: ${g(rcenter - rhalf)}–${g(rcenter + rhalf)} cm⁻¹`}.
          {setWindowMode ? " Drag on the plot to set the window." : " Drag to zoom; double-click resets."}
        </p>
      </Section>

      {/* Step 5 — run */}
      <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">5 · Measure &amp; analyze</h3>
            <p className="text-xs text-muted-foreground">
              Measures the tracked peak in all {ordered.length} spectra, then fits the decay.
            </p>
          </div>
          <Button onClick={runAnalysis}>
            <Play className="mr-1.5 h-4 w-4" />
            {run ? "Update analysis" : "Run analysis"}
          </Button>
        </div>
        {stale && (
          <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            Inputs changed since the last run — the results below are out of date. Click “Update
            analysis”.
          </p>
        )}
        {!run && (
          <p className="mt-3 text-xs text-muted-foreground">
            No analysis yet. Configure the steps above and run to see the fit and order comparison.
          </p>
        )}
      </div>

      {run && (
        <>
          <ResultPlots run={run} timeUnit={timeUnit} peakChartRef={peakChartRef} convChartRef={convChartRef} />
          <OrderComparison run={run} />
          <ExportBar run={run} timeUnit={timeUnit} peakChartRef={peakChartRef} convChartRef={convChartRef} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 6 — result plots & fit summary
// ---------------------------------------------------------------------------

/** A line-less, markers-only path builder for scatter series. */
const NO_PATH = (() => null) as unknown as Series["paths"];

/** uPlot dash array for a trendline style (solid = no dash). */
function uplotDash(style: TrendlineStyle): number[] | undefined {
  if (style === "dashed") return [6, 4];
  if (style === "dotted") return [2, 3];
  return undefined;
}

/**
 * Evaluate a fitted trendline across the chart's x. Non-finite predictions
 * become NaN gaps; the whole line is dropped (null) unless at least two finite
 * points remain, so a degenerate fit can never feed an all-NaN series into the
 * chart's autorange.
 */
function trendOverX(
  xs: number[],
  enabled: boolean,
  fit: TrendlineFit,
): number[] | null {
  if (!enabled || !fit.ok) return null;
  let finite = 0;
  const ys = xs.map((x) => {
    const v = fit.predict(x);
    if (Number.isFinite(v)) {
      finite += 1;
      return v;
    }
    return NaN;
  });
  return finite >= 2 ? ys : null;
}

/**
 * The conversion the data actually levels off at, as a percentage: the mean of
 * the last fifth of the finite conversion points. This tracks the visible
 * plateau, unlike the first-order model's extrapolated final conversion, which
 * reads ~100% whenever the fit drives S∞ toward zero.
 */
function observedPlateauPct(conversion: number[]): number {
  const cs = conversion.filter((c) => Number.isFinite(c));
  if (cs.length === 0) return NaN;
  const tail = cs.slice(Math.floor(cs.length * 0.8));
  const used = tail.length ? tail : cs;
  return (used.reduce((a, b) => a + b, 0) / used.length) * 100;
}

function ResultPlots({
  run,
  timeUnit,
  peakChartRef,
  convChartRef,
}: {
  run: RunState;
  timeUnit: TimeUnit;
  peakChartRef: React.Ref<IrChartHandle>;
  convChartRef: React.Ref<IrChartHandle>;
}) {
  const { result } = run;

  // Customizable lines of best fit (persist across "Update analysis").
  const [peakTrend, setPeakTrend] = useState<TrendlineConfig>(() => defaultTrendlineConfig());
  const [convTrend, setConvTrend] = useState<TrendlineConfig>(() => defaultTrendlineConfig());

  // Conversion as a percentage — the y the conversion plot (and its fit) uses.
  const convPct = useMemo(() => result.conversion.map((c) => c * 100), [result]);

  // Measured-point x-extent, shown as the fit-range placeholder.
  const timeExtent = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of result.time) {
      if (!Number.isFinite(t)) continue;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    return { lo: lo === Infinity ? 0 : lo, hi: hi === -Infinity ? 0 : hi };
  }, [result]);

  // The regressions themselves, fitted to the measured scatter points.
  const peakFit = useMemo(
    () => fitTrendline(result.time, result.signal, peakTrend),
    [result, peakTrend],
  );
  const convFit = useMemo(
    () => fitTrendline(result.time, convPct, convTrend),
    [result, convPct, convTrend],
  );

  // Shared x for each chart = union of the measured times and the dense fit grid.
  const peak = useMemo(() => {
    const tFit = result.tFit ?? [];
    const xs = Array.from(new Set([...result.time, ...tFit])).sort((a, b) => a - b);
    const sigAt = new Map(result.time.map((t, i) => [t, result.signal[i]]));
    const fitAt = new Map(tFit.map((t, i) => [t, (result.sFit ?? [])[i]]));
    const markers = xs.map((x) => (sigAt.has(x) ? (sigAt.get(x) as number) : NaN));
    const line = xs.map((x) => (fitAt.has(x) ? (fitAt.get(x) as number) : NaN));
    return { xs, markers, line };
  }, [result]);

  const conv = useMemo(() => {
    const tFit = result.tFit ?? [];
    const xs = Array.from(new Set([...result.time, ...tFit])).sort((a, b) => a - b);
    const convAt = new Map(result.time.map((t, i) => [t, result.conversion[i] * 100]));
    // First-order trend from the fitted S(t), normalized by the measured S0.
    const s0 = result.s0;
    const trendAt = new Map(tFit.map((t, i) => [t, s0 !== 0 ? ((s0 - (result.sFit ?? [])[i]) / s0) * 100 : NaN]));
    const markers = xs.map((x) => (convAt.has(x) ? (convAt.get(x) as number) : NaN));
    const trend = xs.map((x) => (trendAt.has(x) ? (trendAt.get(x) as number) : NaN));
    // "Final" line at the OBSERVED plateau (mean of the conversion tail), so it
    // sits where the data levels off rather than at the model's extrapolated S∞.
    const plateau = observedPlateauPct(result.conversion);
    const finalLine = xs.map(() => (Number.isFinite(plateau) ? plateau : NaN));
    return { xs, markers, trend, finalLine, plateau };
  }, [result]);

  // Trendline y evaluated over each chart's x (null when off / unfittable).
  const peakTrendY = useMemo(
    () => trendOverX(peak.xs, peakTrend.enabled, peakFit),
    [peak, peakTrend.enabled, peakFit],
  );
  const convTrendY = useMemo(
    () => trendOverX(conv.xs, convTrend.enabled, convFit),
    [conv, convTrend.enabled, convFit],
  );

  // Inline uPlot charts: measured scatter + model line + optional best-fit line.
  const peakChart = useMemo(() => {
    const data: number[][] = [peak.xs, peak.markers, peak.line];
    const series: Series[] = [
      { label: "measured", stroke: "#2563eb", points: { show: true, size: 7 }, paths: NO_PATH },
      { label: "fit", stroke: "#dc2626", width: 1.5, dash: [6, 4], points: { show: false } },
    ];
    if (peakTrendY) {
      data.push(peakTrendY);
      series.push({
        label: "best fit",
        stroke: peakTrend.color,
        width: peakTrend.width,
        dash: uplotDash(peakTrend.style),
        points: { show: false },
      });
    }
    return { data: data as [number[], ...number[][]], series };
  }, [peak, peakTrendY, peakTrend.color, peakTrend.width, peakTrend.style]);

  const convChart = useMemo(() => {
    const data: number[][] = [conv.xs, conv.markers, conv.trend, conv.finalLine];
    const series: Series[] = [
      { label: "conversion", stroke: "#16a34a", points: { show: true, size: 7 }, paths: NO_PATH },
      { label: "first-order", stroke: "#dc2626", width: 1.5, dash: [6, 4], points: { show: false } },
      { label: "final (data)", stroke: "#64748b", width: 1, dash: [2, 3], points: { show: false } },
    ];
    if (convTrendY) {
      data.push(convTrendY);
      series.push({
        label: "best fit",
        stroke: convTrend.color,
        width: convTrend.width,
        dash: uplotDash(convTrend.style),
        points: { show: false },
      });
    }
    return { data: data as [number[], ...number[][]], series };
  }, [conv, convTrendY, convTrend.color, convTrend.width, convTrend.style]);

  const peakYLabel = run.useReference
    ? "peak signal (ratio to ref)"
    : `peak signal (${run.signalUnit})`;

  // The same plots in the figure maker's neutral shape (scatter + fit lines),
  // with the optional best-fit line and its equation carried into exports.
  const peakFigure = useMemo<FigureData>(() => {
    const series: FigureSeriesData[] = [
      {
        id: "measured",
        label: "measured",
        y: peak.markers,
        styleHints: { color: "#2563eb", lineStyle: "none", markers: true },
      },
      { id: "fit", label: "fit", y: peak.line, styleHints: { color: "#dc2626", lineStyle: "dashed" } },
    ];
    const annotations: FigureAnnotation[] = [];
    if (peakTrendY) {
      series.push({
        id: "trend",
        label: "best fit",
        y: peakTrendY,
        styleHints: {
          color: peakTrend.color,
          lineStyle: peakTrend.style,
          lineWidth: peakTrend.width,
          markers: false,
        },
      });
      if (peakTrend.showEquation && peakFit.ok) {
        annotations.push({
          id: "trend-eq",
          text: `${peakFit.equation}   R² = ${peakFit.r2.toFixed(3)}`,
          x: 0.03,
          y: 0.08,
          color: peakTrend.color,
        });
      }
    }
    return {
      x: peak.xs,
      series,
      xLabel: `time (${timeUnit})`,
      yLabel: peakYLabel,
      sourceName: "peak_decay",
      annotations,
    };
  }, [peak, peakTrendY, peakTrend, peakFit, timeUnit, peakYLabel]);

  const convFigure = useMemo<FigureData>(() => {
    const series: FigureSeriesData[] = [
      {
        id: "conversion",
        label: "conversion",
        y: conv.markers,
        styleHints: { color: "#16a34a", lineStyle: "none", markers: true },
      },
      {
        id: "first-order",
        label: "first-order",
        y: conv.trend,
        styleHints: { color: "#dc2626", lineStyle: "dashed" },
      },
      {
        id: "final",
        label: "final (data)",
        y: conv.finalLine,
        styleHints: { color: "#64748b", lineStyle: "dotted", lineWidth: 1 },
      },
    ];
    const annotations: FigureAnnotation[] = [];
    if (convTrendY) {
      series.push({
        id: "trend",
        label: "best fit",
        y: convTrendY,
        styleHints: {
          color: convTrend.color,
          lineStyle: convTrend.style,
          lineWidth: convTrend.width,
          markers: false,
        },
      });
      if (convTrend.showEquation && convFit.ok) {
        annotations.push({
          id: "trend-eq",
          text: `${convFit.equation}   R² = ${convFit.r2.toFixed(3)}`,
          x: 0.03,
          y: 0.08,
          color: convTrend.color,
        });
      }
    }
    return {
      x: conv.xs,
      series,
      xLabel: `time (${timeUnit})`,
      yLabel: "conversion (%)",
      sourceName: "conversion",
      annotations,
    };
  }, [conv, convTrendY, convTrend, convFit, timeUnit]);

  return (
    <Section title="6 · Result plots & fit summary">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border/50 p-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-foreground">Peak disappearance</p>
            <FigurePopout data={peakFigure} />
          </div>
          <IrChart
            ref={peakChartRef}
            data={peakChart.data}
            series={peakChart.series}
            xLabel={`time (${timeUnit})`}
            yLabel={peakYLabel}
            legend
            height={300}
          />
          <TrendlineControls
            config={peakTrend}
            onChange={setPeakTrend}
            fit={peakFit}
            dataMin={timeExtent.lo}
            dataMax={timeExtent.hi}
            unit={timeUnit}
          />
        </div>
        <div className="rounded-xl border border-border/50 p-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-foreground">Conversion</p>
            <FigurePopout data={convFigure} />
          </div>
          <IrChart
            ref={convChartRef}
            data={convChart.data}
            series={convChart.series}
            xLabel={`time (${timeUnit})`}
            yLabel="conversion (%)"
            legend
            height={300}
          />
          <TrendlineControls
            config={convTrend}
            onChange={setConvTrend}
            fit={convFit}
            dataMin={timeExtent.lo}
            dataMax={timeExtent.hi}
            unit={timeUnit}
          />
        </div>
      </div>

      {result.fitOk ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Metric label="Rate k" value={`${g(result.k)} /${timeUnit}`} />
          <Metric label="Half-life" value={`${g(result.halfLife)} ${timeUnit}`} />
          <Metric
            label="Final conversion"
            value={Number.isFinite(conv.plateau) ? `${conv.plateau.toFixed(1)}%` : "—"}
            help={`Observed plateau (mean of the final points). First-order model extrapolates to ${(result.finalConversion * 100).toFixed(1)}%.`}
          />
          <Metric label="R²" value={result.r2.toFixed(4)} />
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          First-order fit did not converge. Final conversion (observed plateau) ={" "}
          {Number.isFinite(conv.plateau) ? `${conv.plateau.toFixed(1)}%` : "—"}.
        </div>
      )}
    </Section>
  );
}

function Metric({ label, value, help }: { label: string; value: string; help?: string }) {
  return (
    <div className="rounded-xl border border-border/50 bg-background/40 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</p>
      {help && <p className="mt-0.5 text-[10px] text-muted-foreground">{help}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 7 — reaction order comparison
// ---------------------------------------------------------------------------

function OrderComparison({ run }: { run: RunState }) {
  const { orders, signalUnit } = run;
  const okOrders = orders.filter((o) => o.ok);
  const best = okOrders.reduce<OrderFit | null>(
    (acc, o) => (acc === null || (Number.isFinite(o.r2) && o.r2 > acc.r2) ? o : acc),
    null,
  );
  const [selectedOrder, setSelectedOrder] = useState<number | null>(null);
  const chosen = orders.find((o) => o.order === selectedOrder) ?? best;

  const signalName = signalUnit === "ratio" ? "ratio to reference" : signalUnit;

  const plot = useMemo(() => {
    if (!chosen || !chosen.ok) return null;
    const data = [chosen.t, chosen.y, chosen.yFit] as [number[], ...number[][]];
    const series: Series[] = [
      { label: chosen.transform, stroke: "#2563eb", points: { show: true, size: 7 }, paths: NO_PATH },
      { label: "linear fit", stroke: "#dc2626", width: 1.5, points: { show: false } },
    ];
    return { data, series };
  }, [chosen]);

  // Figure-maker shape for the selected order. The ids carry the order number,
  // so switching orders re-seeds the two series instead of keeping stale styles.
  const orderFigure = useMemo<FigureData | null>(() => {
    if (!chosen || !chosen.ok) return null;
    return {
      x: chosen.t,
      series: [
        {
          id: `data-${chosen.order}`,
          label: chosen.transform,
          y: chosen.y,
          styleHints: { color: "#2563eb", lineStyle: "none", markers: true },
        },
        {
          id: `fit-${chosen.order}`,
          label: "linear fit",
          y: chosen.yFit,
          styleHints: { color: "#dc2626" },
        },
      ],
      xLabel: "time",
      yLabel: chosen.transform,
      sourceName: `order_${chosen.order}`,
    };
  }, [chosen]);

  return (
    <Section title="7 · Reaction order — fit & compare (0/1/2)" caption={`Signal S measured as ${signalName}.`}>
      {okOrders.length === 0 ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Fewer than 3 valid points for every order — cannot compare.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <div className="overflow-x-auto rounded-lg border border-border/60">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Order</th>
                    <th className="px-3 py-1.5 text-left font-medium">Linearized</th>
                    <th className="px-3 py-1.5 text-right font-medium">R²</th>
                    <th className="px-3 py-1.5 text-right font-medium">Rate k</th>
                    <th className="px-3 py-1.5 text-left font-medium">k units</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr
                      key={o.order}
                      className={`border-t border-border/40 ${best && o.order === best.order ? "bg-primary/5" : ""}`}
                    >
                      <td className="px-3 py-1 tabular-nums">{o.order}</td>
                      <td className="px-3 py-1">{o.label}</td>
                      <td className="px-3 py-1 text-right tabular-nums">
                        {Number.isFinite(o.r2) ? o.r2.toFixed(4) : "—"}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">{o.ok ? g(o.k) : "—"}</td>
                      <td className="px-3 py-1">{o.ok ? o.kUnits : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {best && (
              <p className="mt-2 text-xs text-muted-foreground">
                Best fit: <span className="font-medium text-foreground">order {best.order}</span> ({best.label},
                R² = {best.r2.toFixed(4)}).
              </p>
            )}
          </div>

          <div className="rounded-xl border border-border/50 p-3">
            <div className="mb-2 grid gap-1">
              <Label className="text-[11px] text-muted-foreground">Show linearized plot for</Label>
              <Select
                value={String(chosen?.order ?? "")}
                onValueChange={(v) => setSelectedOrder(Number(v))}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {orders.map((o) => (
                    <SelectItem key={o.order} value={String(o.order)} disabled={!o.ok}>
                      Order {o.order} — {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {plot ? (
              <>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground">
                    {chosen?.label} · R² = {chosen?.r2.toFixed(4)}
                  </p>
                  {orderFigure && <FigurePopout data={orderFigure} />}
                </div>
                <IrChart
                  data={plot.data}
                  series={plot.series}
                  xLabel="time"
                  yLabel={chosen?.transform}
                  legend={false}
                  height={260}
                />
              </>
            ) : (
              <p className="py-12 text-center text-xs text-muted-foreground">
                This order has too few valid points to plot.
              </p>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Step 9 — export bar (CSV / PDF / Excel)
// ---------------------------------------------------------------------------

function ExportBar({
  run,
  timeUnit,
  peakChartRef,
  convChartRef,
}: {
  run: RunState;
  timeUnit: TimeUnit;
  peakChartRef: React.RefObject<IrChartHandle>;
  convChartRef: React.RefObject<IrChartHandle>;
}) {
  const [busy, setBusy] = useState(false);

  const buildReport = (): KineticsReport => ({
    timeUnit,
    signalUnit: run.useReference ? "ratio to ref" : run.signalUnit,
    time: run.result.time,
    signal: run.result.signal,
    conversion: run.result.conversion,
    raw: run.useReference ? run.rawKept : undefined,
    ref: run.useReference ? run.refKept : undefined,
    peak: run.peak,
    refPeak: run.refPeak,
    useReference: run.useReference,
    result: run.result,
    orders: run.orders,
    spectraCount: run.result.time.length,
    peakPlotPng: peakChartRef.current?.getPng() ?? null,
    conversionPlotPng: convChartRef.current?.getPng() ?? null,
  });

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Export</h3>
          <p className="text-xs text-muted-foreground">
            Data table, fit summary, and both plots — CSV, PDF, or Excel.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadKineticsCsv(buildReport())}>
            <Download className="mr-1.5 h-4 w-4" />
            CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadKineticsPdf(buildReport(), run.signature)}
          >
            <FileText className="mr-1.5 h-4 w-4" />
            PDF
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await downloadKineticsExcel(buildReport(), run.signature);
              } finally {
                setBusy(false);
              }
            }}
          >
            <FileSpreadsheet className="mr-1.5 h-4 w-4" />
            Excel
          </Button>
        </div>
      </div>
    </div>
  );
}
