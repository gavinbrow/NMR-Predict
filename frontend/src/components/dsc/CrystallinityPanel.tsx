// Left-rail "Crystallinity" section for the selected run: a ΔH°100 reference
// picker (built-in library plus user entries, with inline add/rename/delete
// of the user entries), a polymer-fraction input for filled composites, and
// the computed Xc % with the ΔHm/ΔHcc it was built from.
//
// Stateless apart from the ephemeral "new reference" draft fields and the
// per-entry rename draft — every PERSISTENT value (the run's `referenceId`/
// `polymerFraction`, the reference library itself) is a store action call,
// exactly like `MaterialsPanel`'s rename box. `userReferences` is passed in
// (the store's `references`, i.e. everything `allReferences()` adds on top
// of `BUILT_IN_REFERENCES`) rather than read via `allReferences()` directly,
// so this component never touches `localStorage` itself.

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { BUILT_IN_REFERENCES } from "@/lib/dsc/references";
import type { DscRunAnalyzed } from "@/lib/dsc/store";
import type { DscReference } from "@/lib/dsc/types";

function fmt(v: number | null | undefined, decimals = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(decimals);
}

function ReferenceRow({
  reference,
  onUpdate,
  onDelete,
}: {
  reference: DscReference;
  onUpdate: (patch: Partial<Omit<DscReference, "id">>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(reference.name);
  const [enthalpy, setEnthalpy] = useState(String(reference.enthalpy100JPerG));

  const commit = () => {
    const n = name.trim();
    const h = Number(enthalpy);
    if (n && Number.isFinite(h) && h > 0) onUpdate({ name: n, enthalpy100JPerG: h });
    else {
      setName(reference.name);
      setEnthalpy(String(reference.enthalpy100JPerG));
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-6 min-w-0 flex-1 text-[11px]"
        />
        <Input
          type="number"
          value={enthalpy}
          min={0}
          step={0.1}
          onChange={(e) => setEnthalpy(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setName(reference.name);
              setEnthalpy(String(reference.enthalpy100JPerG));
              setEditing(false);
            }
          }}
          className="h-6 w-16 text-[11px]"
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span className="min-w-0 flex-1 truncate">{reference.name}</span>
      <span className="text-muted-foreground">{reference.enthalpy100JPerG} J/g</span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Edit"
        className="shrink-0 text-muted-foreground/70 hover:text-foreground"
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        title="Delete"
        className="shrink-0 text-muted-foreground/60 hover:text-destructive"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

export function CrystallinityPanel({
  run,
  userReferences,
  onSetReference,
  onSetPolymerFraction,
  onAddReference,
  onUpdateReference,
  onDeleteReference,
}: {
  run: DscRunAnalyzed | null;
  /** The store's user-entered reference entries (`useDscStore().references`).
   *  Built-ins come from `BUILT_IN_REFERENCES` and are merged in here. */
  userReferences: DscReference[];
  onSetReference: (referenceId: string | null) => void;
  onSetPolymerFraction: (polymerFraction: number) => void;
  onAddReference: (reference: DscReference) => void;
  onUpdateReference: (id: string, patch: Partial<Omit<DscReference, "id">>) => void;
  onDeleteReference: (id: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [newEnthalpy, setNewEnthalpy] = useState("");

  const all = [...BUILT_IN_REFERENCES, ...userReferences];
  const selected = run ? all.find((r) => r.id === run.referenceId) : undefined;

  const addReference = () => {
    const name = newName.trim();
    const h = Number(newEnthalpy);
    if (!name || !Number.isFinite(h) || h <= 0) return;
    onAddReference({ id: crypto.randomUUID(), name, enthalpy100JPerG: h, builtIn: false });
    setNewName("");
    setNewEnthalpy("");
  };

  if (!run) {
    return <p className="text-xs text-muted-foreground">Select a run to compute % crystallinity.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1">
        <Label className="text-[11px] text-muted-foreground">ΔH°100 reference</Label>
        <Select
          value={run.referenceId ?? "__none"}
          onValueChange={(v) => onSetReference(v === "__none" ? null : v)}
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none" className="text-xs">
              (none)
            </SelectItem>
            {all.map((ref) => (
              <SelectItem key={ref.id} value={ref.id} className="text-xs">
                {ref.name} ({ref.enthalpy100JPerG} J/g)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selected?.note && <p className="text-[10px] text-muted-foreground">{selected.note}</p>}
      </div>

      <div className="grid gap-1">
        <Label className="text-[11px] text-muted-foreground">Polymer fraction (0–1)</Label>
        <Input
          type="number"
          value={run.polymerFraction}
          min={0}
          max={1}
          step={0.01}
          onChange={(e) => onSetPolymerFraction(Number(e.target.value))}
          className="h-8"
        />
      </div>

      <div className="rounded-lg border border-border/50 bg-background/40 p-3 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Xc</span>
          <span className="font-semibold text-foreground">
            {fmt(run.analysis.crystallinityPct, 1)} %
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-muted-foreground">
          <span>ΔHm used</span>
          <span>{fmt(run.analysis.melt?.enthalpyJPerG)} J/g</span>
        </div>
        <div className="flex items-center justify-between text-muted-foreground">
          <span>ΔHcc used</span>
          <span>{fmt(run.analysis.coldCrystallization?.enthalpyJPerG)} J/g</span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-[11px] text-muted-foreground">Your references</Label>
        {userReferences.length === 0 && (
          <p className="text-[10px] text-muted-foreground">No custom references yet.</p>
        )}
        {userReferences.map((ref) => (
          <ReferenceRow
            key={ref.id}
            reference={ref}
            onUpdate={(patch) => onUpdateReference(ref.id, patch)}
            onDelete={() => onDeleteReference(ref.id)}
          />
        ))}
        <div className="mt-1 flex items-center gap-1.5">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name"
            className="h-7 min-w-0 flex-1 text-xs"
          />
          <Input
            type="number"
            value={newEnthalpy}
            onChange={(e) => setNewEnthalpy(e.target.value)}
            placeholder="ΔH100 (J/g)"
            min={0}
            step={0.1}
            className="h-7 w-24 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-7 shrink-0 p-0"
            onClick={addReference}
            title="Add reference"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
