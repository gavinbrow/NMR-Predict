import { ChevronDown, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * A card section that can be minimized to just its header. Used across the
 * tensile workspace so that — with many files loaded — the long lists (files,
 * materials, the specimen table, the summary, the charts) can be collapsed into
 * a dropdown-style header instead of all being open at once. Sections start
 * collapsed by default so a freshly-loaded workspace is a tidy stack of headers
 * the user opens as needed.
 *
 * The chevron/title acts as the toggle; `headerRight` holds controls (selects,
 * buttons) that stay clickable without collapsing the section.
 */
export function CollapsibleSection({
  title,
  icon: Icon,
  count,
  defaultOpen = false,
  headerRight,
  className,
  contentClassName,
  children,
}: {
  title: ReactNode;
  icon?: LucideIcon;
  count?: number | string;
  defaultOpen?: boolean;
  headerRight?: ReactNode;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className={cn(
        "rounded-2xl border border-border/70 bg-card shadow-card",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]:-rotate-90" />
          {Icon && <Icon className="h-4 w-4 shrink-0 text-primary" />}
          <span className="truncate text-sm font-semibold text-foreground">{title}</span>
          {count != null && (
            <span className="shrink-0 text-xs font-normal text-muted-foreground">({count})</span>
          )}
        </CollapsibleTrigger>
        {headerRight && (
          <div className="flex shrink-0 items-center gap-2">{headerRight}</div>
        )}
      </div>
      <CollapsibleContent className={cn("px-4 pb-4", contentClassName)}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
