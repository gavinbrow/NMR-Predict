import { BookmarkPlus, Layers, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteTemplate, listTemplates, saveTemplate } from "@/lib/maldi/project";
import { BUILTIN_TEMPLATES, type ChemistryTemplate } from "@/lib/maldi/repeatLibrary";

interface TemplatePanelProps {
  /** Apply a template: pre-fills repeat / end group / adduct selection. */
  onApply: (template: ChemistryTemplate) => void;
  /** Current settings, offered for "save as template". */
  current: { repeatMass: number; endGroupMass?: number; adductIds: string[] };
}

/**
 * Built-in + user-saved chemistry templates. Applying one pre-fills the repeat
 * unit, end-group mass, and likely adducts so common polymer analyses start in
 * one click. User templates persist in IndexedDB.
 */
export function TemplatePanel({ onApply, current }: TemplatePanelProps) {
  const [userTemplates, setUserTemplates] = useState<ChemistryTemplate[]>([]);
  const [name, setName] = useState("");

  const refresh = () => {
    listTemplates().then(setUserTemplates).catch(() => setUserTemplates([]));
  };
  useEffect(refresh, []);

  const save = async () => {
    if (!name.trim()) {
      toast.error("Name the template first");
      return;
    }
    if (!(current.repeatMass > 0)) {
      toast.error("Set a repeat unit before saving a template");
      return;
    }
    await saveTemplate({
      id: "",
      name: name.trim(),
      repeatMass: current.repeatMass,
      endGroupMass: current.endGroupMass,
      adductIds: current.adductIds,
    });
    setName("");
    refresh();
    toast.success("Template saved");
  };

  const remove = async (id: string) => {
    await deleteTemplate(id);
    refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        Start from a known polymer chemistry — applies its repeat unit, end group, and likely adducts.
      </p>

      <div className="flex flex-col gap-1.5">
        {BUILTIN_TEMPLATES.map((t) => (
          <TemplateRow key={t.id} template={t} onApply={onApply} />
        ))}
        {userTemplates.map((t) => (
          <TemplateRow key={t.id} template={t} onApply={onApply} onRemove={() => remove(t.id)} />
        ))}
      </div>

      <div className="rounded-lg border border-border/60 bg-background/60 p-2.5">
        <p className="mb-1.5 text-[11px] font-medium text-foreground">Save current as template</p>
        <div className="flex items-end gap-1.5">
          <Input
            className="h-7 text-xs"
            placeholder="e.g. PEG-OMe, Na"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button size="sm" variant="outline" className="h-7" onClick={save}>
            <BookmarkPlus className="mr-1 h-3.5 w-3.5" /> Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function TemplateRow({
  template,
  onApply,
  onRemove,
}: {
  template: ChemistryTemplate;
  onApply: (t: ChemistryTemplate) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onApply(template)}>
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Layers className="h-3.5 w-3.5 text-primary" />
          {template.name}
        </span>
        <span className="block font-mono text-[10px] text-muted-foreground">
          {template.repeatMass.toFixed(3)} Da · {template.adductIds.join("/")}
          {template.endGroupMass != null ? ` · end ${template.endGroupMass.toFixed(2)}` : ""}
        </span>
      </button>
      {onRemove ? (
        <button type="button" className="text-muted-foreground hover:text-destructive" onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ) : (
        <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">built-in</span>
      )}
    </div>
  );
}
