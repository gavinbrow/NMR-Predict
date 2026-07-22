import { Check, GitMerge, Layers, Pencil, Scissors } from "lucide-react";
import { useState } from "react";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { formatMeanSd } from "@/lib/tensile/format";
import { useTensileStore } from "@/lib/tensile/store";
import type { MaterialView, PropertyKey } from "@/lib/tensile/types";
import { cn } from "@/lib/utils";

/**
 * The materials side panel (Phase 5): group specimens into named materials.
 * Rename inline, move/copy a specimen to another material, exclude a specimen
 * from stats, merge two materials, or split selected specimens into a new one.
 * Clicking a material name toggles it in the shared selection (highlighting it
 * across the table and charts).
 */
export function MaterialsPanel() {
  const {
    materialViews,
    selection,
    renameMaterial,
    createMaterialFrom,
    toggleMaterialSelected,
  } = useTensileStore();

  const selectedSpecimens = selection.specimenIds.length;

  const newFromSelected = selectedSpecimens > 0 && (
    <Button
      size="sm"
      variant="outline"
      className="h-7 gap-1 text-xs"
      onClick={() => createMaterialFrom(selection.specimenIds, "New material")}
    >
      <Scissors className="h-3 w-3" />
      New from selected ({selectedSpecimens})
    </Button>
  );

  return (
    <CollapsibleSection
      title="Materials"
      icon={Layers}
      count={materialViews.length}
      headerRight={newFromSelected || undefined}
    >
      <div className="flex flex-col gap-3">
        {materialViews.map((mv) => (
          <MaterialCard
            key={mv.id}
            material={mv}
            allMaterials={materialViews}
            selectedProperty={selection.property}
            isSelected={selection.materialIds.includes(mv.id)}
            onToggleSelected={() => toggleMaterialSelected(mv.id)}
            onRename={(name) => renameMaterial(mv.id, name)}
          />
        ))}
        {materialViews.length === 0 && (
          <p className="rounded-xl border border-dashed border-border/70 p-4 text-center text-xs text-muted-foreground">
            Load a file to create your first material.
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}

function MaterialCard({
  material,
  allMaterials,
  selectedProperty,
  isSelected,
  onToggleSelected,
  onRename,
}: {
  material: MaterialView;
  allMaterials: MaterialView[];
  selectedProperty: PropertyKey;
  isSelected: boolean;
  onToggleSelected: () => void;
  onRename: (name: string) => void;
}) {
  const { setExcluded, moveSpecimen, mergeMaterials } = useTensileStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(material.name);

  const stat = material.stats[selectedProperty];
  const others = allMaterials.filter((m) => m.id !== material.id);

  const commit = () => {
    const name = draft.trim();
    if (name) onRename(name);
    else setDraft(material.name);
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "rounded-2xl border bg-card p-3 shadow-card transition-smooth",
        isSelected ? "border-primary/60 ring-1 ring-primary/30" : "border-border/70",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: material.color }}
        />
        {editing ? (
          <div className="flex flex-1 items-center gap-1">
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraft(material.name);
                  setEditing(false);
                }
              }}
              className="h-7 text-sm"
            />
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={commit}>
              <Check className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={onToggleSelected}
              className="flex-1 truncate text-left text-sm font-semibold text-foreground hover:text-primary"
              title="Highlight this material"
            >
              {material.name}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(material.name);
                setEditing(true);
              }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Rename material"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            {others.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Merge material"
                  >
                    <GitMerge className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Merge into…</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {others.map((o) => (
                    <DropdownMenuItem key={o.id} onClick={() => mergeMaterials(material.id, o.id)}>
                      {o.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
      </div>

      <p className="mt-1 pl-5 text-xs text-muted-foreground">
        {material.includedSpecimens.length} of {material.specimens.length} in stats ·{" "}
        {stat ? formatMeanSd(selectedProperty, stat.mean, stat.sd) : "N/A"}
      </p>

      <ul className="mt-2 flex flex-col gap-1">
        {material.specimens.map((s) => (
          <li
            key={s.id}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2 py-1 text-xs",
              s.excluded && "opacity-50",
            )}
          >
            <Checkbox
              checked={!s.excluded}
              onCheckedChange={(c) => setExcluded(s.id, c !== true)}
              aria-label="Include in stats"
            />
            <span className="flex-1 truncate" title={`${s.label} — ${s.fileName}`}>
              {s.label}
            </span>
            {others.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="rounded px-1 text-muted-foreground hover:text-foreground"
                  >
                    move ▾
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Move to…</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {others.map((o) => (
                    <DropdownMenuItem key={o.id} onClick={() => moveSpecimen(s.id, o.id)}>
                      {o.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
