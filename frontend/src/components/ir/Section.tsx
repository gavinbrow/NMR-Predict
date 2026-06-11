import { ChevronDown } from "lucide-react";
import { useState } from "react";

/** A collapsible step container. */
export function Section({
  title,
  caption,
  defaultOpen = true,
  children,
}: {
  title: string;
  caption?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border border-border/60 bg-card shadow-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {caption && <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <div className="border-t border-border/50 px-5 py-4">{children}</div>}
    </div>
  );
}
