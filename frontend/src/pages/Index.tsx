import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Ketcher } from "ketcher-core";
import { Atom, FlaskConical, Loader2, Play, Plus, Sparkles, WifiOff } from "lucide-react";
import { BootSplash } from "@/components/nmr/BootSplash";
import { ControlPanel } from "@/components/nmr/ControlPanel";
import { MoleculeEditor } from "@/components/nmr/MoleculeEditor";
import { SpectrumPlot } from "@/components/nmr/SpectrumPlot";
import { useDebounced } from "@/hooks/use-debounced";
import {
  getEngines,
  getHealth,
  getOptions,
  isRequestCanceled,
  predict,
  validateSmiles,
} from "@/lib/nmr/api";
import { deriveSignals } from "@/lib/nmr/signals";
import { cn } from "@/lib/utils";
import type {
  Engine,
  Mode,
  OptionsResponse,
  PredictResponse,
  ValidateResponse,
} from "@/types/nmr";

interface PredictionComponent {
  id: string;
  label: string;
  response: PredictResponse;
}

function decoratePredictionResponse(
  response: PredictResponse,
  componentId: string,
  componentLabel: string,
): PredictResponse {
  return {
    ...response,
    shifts: response.shifts.map((shift) => ({
      ...shift,
      source_id: componentId,
      source_label: componentLabel,
      source_smiles: response.smiles,
    })),
  };
}

