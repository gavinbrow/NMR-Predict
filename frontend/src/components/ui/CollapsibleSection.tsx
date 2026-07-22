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
 *
 * Supports both Radix Collapsible modes: uncontrolled via `defaultOpen`, or
 * controlled via `open`/`onOpenChange`. The controlled escape hatch lets a host
 * persist open/closed state (e.g. to localStorage) or force a card open/closed
 * programmatically; tensile's existing callers pass only `defaultOpen` and are
 * unaffected.
 */
export function CollapsibleSection({
  title,
  icon: Icon,
  count,
  defaultOpen = false,
  open,
  onOpenChange,
  headerRight,
  forceMount = false,
  className,
  contentClassName,
  children,
}: {
  title: ReactNode;
  icon?: LucideIcon;
  count?: number | string;
  defaultOpen?: boolean;
  /** Controlled open state; when supplied the section is fully controlled. */
  open?: boolean;
  /** Called when the user toggles a controlled section. */
  onOpenChange?: (open: boolean) => void;
  headerRight?: ReactNode;
  /**
   * Keep the content mounted while collapsed (Radix `CollapsibleContent
   * forceMount`). Required when children hold local state mutated after an
   * `await` (collapsing mid-run would destroy that state). The content is
   * hidden via the `data-[state=closed]:hidden` class so the collapsed card
   * still shows nothing.
   */
  forceMount?: boolean;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible
      defaultOpen={open === undefined ? defaultOpen : undefined}
      open={open}
      onOpenChange={onOpenChange}
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
      <CollapsibleContent
        forceMount={forceMount ? true : undefined}
        className={cn(
          forceMount && "data-[state=closed]:hidden",
          "px-4 pb-4",
          contentClassName,
        )}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}