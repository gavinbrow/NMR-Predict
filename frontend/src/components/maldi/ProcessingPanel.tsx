import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import type { ProcessingKind, ProcessingStep } from "@/lib/maldi/types";

interface ProcessingPanelProps {
  steps: ProcessingStep[];
  onChange: (steps: ProcessingStep[]) => void;
  /** Full m/z extent of the raw spectrum, for sensible crop defaults. */
  spectrumRange?: { min: number; max: number } | null;
}

const KIND_LABELS: Record<ProcessingKind, string> = {
  baseline: "Baseline",
  smooth: "Smoothing",
  normalize: "Normalization",
  crop: "Crop",
  calibrate: "Calibration",
};

const KIND_ORDER: ProcessingKind[] = ["baseline", "smooth", "normalize", "crop", "calibrate"];

let stepCounter = 0;
function newStepId(): string {
  stepCounter += 1;
  return `step-${Date.now()}-${stepCounter}`;
}

function defaultParams(
  kind: ProcessingKind,
  range?: { min: number; max: number } | null,
): ProcessingStep["params"] {
  switch (kind) {
    case "baseline":
      return { method: "snip", iterations: 40, windowPoints: 50, lambda: 100000, p: 0.01 };
    case "smooth":
      return { method: "savitzkyGolay", windowSize: 9, polynomial: 3, sigma: 2 };
    case "normalize":
      return { method: "basePeak", target: 100 };
    case "crop":
      return { min: range?.min ?? 0, max: range?.max ?? 100000 };
    case "calibrate":
      return { pointsJson: "[]", degree: 1 };
  }
}

