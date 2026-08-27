// Materials: named groups of runs, with the mean ± SD of the focused metric.
//
// A file that yields several runs (a TRIOS Excel export carries four samples
// side by side) becomes one material by default; from here the user can rename
// it, move a run into another material, merge two, or split a selection into a
// new one. The mean ± SD shown on each card is the same number the compare
// chart bars, computed by `lib/tga/compare.ts`.

import { GitMerge, Layers, Pencil, Scissors } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { metricValue, summarize, type TgaMetric } from "@/lib/tga/compare";
import { useTgaStore } from "@/lib/tga/store";
import type { TgaRunAnalyzed } from "@/lib/tga/store";
import type { TgaMaterial } from "@/lib/tga/types";

function fmtMeanSd(mean: number, sd: number, n: number, decimals: number, unit: string): string {
  if (!Number.isFinite(mean)) return "—";
  const base = `${mean.toFixed(decimals)}`;
  const spread = n > 1 && Number.isFinite(sd) ? ` ± ${sd.toFixed(decimals)}` : "";
  return `${base}${spread} ${unit}`.trim();
}

export function MaterialsPanel({
  metric,
  selectedRunIds,
  onSelectRun,
}: {
  /** The metric the cards summarize (shared with the compare chart). */
  metric: TgaMetric | undefined;
  /** Run ids currently selected, for "new material from selection". */
  selectedRunIds: string[];
  onSelectRun: (runId: string) => void;
}) {
  const { materials, runById, renameMaterial, createMaterialFrom, deleteMaterial } = useTgaStore();

  if (materials.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border/70 p-4 text-center text-xs text-muted-foreground">
        Import a file to create your first material.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {selectedRunIds.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 self-start text-xs"
          onClick={() => createMaterialFrom(selectedRunIds, "New material")}
        >
          <Scissors className="h-3 w-3" />
          New from selected ({selectedRunIds.length})
        </Button>
      )}
      {materials.map((m) => (
        <MaterialCard
          key={m.id}
          material={m}
          allMaterials={materials}
          runs={m.runIds.map((id) => runById.get(id)).filter((r): r is TgaRunAnalyzed => !!r)}
          metric={metric}
          onRename={(name) => renameMaterial(m.id, name)}
          onDelete={() => deleteMaterial(m.id)}
          onSelectRun={onSelectRun}
        />
      ))}
    </div>
  );
}

function MaterialCard({
  material,
  allMaterials,
  runs,
  metric,
  onRename,
  onDelete,
  onSelectRun,
}: {
  material: TgaMaterial;
  allMaterials: TgaMaterial[];
  runs: TgaRunAnalyzed[];
  metric: TgaMetric | undefined;
  onRename: (name: string) => void;
  onDelete: () => void;
  onSelectRun: (runId: string) => void;
}) {
  const { moveRun, mergeMaterials } = useTgaStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(material.name);

  const others = allMaterials.filter((m) => m.id !== material.id);
  const stat = metric
    ? summarize(runs.map((r) => metricValue(r, metric.key)))
    : { mean: NaN, sd: NaN, n: 0 };

  const commit = () => {
    const name = draft.trim();
    if (name) onRename(name);
    else setDraft(material.name);
    setEditing(false);
  };

  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-3">
      <div className="flex items-center gap-2">
        <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(material.name);
                setEditing(false);
              }
            }}
            className="h-7 flex-1 text-xs"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-medium text-foreground"
            title="Rename"
          >
            <span className="truncate">{material.name}</span>
            <Pencil className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0">
              <GitMerge className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="text-xs">Merge into…</DropdownMenuLabel>
            {others.length === 0 && (
              <DropdownMenuItem disabled className="text-xs">
                No other materials
              </DropdownMenuItem>
            )}
            {others.map((o) => (
              <DropdownMenuItem
                key={o.id}
                className="text-xs"
                onClick={() => mergeMaterials(material.id, o.id)}
              >
                {o.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs" onClick={onDelete}>
              Ungroup this material
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-1.5 text-[11px] text-muted-foreground">
        {runs.length} run{runs.length === 1 ? "" : "s"}
        {metric ? (
          <>
            {" · "}
            <span className="font-medium text-foreground">{metric.label}</span>{" "}
            {fmtMeanSd(stat.mean, stat.sd, stat.n, metric.decimals, metric.unit)}
          </>
        ) : null}
      </div>

      <div className="mt-2 flex flex-col gap-1">
        {runs.map((r) => (
          <div key={r.id} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-sm"
              style={{ backgroundColor: r.color }}
            />
            <button
              type="button"
              onClick={() => onSelectRun(r.id)}
              className="min-w-0 flex-1 truncate text-left text-[11px] text-foreground hover:underline"
              title={r.label}
            >
              {r.label}
            </button>
            {others.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 shrink-0 px-1 text-[10px] text-muted-foreground"
                  >
                    move
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel className="text-xs">Move to…</DropdownMenuLabel>
                  {others.map((o) => (
                    <DropdownMenuItem
                      key={o.id}
                      className="text-xs"
                      onClick={() => moveRun(r.id, o.id)}
                    >
                      {o.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
