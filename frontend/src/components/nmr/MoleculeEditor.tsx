import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import type { Ketcher } from "ketcher-core";

interface MoleculeEditorProps {
  onReady?: (ketcher: Ketcher) => void;
  onSmilesChange?: (smiles: string) => void;
  onAtomClick?: (atomIndex: number) => void;
}

type RuntimeEditorComponent = ComponentType<{
  staticResourcesUrl: string;
  structServiceProvider: unknown;
  errorHandler?: (message: string) => void;
  onInit?: (ketcher: Ketcher) => void;
  disableMacromoleculesEditor?: boolean;
}>;

type BrowserProcess = {
  env: Record<string, string | undefined>;
};

function ensureKetcherRuntimeGlobals() {
  const runtime = globalThis as typeof globalThis & {
    global?: typeof globalThis;
    process?: BrowserProcess;
  };

  // Ketcher's Vite-prebundled bundle still reads `process.env.*` and `global.*`
  // at runtime, so provide the browser-safe globals it expects before import().
  runtime.global ??= globalThis;
  runtime.process ??= { env: {} };
  runtime.process.env ??= {};
}

/**
 * Loads Ketcher only in the browser at runtime.
 * If its bundle fails in this environment, keep the app usable with a
 * manual SMILES fallback instead of crashing the whole page.
 */
export function MoleculeEditor({ onReady, onSmilesChange, onAtomClick }: MoleculeEditorProps) {
  const ketcherRef = useRef<Ketcher | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [EditorComponent, setEditorComponent] = useState<RuntimeEditorComponent | null>(null);
  const [structServiceProvider, setStructServiceProvider] = useState<unknown>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [manualSmiles, setManualSmiles] = useState("");

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        ensureKetcherRuntimeGlobals();
        await import("ketcher-react/dist/index.css");
        const [{ Editor }, { StandaloneStructServiceProvider }] = await Promise.all([
          import("ketcher-react"),
          import("ketcher-standalone"),
        ]);

        if (!active) return;
        setEditorComponent(() => Editor as RuntimeEditorComponent);
        setStructServiceProvider(new StandaloneStructServiceProvider());
        setLoadError(null);
      } catch (error) {
        if (!active) return;
        setLoadError(
          error instanceof Error
            ? error.message
            : "Ketcher failed to load in this environment.",
        );
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !onAtomClick) return;

    const handler = async () => {
      const k = ketcherRef.current;
      if (!k) return;

      try {
        // Best-effort: read current selection; atom clicks usually update it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const editor: any = (k as any).editor;
        const selection = editor?.selection?.();
        const idx = selection?.atoms?.[0];
        if (typeof idx === "number") onAtomClick(idx);
      } catch {
        /* noop */
      }
    };

    host.addEventListener("click", handler);
    return () => host.removeEventListener("click", handler);
  }, [onAtomClick, EditorComponent]);

  if (loadError) {
    return (
      <div className="flex h-full w-full flex-col gap-3 bg-muted/20 p-4">
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          Ketcher could not load here, so the editor fell back to manual SMILES input.
        </div>
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-xs font-medium text-foreground">SMILES</span>
          <textarea
            value={manualSmiles}
            onChange={(event) => {
              const value = event.target.value;
              setManualSmiles(value);
              onSmilesChange?.(value);
            }}
            placeholder="Enter a SMILES string, e.g. CCO"
            className="min-h-[220px] flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-smooth placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
          />
        </label>
        <p className="text-[11px] text-muted-foreground">Runtime error: {loadError}</p>
      </div>
    );
  }

  if (!EditorComponent || !structServiceProvider) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20 text-sm text-muted-foreground">
        Loading molecule editor...
      </div>
    );
  }

  return (
    <div ref={hostRef} className="ketcher-host h-full w-full">
      <EditorComponent
        staticResourcesUrl={import.meta.env.BASE_URL}
        structServiceProvider={structServiceProvider}
        disableMacromoleculesEditor
        errorHandler={(message) => {
          // eslint-disable-next-line no-console
          console.warn("[ketcher]", message);
        }}
        onInit={(ketcher: Ketcher) => {
          ketcherRef.current = ketcher;
          onReady?.(ketcher);

          // Hook structure changes to debounced SMILES extraction in parent.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const editor: any = (ketcher as any).editor;
          editor?.subscribe?.("change", async () => {
            try {
              const smiles = await ketcher.getSmiles();
              onSmilesChange?.(smiles ?? "");
            } catch {
              onSmilesChange?.("");
            }
          });
        }}
      />
    </div>
  );
}