export function ProcessingPanel({ steps, onChange, spectrumRange }: ProcessingPanelProps) {
  const addStep = (kind: ProcessingKind) => {
    onChange([
      ...steps,
      { id: newStepId(), kind, enabled: true, params: defaultParams(kind, spectrumRange) },
    ]);
  };

  const updateStep = (id: string, patch: Partial<ProcessingStep>) => {
    onChange(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const updateParams = (id: string, params: ProcessingStep["params"]) => {
    onChange(steps.map((s) => (s.id === id ? { ...s, params } : s)));
  };

  const removeStep = (id: string) => onChange(steps.filter((s) => s.id !== id));

  const move = (index: number, dir: -1 | 1) => {
    const next = [...steps];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {KIND_ORDER.map((kind) => (
          <Button key={kind} size="sm" variant="outline" className="h-7" onClick={() => addStep(kind)}>
            <Plus className="mr-1 h-3 w-3" />
            {KIND_LABELS[kind]}
          </Button>
        ))}
      </div>

      {steps.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No processing steps. The raw spectrum is shown as imported. Add steps above; they run in
          order and never alter the raw data.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <li key={step.id} className="rounded-lg border border-border/60 bg-background/60 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-foreground">
                  {index + 1}. {KIND_LABELS[step.kind]}
                </span>
                <div className="flex items-center gap-1">
                  <Switch
                    checked={step.enabled}
                    onCheckedChange={(enabled) => updateStep(step.id, { enabled })}
                  />
                  <button
                    type="button"
                    aria-label="Move up"
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    disabled={index === steps.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Remove step"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => removeStep(step.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="mt-2">
                <StepParams step={step} onChange={(params) => updateParams(step.id, params)} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function num(params: ProcessingStep["params"], key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" ? v : fallback;
}
function str(params: ProcessingStep["params"], key: string, fallback: string): string {
  const v = params[key];
  return typeof v === "string" ? v : fallback;
}

function NumField({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="grid gap-1">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        className="h-7 text-xs"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function MethodSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-7 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Per-kind parameter editor; keeps every active assumption visible and editable. */
function StepParams({
  step,
  onChange,
}: {
  step: ProcessingStep;
  onChange: (params: ProcessingStep["params"]) => void;
}) {
  const p = step.params;
  const set = (patch: ProcessingStep["params"]) => onChange({ ...p, ...patch });

  if (step.kind === "baseline") {
    const method = str(p, "method", "snip");
    return (
      <div className="grid grid-cols-2 gap-1.5">
        <div className="col-span-2">
          <MethodSelect
            value={method}
            onChange={(method) => set({ method })}
            options={[
              { value: "snip", label: "SNIP" },
              { value: "rollingBall", label: "Rolling ball / top-hat" },
              { value: "als", label: "Asymmetric least squares" },
            ]}
          />
        </div>
        {method === "snip" && (
          <NumField label="Iterations" value={num(p, "iterations", 40)} onChange={(v) => set({ iterations: v })} />
        )}
        {method === "rollingBall" && (
          <NumField label="Window (pts)" value={num(p, "windowPoints", 50)} onChange={(v) => set({ windowPoints: v })} />
        )}
        {method === "als" && (
          <>
            <NumField label="λ (smooth)" value={num(p, "lambda", 100000)} onChange={(v) => set({ lambda: v })} />
            <NumField label="p (asym)" step={0.005} value={num(p, "p", 0.01)} onChange={(v) => set({ p: v })} />
          </>
        )}
      </div>
    );
  }

  if (step.kind === "smooth") {
    const method = str(p, "method", "savitzkyGolay");
    return (
      <div className="grid grid-cols-2 gap-1.5">
        <div className="col-span-2">
          <MethodSelect
            value={method}
            onChange={(method) => set({ method })}
            options={[
              { value: "savitzkyGolay", label: "Savitzky–Golay" },
              { value: "gaussian", label: "Gaussian" },
              { value: "movingAverage", label: "Moving average" },
            ]}
          />
        </div>
        {method === "savitzkyGolay" && (
          <>
            <NumField label="Window (pts)" value={num(p, "windowSize", 9)} onChange={(v) => set({ windowSize: v })} />
            <NumField label="Poly order" value={num(p, "polynomial", 3)} onChange={(v) => set({ polynomial: v })} />
          </>
        )}
        {method === "gaussian" && (
          <NumField label="σ (pts)" value={num(p, "sigma", 2)} onChange={(v) => set({ sigma: v })} />
        )}
        {method === "movingAverage" && (
          <NumField label="Window (pts)" value={num(p, "windowSize", 5)} onChange={(v) => set({ windowSize: v })} />
        )}
      </div>
    );
  }

  if (step.kind === "normalize") {
    const method = str(p, "method", "basePeak");
    return (
      <div className="grid grid-cols-2 gap-1.5">
        <div className="col-span-2">
          <MethodSelect
            value={method}
            onChange={(method) => set({ method })}
            options={[
              { value: "basePeak", label: "Base peak (%)" },
              { value: "tic", label: "Total ion current" },
              { value: "max", label: "Max intensity" },
            ]}
          />
        </div>
        <NumField label="Target" value={num(p, "target", method === "basePeak" ? 100 : 1)} onChange={(v) => set({ target: v })} />
      </div>
    );
  }

  if (step.kind === "crop") {
    return (
      <div className="grid grid-cols-2 gap-1.5">
        <NumField label="Min m/z" value={num(p, "min", 0)} onChange={(v) => set({ min: v })} />
        <NumField label="Max m/z" value={num(p, "max", 100000)} onChange={(v) => set({ max: v })} />
      </div>
    );
  }

  // calibrate
  return <CalibrationEditor params={p} onChange={onChange} />;
}

interface CalibPoint {
  measured: number;
  reference: number;
}

function CalibrationEditor({
  params,
  onChange,
}: {
  params: ProcessingStep["params"];
  onChange: (params: ProcessingStep["params"]) => void;
}) {
  let points: CalibPoint[] = [];
  try {
    points = JSON.parse(str(params, "pointsJson", "[]")) as CalibPoint[];
    if (!Array.isArray(points)) points = [];
  } catch {
    points = [];
  }
  const degree = num(params, "degree", 1);

  const setPoints = (next: CalibPoint[]) =>
    onChange({ ...params, pointsJson: JSON.stringify(next) });

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] text-muted-foreground">
        Calibrant pairs: observed m/z → known reference m/z.
      </p>
      {points.map((pt, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            type="number"
            className="h-7 text-xs"
            placeholder="observed"
            value={Number.isFinite(pt.measured) ? pt.measured : ""}
            onChange={(e) => {
              const next = [...points];
              next[i] = { ...pt, measured: Number(e.target.value) };
              setPoints(next);
            }}
          />
          <span className="text-muted-foreground">→</span>
          <Input
            type="number"
            className="h-7 text-xs"
            placeholder="reference"
            value={Number.isFinite(pt.reference) ? pt.reference : ""}
            onChange={(e) => {
              const next = [...points];
              next[i] = { ...pt, reference: Number(e.target.value) };
              setPoints(next);
            }}
          />
          <button
            type="button"
            aria-label="Remove calibrant"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setPoints(points.filter((_, j) => j !== i))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => setPoints([...points, { measured: NaN, reference: NaN }])}
        >
          <Plus className="mr-1 h-3 w-3" />
          Calibrant
        </Button>
        <div className="ml-auto w-24">
          <NumField label="Degree" value={degree} onChange={(v) => onChange({ ...params, degree: v })} />
        </div>
      </div>
    </div>
  );
}