function truncateSmiles(smiles: string, limit = 28) {
  if (smiles.length <= limit) return smiles;
  return `${smiles.slice(0, limit - 1)}...`;
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const Index = () => {
  const [bootMessage, setBootMessage] = useState("Connecting to prediction service...");
  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [mocked, setMocked] = useState(false);

  const [options, setOptions] = useState<OptionsResponse | null>(null);
  const [engines, setEngines] = useState<Engine[]>([]);

  const [smiles, setSmiles] = useState("");
  const [nucleus, setNucleus] = useState("13C");
  const [mode, setMode] = useState<Mode>("consensus");
  const [conformerStrategy, setConformerStrategy] = useState("fast");
  const [selectedEngines, setSelectedEngines] = useState<string[]>([]);
  const [weights, setWeights] = useState<Record<string, number>>({});

  const [validation, setValidation] = useState<ValidateResponse | null>(null);
  const [validating, setValidating] = useState(false);
  const [predicting, setPredicting] = useState(false);
  const [predictElapsedMs, setPredictElapsedMs] = useState(0);
  const [predictStatus, setPredictStatus] = useState<string | null>(null);
  const [predictError, setPredictError] = useState<string | null>(null);
  const [predictionComponents, setPredictionComponents] = useState<PredictionComponent[]>([]);
  const [activeComponentId, setActiveComponentId] = useState<string | null>(null);
  const [editorLinkedComponentId, setEditorLinkedComponentId] = useState<string | null>(null);
  const [selectedAtomIndex, setSelectedAtomIndex] = useState<number | null>(null);
  const [hoveredAtomIndices, setHoveredAtomIndices] = useState<number[] | null>(null);

  const ketcherRef = useRef<Ketcher | null>(null);
  const predictAbortRef = useRef<AbortController | null>(null);

  const activeComponent = useMemo(
    () =>
      predictionComponents.find((component) => component.id === activeComponentId) ??
      predictionComponents[predictionComponents.length - 1] ??
      null,
    [activeComponentId, predictionComponents],
  );

  const result = useMemo<PredictResponse | null>(() => {
    if (predictionComponents.length === 0) return null;

    const lead = activeComponent?.response ?? predictionComponents[0].response;
    const warnings = predictionComponents.flatMap((component) =>
      (component.response.warnings ?? []).map((warning) =>
        predictionComponents.length > 1 ? `${component.label}: ${warning}` : warning,
      ),
    );

    return {
      smiles: lead.smiles,
      nucleus: lead.nucleus,
      mode: lead.mode,
      shifts: predictionComponents.flatMap((component) => component.response.shifts),
      engines_used: [
        ...new Set(
          predictionComponents.flatMap((component) => component.response.engines_used),
        ),
      ],
      warnings,
    };
  }, [activeComponent, predictionComponents]);

  const linkingEnabled =
    activeComponent != null &&
    editorLinkedComponentId != null &&
    editorLinkedComponentId === activeComponent.id;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setBootMessage("Checking backend health...");
        const health = await getHealth();
        if (cancelled) return;
        if (health.data.status !== "ok") {
          setBootError("Backend health check failed");
          return;
        }

        setBootMessage("Loading prediction options...");
        const [opts, eng] = await Promise.all([getOptions(), getEngines()]);
        if (cancelled) return;

        setOptions(opts.data);
        setEngines(eng.data);
        setMocked(health.mocked || opts.mocked || eng.mocked);

        const firstNucleus =
          opts.data.nuclei.includes("13C") ? "13C" : opts.data.nuclei[0] ?? "13C";
        const firstMode =
          opts.data.modes.includes("consensus")
            ? "consensus"
            : (opts.data.modes[0] as Mode) ?? "consensus";
        const firstStrategy =
          opts.data.conformer_strategies.includes("fast")
            ? "fast"
            : opts.data.conformer_strategies[0] ?? "fast";

        setNucleus(firstNucleus);
        setMode(firstMode);
        setConformerStrategy(firstStrategy);

        const ready = eng.data.filter((engine) => engine.ready);
        const initiallySelected = ready.slice(0, 2).map((engine) => engine.name);
        setSelectedEngines(initiallySelected);

        const defaultWeights: Record<string, number> = {};
        ready.forEach((engine) => {
          defaultWeights[engine.name] = engine.default_weight ?? 0;
        });
        setWeights(defaultWeights);
        setBooted(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        setBootError(`Failed to initialize: ${message}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const debouncedSmiles = useDebounced(smiles, 350);
  useEffect(() => {
    if (!booted) return;
    if (!debouncedSmiles.trim()) {
      setValidation(null);
      return;
    }

    const controller = new AbortController();
    setValidating(true);

    validateSmiles(debouncedSmiles, { signal: controller.signal })
      .then((response) => {
        setValidation(response.data);
      })
      .catch((error) => {
        if (isRequestCanceled(error)) {
          return;
        }
        setValidation({ valid: false, error: "Validation request failed" });
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setValidating(false);
        }
      });

    return () => controller.abort();
  }, [booted, debouncedSmiles]);

  useEffect(() => {
    if (!predicting) {
      setPredictElapsedMs(0);
      return;
    }

    const startedAt = Date.now();
    setPredictElapsedMs(0);
    const interval = window.setInterval(() => {
      setPredictElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [predicting]);

  useEffect(
    () => () => {
      predictAbortRef.current?.abort();
    },
    [],
  );

  const handleSmilesChange = useCallback(
    (nextSmiles: string) => {
      setSmiles(nextSmiles);

      if (!editorLinkedComponentId) return;
      const linkedComponent = predictionComponents.find(
        (component) => component.id === editorLinkedComponentId,
      );
      if (!linkedComponent) return;
      if (nextSmiles.trim() === linkedComponent.response.smiles.trim()) return;

      setEditorLinkedComponentId(null);
      setSelectedAtomIndex(null);
      setHoveredAtomIndices(null);
    },
    [editorLinkedComponentId, predictionComponents],
  );

  const activateComponent = useCallback((component: PredictionComponent) => {
    setActiveComponentId(component.id);
    setEditorLinkedComponentId(component.id);
    setSmiles(component.response.smiles);
    setValidation({ valid: true, canonical_smiles: component.response.smiles });
    setSelectedAtomIndex(null);
    setHoveredAtomIndices(null);
  }, []);

  useEffect(() => {
    const ketcher = ketcherRef.current;
    if (!ketcher) return;

    const atomIndices = linkingEnabled
      ? hoveredAtomIndices ?? (selectedAtomIndex != null ? [selectedAtomIndex] : null)
      : null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const editor: any = (ketcher as any).editor;
      if (!atomIndices || atomIndices.length === 0) {
        editor?.selection?.(null);
        return;
      }
      editor?.selection?.({ atoms: atomIndices });
    } catch {
      /* noop */
    }
  }, [hoveredAtomIndices, linkingEnabled, selectedAtomIndex]);

  const toggleEngine = useCallback((name: string) => {
    setSelectedEngines((current) =>
      current.includes(name) ? current.filter((engine) => engine !== name) : [...current, name],
    );
  }, []);

  const onWeightChange = useCallback((name: string, value: number) => {
    setWeights((current) => ({ ...current, [name]: value }));
  }, []);

  const cancelPrediction = useCallback(() => {
    predictAbortRef.current?.abort();
  }, []);

  const canPredict = booted && !!validation?.valid && selectedEngines.length > 0 && !predicting;
  const canAddPrediction =
    canPredict &&
    predictionComponents.length > 0 &&
    predictionComponents[0].response.nucleus === nucleus &&
    predictionComponents[0].response.mode === mode;

  const addPredictionHint = useMemo(() => {
    if (predictionComponents.length === 0) {
      return "Run Replace and predict first to start the plotted mix.";
    }

    const currentMix = predictionComponents[0].response;
    if (currentMix.nucleus !== nucleus || currentMix.mode !== mode) {
      return `Add prediction requires the same nucleus (${currentMix.nucleus}) and mode (${currentMix.mode}) as the current mix.`;
    }

    return "Add prediction appends the current Ketcher structure to the plotted mixed spectrum.";
  }, [mode, nucleus, predictionComponents]);

  const runPrediction = useCallback(
    async (behavior: "replace" | "add") => {
      if (!validation?.valid) return;
      if (behavior === "replace" && !canPredict) return;
      if (behavior === "add" && !canAddPrediction) return;

      const controller = new AbortController();
      predictAbortRef.current?.abort();
      predictAbortRef.current = controller;
      setPredicting(true);
      setPredictElapsedMs(0);
      setPredictError(null);

      try {
        const payload = {
          smiles: validation.canonical_smiles ?? smiles,
          engines: selectedEngines,
          mode,
          nucleus,
          conformer_strategy: conformerStrategy,
          ...(mode === "consensus"
            ? {
                weights: Object.fromEntries(
                  selectedEngines.map((name) => [name, weights[name] ?? 0]),
                ),
              }
            : {}),
        };
        const usesOrca = payload.engines.includes("orca");
        setPredictStatus(
          usesOrca
            ? "ORCA calculation in progress. Larger molecules can take a while."
            : "Prediction request in progress.",
        );

        const response = await predict(payload, { signal: controller.signal });
        const componentId = crypto.randomUUID();
        const componentLabel =
          behavior === "replace"
            ? "Component 1"
            : `Component ${predictionComponents.length + 1}`;
        const decoratedResponse = decoratePredictionResponse(
          response.data,
          componentId,
          componentLabel,
        );
        const nextComponent: PredictionComponent = {
          id: componentId,
          label: componentLabel,
          response: decoratedResponse,
        };

        setPredictionComponents((current) =>
          behavior === "replace" ? [nextComponent] : [...current, nextComponent],
        );
        setActiveComponentId(componentId);
        setEditorLinkedComponentId(componentId);
        setSmiles(decoratedResponse.smiles);
        setValidation({ valid: true, canonical_smiles: decoratedResponse.smiles });
        setSelectedAtomIndex(null);
        setHoveredAtomIndices(null);
      } catch (error) {
        if (isRequestCanceled(error)) {
          setPredictError("Prediction canceled.");
          return;
        }
        const message = error instanceof Error ? error.message : "Prediction failed";
        setPredictError(message);
      } finally {
        if (predictAbortRef.current === controller) {
          predictAbortRef.current = null;
        }
        setPredictStatus(null);
        setPredicting(false);
      }
    },
    [
      canAddPrediction,
      canPredict,
      conformerStrategy,
      mode,
      nucleus,
      predictionComponents.length,
      selectedEngines,
      smiles,
      validation,
      weights,
    ],
  );

  const readyEngineCount = useMemo(
    () => engines.filter((engine) => engine.ready).length,
    [engines],
  );

  const resultSignalCount = useMemo(() => {
    if (!result) return 0;
    return deriveSignals(result.shifts, result.nucleus, result.mode).length;
  }, [result]);

  const activeComponentSummary = useMemo(() => {
    if (!activeComponent) return null;
    return `${activeComponent.label} - ${truncateSmiles(activeComponent.response.smiles)}`;
  }, [activeComponent]);

  if (!booted || !options) {
    return <BootSplash message={bootMessage} error={bootError} />;
  }

  return (
    <div className="min-h-screen bg-gradient-surface">
      <header className="border-b border-border/60 bg-background/70 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-primary shadow-elegant">
              <Atom className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">NMR Predict</h1>
              <p className="text-xs text-muted-foreground">
                Interactive multi-engine chemical shift prediction
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs">
            {mocked ? (
              <span className="flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 font-medium text-warning">
                <WifiOff className="h-3 w-3" /> Offline (mock data)
              </span>
            ) : null}
            <span className="hidden items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 font-medium text-success sm:flex">
              <Sparkles className="h-3 w-3" /> {readyEngineCount} engines ready
            </span>
          </div>
        </div>
      </header>

      <main className="container py-6">
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <section className="space-y-6 lg:col-span-8">
              <div className="overflow-hidden rounded-xl border bg-card shadow-card">
                <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2.5">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <FlaskConical className="h-4 w-4 text-primary" /> Molecule editor
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {validating ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    <span className="font-mono">
                      {smiles ? smiles.slice(0, 48) : "Draw a structure to begin"}
                    </span>
                  </div>
                </div>

                <div
                  className={cn(
                    "h-[420px] transition-smooth",
                    validation && !validation.valid && "ring-2 ring-inset ring-destructive/60",
                  )}
                >
                  <MoleculeEditor
                    value={smiles}
                    onReady={(ketcher) => {
                      ketcherRef.current = ketcher;
                    }}
                    onSmilesChange={handleSmilesChange}
                    onAtomClick={(atomIndex) => {
                      if (!linkingEnabled) {
                        setSelectedAtomIndex(null);
                        return;
                      }
                      setSelectedAtomIndex(atomIndex);
                    }}
                  />
                </div>

                {validation && !validation.valid ? (
                  <div className="border-t bg-destructive/5 px-4 py-2 text-xs text-destructive">
                    {validation.error ?? "Invalid SMILES"}
                  </div>
                ) : null}
                {validation?.valid && validation.canonical_smiles ? (
                  <div className="border-t bg-success/5 px-4 py-2 font-mono text-xs text-success">
                    canonical: {validation.canonical_smiles}
                  </div>
                ) : null}
              </div>
            </section>

            <aside className="space-y-6 lg:col-span-4">
              <div className="rounded-xl border bg-card p-5 shadow-card">
                <h2 className="mb-4 text-sm font-semibold tracking-tight">Configuration</h2>
                <ControlPanel
                  options={options}
                  engines={engines}
                  nucleus={nucleus}
                  mode={mode}
                  conformerStrategy={conformerStrategy}
                  selectedEngines={selectedEngines}
                  weights={weights}
                  onNucleusChange={setNucleus}
                  onModeChange={setMode}
                  onConformerChange={setConformerStrategy}
                  onToggleEngine={toggleEngine}
                  onWeightChange={onWeightChange}
                />
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => void runPrediction("replace")}
                  disabled={!canPredict}
                  className={cn(
                    "group flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-primary-foreground shadow-elegant transition-smooth",
                    "bg-gradient-primary hover:shadow-glow active:scale-[0.99]",
                    "disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none",
                  )}
                >
                  {predicting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  {predicting ? "Predicting..." : "Replace and predict"}
                </button>

                {predicting ? (
                  <button
                    type="button"
                    onClick={cancelPrediction}
                    className={cn(
                      "flex w-full items-center justify-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm font-semibold text-destructive transition-smooth",
                      "hover:bg-destructive/10 active:scale-[0.99]",
                    )}
                  >
                    Cancel current prediction
                  </button>
                ) : null}

                <button
                  type="button"
                  onClick={() => void runPrediction("add")}
                  disabled={!canAddPrediction}
                  className={cn(
                    "flex w-full items-center justify-center gap-2 rounded-xl border border-border/70 bg-card px-4 py-3 text-sm font-semibold text-foreground shadow-card transition-smooth",
                    "hover:border-primary/50 hover:bg-primary/5 active:scale-[0.99]",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  <Plus className="h-4 w-4" />
                  Add prediction
                </button>

                {!validation?.valid && smiles ? (
                  <p className="text-center text-xs text-muted-foreground">
                    Fix the SMILES error to enable prediction.
                  </p>
                ) : null}
                {validation?.valid && selectedEngines.length === 0 ? (
                  <p className="text-center text-xs text-muted-foreground">
                    Select at least one ready engine.
                  </p>
                ) : null}
                <p className="text-center text-xs text-muted-foreground">{addPredictionHint}</p>
                {predicting && predictStatus ? (
                  <p className="rounded-md bg-primary/5 px-3 py-2 text-xs text-primary">
                    {predictStatus} Elapsed: {formatElapsed(predictElapsedMs)}.
                  </p>
                ) : null}
                {predictError ? (
                  <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {predictError}
                  </p>
                ) : null}
              </div>

              <div className="rounded-xl border bg-card p-4 shadow-card">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold tracking-tight">Prediction mix</h3>
                  <span className="text-xs text-muted-foreground">
                    {predictionComponents.length} component
                    {predictionComponents.length === 1 ? "" : "s"}
                  </span>
                </div>

                {predictionComponents.length > 0 ? (
                  <>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {predictionComponents.map((component) => {
                        const active = activeComponent?.id === component.id;
                        const linked = editorLinkedComponentId === component.id;

                        return (
                          <button
                            key={component.id}
                            type="button"
                            onClick={() => void activateComponent(component)}
                            className={cn(
                              "min-w-[124px] rounded-xl border px-3 py-2 text-left transition-smooth",
                              active
                                ? "border-primary/50 bg-primary/5 shadow-sm"
                                : "border-border/70 bg-background hover:border-primary/30 hover:bg-muted/40",
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-foreground">
                                {component.label}
                              </span>
                              <span
                                className={cn(
                                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                                  linked
                                    ? "bg-success/10 text-success"
                                    : "bg-muted text-muted-foreground",
                                )}
                              >
                                {linked ? "In editor" : "Stored"}
                              </span>
                            </div>
                            <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                              {truncateSmiles(component.response.smiles)}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    <p className="mt-3 text-xs text-muted-foreground">
                      {linkingEnabled && activeComponentSummary
                        ? `Atom and peak highlighting are linked to ${activeComponentSummary}.`
                        : "The editor currently contains a draft structure. Select a component to relink atom highlighting, or run a new prediction."}
                    </p>
                  </>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Replace clears the current spectrum and predicts the new structure. Add prediction appends another molecule to the same plotted mix.
                  </p>
                )}
              </div>

              {result && result.warnings && result.warnings.length > 0 ? (
                <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 text-xs text-warning">
                  <p className="mb-1 font-semibold">Warnings</p>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {result.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </aside>
          </div>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-foreground">
                  Predicted {(result?.nucleus ?? nucleus)} spectrum
                  {result ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      ({resultSignalCount} signal{resultSignalCount === 1 ? "" : "s"}
                      {predictionComponents.length > 1
                        ? ` across ${predictionComponents.length} molecules`
                        : ""}
                      )
                    </span>
                  ) : null}
                </h2>
                <p className="text-xs text-muted-foreground">
                  Full-width comparison view for engine overlays, atom linking, and close-peak inspection.
                </p>
              </div>

              {linkingEnabled && selectedAtomIndex != null ? (
                <button
                  type="button"
                  onClick={() => setSelectedAtomIndex(null)}
                  className="rounded-md bg-accent/10 px-2 py-1 text-xs font-medium text-accent transition-smooth hover:bg-accent/20"
                >
                  Atom #{selectedAtomIndex} selected in {activeComponent?.label ?? "component"} -
                  clear
                </button>
              ) : null}
            </div>

            {result ? (
              <SpectrumPlot
                shifts={result.shifts}
                nucleus={result.nucleus}
                mode={result.mode}
                selectedAtomIndex={linkingEnabled ? selectedAtomIndex : null}
                activeSourceId={linkingEnabled ? activeComponent?.id ?? null : null}
                activeSourceLabel={linkingEnabled ? activeComponent?.label ?? null : null}
                linkingEnabled={linkingEnabled}
                onAtomHover={setHoveredAtomIndices}
              />
            ) : (
              <div className="flex h-[460px] flex-col items-center justify-center gap-3 rounded-2xl border bg-card text-center text-sm text-muted-foreground shadow-card">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                  <Sparkles className="h-5 w-5 text-primary" />
                </div>
                Draw a molecule, pick engines, then run prediction.
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
};

export default Index;
