import { Trash2, X } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  comparisonSimilarities,
  comparisonXDomain,
  type ComparisonLayout,
} from "@/lib/gcms/comparison";
import type { ComparisonSpectrumItem } from "@/lib/gcms/types";
import { SpectrumPanel } from "./SpectrumPanel";

interface ComparisonTrayProps {
  items: ComparisonSpectrumItem[];
  layout: ComparisonLayout;
  normalize: boolean;
  tolerance: number;
  onLayoutChange(layout: ComparisonLayout): void;
  onNormalizeChange(value: boolean): void;
  onToleranceChange(value: number): void;
  onPatch(id: string, patch: Partial<Pick<ComparisonSpectrumItem, "label" | "color">>): void;
  onRemove(id: string): void;
  onClear(): void;
}

export function ComparisonTray({
  items,
  layout,
  normalize,
  tolerance,
  onLayoutChange,
  onNormalizeChange,
  onToleranceChange,
  onPatch,
  onRemove,
  onClear,
}: ComparisonTrayProps): JSX.Element {
  const xDomain = useMemo(() => comparisonXDomain(items), [items]);
  const similarities = useMemo(
    () => comparisonSimilarities(items, tolerance),
    [items, tolerance],
  );
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  if (items.length === 0) {
    return (
      <div className="flex h-[420px] items-center justify-center rounded-2xl border-2 border-dashed border-border/70 bg-muted/20 px-6 text-center">
        <div className="max-w-md">
          <p className="text-sm font-semibold text-foreground">No saved comparison spectra</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Create a chromatogram selection or freeze the live scan, then use
            <span className="font-medium text-foreground"> Add to comparison </span>
            in that spectrum panel. Switch documents and repeat to compare independent RT windows.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/60 bg-card px-3 py-2.5">
        <div className="flex rounded-lg border border-border/60 bg-muted/20 p-0.5">
          {(["separate", "overlay", "stacked"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={layout === value ? "default" : "ghost"}
              className="h-7 px-2.5 text-xs capitalize"
              onClick={() => onLayoutChange(value)}
            >
              {value === "separate" ? "Separate" : value === "overlay" ? "Overlay" : "Stacked"}
            </Button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={normalize} onCheckedChange={onNormalizeChange} />
          Normalize each to 100%
        </label>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          Similarity tolerance
          <Input
            type="number"
            min={0.001}
            step={0.01}
            value={tolerance}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && value > 0) onToleranceChange(value);
            }}
            className="h-7 w-20 px-2 text-xs"
          />
          Da
        </label>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onClear}>
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          Clear
        </Button>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {items.map((item, index) => (
          <div key={item.id} className="flex items-center gap-2 rounded-xl border border-border/60 bg-card px-2.5 py-2">
            <input
              type="color"
              value={item.color}
              onChange={(event) => onPatch(item.id, { color: event.target.value })}
              className="h-6 w-7 shrink-0 cursor-pointer rounded border border-border/60 bg-transparent p-0.5"
              title={`Colour for ${item.label}`}
            />
            <div className="min-w-0 flex-1">
              <Input
                value={item.label}
                onChange={(event) => onPatch(item.id, { label: event.target.value })}
                className="h-7 border-0 bg-transparent px-1 text-xs font-medium shadow-none"
                aria-label={`Comparison label ${index + 1}`}
              />
              <p className="truncate px-1 text-[10px] text-muted-foreground">
                {item.documentName} · {item.spectrum.scanCount} scan{item.spectrum.scanCount === 1 ? "" : "s"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              className="shrink-0 text-muted-foreground/60 hover:text-destructive"
              title={`Remove ${item.label}`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      {similarities.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {similarities.map((pair) => {
            const a = itemById.get(pair.aId);
            const b = itemById.get(pair.bId);
            if (!a || !b) return null;
            return (
              <div key={`${pair.aId}:${pair.bId}`} className="rounded-lg border border-border/60 bg-muted/20 px-2.5 py-1.5 text-[11px]">
                <span className="font-medium text-foreground">{a.label}</span>
                <span className="text-muted-foreground"> vs </span>
                <span className="font-medium text-foreground">{b.label}</span>
                <span className="ml-2 font-semibold text-primary">{(pair.score * 100).toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      )}

      {layout === "separate" ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {items.map((item, index) => (
            <div key={item.id} className="h-[340px] rounded-xl border border-border/60 bg-card p-2">
              <SpectrumPanel
                spectra={[item.spectrum]}
                ids={[item.id]}
                colors={[item.color]}
                peaks={item.peaks}
                title={item.label}
                normalize={normalize}
                stacked={false}
                logY={false}
                xDomain={xDomain}
                minHeight={240}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="h-[480px] rounded-xl border border-border/60 bg-card p-2">
          <SpectrumPanel
            spectra={items.map((item) => item.spectrum)}
            ids={items.map((item) => item.id)}
            colors={items.map((item) => item.color)}
            peaks={items[0]?.peaks ?? []}
            overlayPeaks={items.slice(1).map((item, index) => ({
              peaks: items[index + 1]?.peaks ?? [],
              color: item.color,
            }))}
            title={layout === "overlay" ? "Comparison overlay" : "Stacked comparison"}
            normalize={normalize}
            stacked={layout === "stacked"}
            logY={false}
            xDomain={xDomain}
            minHeight={360}
          />
        </div>
      )}
    </div>
  );
}
