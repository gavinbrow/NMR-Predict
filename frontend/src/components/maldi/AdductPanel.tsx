import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BUILTIN_ADDUCTS, NEGATIVE_ADDUCTS } from "@/lib/maldi/adducts";
import type { Adduct } from "@/lib/maldi/types";

interface AdductPanelProps {
  selectedIds: string[];
  customAdducts: Adduct[];
  onChangeSelected: (ids: string[]) => void;
  onAddCustom: (adduct: Adduct) => void;
  onRemoveCustom: (id: string) => void;
}

let customCounter = 0;

export function AdductPanel({
  selectedIds,
  customAdducts,
  onChangeSelected,
  onAddCustom,
  onRemoveCustom,
}: AdductPanelProps) {
  const [label, setLabel] = useState("");
  const [shift, setShift] = useState("");
  const [charge, setCharge] = useState("1");

  const selected = new Set(selectedIds);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChangeSelected([...next]);
  };

  const renderChip = (adduct: Adduct) => {
    const isSelected = selected.has(adduct.id);
    return (
      <button
        key={adduct.id}
        type="button"
        onClick={() => toggle(adduct.id)}
        className={[
          "group inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-smooth",
          isSelected
            ? "border-primary bg-primary/10 text-primary"
            : "border-border/70 bg-background/60 text-muted-foreground hover:border-primary/40",
        ].join(" ")}
      >
        {adduct.label}
        <span className="font-mono text-[10px] opacity-70">
          {adduct.massShift >= 0 ? "+" : ""}
          {adduct.massShift.toFixed(3)}
        </span>
        {!adduct.builtin && (
          <Trash2
            className="h-3 w-3 opacity-50 hover:text-destructive hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveCustom(adduct.id);
            }}
          />
        )}
      </button>
    );
  };

  const addCustom = () => {
    const massShift = Number(shift);
    const chargeNum = Number(charge);
    if (!label.trim() || !Number.isFinite(massShift) || !Number.isFinite(chargeNum) || chargeNum === 0) return;
    customCounter += 1;
    onAddCustom({
      id: `custom-${Date.now()}-${customCounter}`,
      label: label.trim(),
      massShift,
      charge: chargeNum,
      builtin: false,
    });
    setLabel("");
    setShift("");
    setCharge("1");
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        Choose the adducts to consider before assigning series. MALDI of synthetic polymers is
        usually Na⁺/K⁺ — never assume [M+H]⁺.
      </p>

      <div className="flex flex-col gap-1.5">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Positive mode</Label>
        <div className="flex flex-wrap gap-1.5">{BUILTIN_ADDUCTS.map(renderChip)}</div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Negative mode</Label>
        <div className="flex flex-wrap gap-1.5">{NEGATIVE_ADDUCTS.map(renderChip)}</div>
      </div>
      {customAdducts.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Custom</Label>
          <div className="flex flex-wrap gap-1.5">{customAdducts.map(renderChip)}</div>
        </div>
      )}

      <div className="rounded-lg border border-border/60 bg-background/60 p-2.5">
        <p className="mb-1.5 text-[11px] font-medium text-foreground">Custom adduct</p>
        <div className="grid grid-cols-[1fr_auto_auto] items-end gap-1.5">
          <div className="grid gap-1">
            <Label className="text-[10px] text-muted-foreground">Label</Label>
            <Input className="h-7 text-xs" placeholder="[M+Cs]+" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="grid w-20 gap-1">
            <Label className="text-[10px] text-muted-foreground">Δ mass</Label>
            <Input className="h-7 text-xs" type="number" placeholder="132.905" value={shift} onChange={(e) => setShift(e.target.value)} />
          </div>
          <div className="grid w-14 gap-1">
            <Label className="text-[10px] text-muted-foreground">Charge</Label>
            <Input className="h-7 text-xs" type="number" value={charge} onChange={(e) => setCharge(e.target.value)} />
          </div>
        </div>
        <Button size="sm" variant="outline" className="mt-2 h-7 w-full" onClick={addCustom}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add custom adduct
        </Button>
      </div>
    </div>
  );
}
