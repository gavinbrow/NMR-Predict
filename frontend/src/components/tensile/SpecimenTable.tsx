import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MACHINE_MAP, PROPERTY_META } from "@/lib/tensile/compute";
import { formatValue } from "@/lib/tensile/format";
import { useTensileStore } from "@/lib/tensile/store";
import type { PropertyKey, Specimen } from "@/lib/tensile/types";
import { cn } from "@/lib/utils";

/** Property key → instrument `Results` header, for the side-by-side readout. */
const MACHINE_BY_PROP = new Map(MACHINE_MAP.map((m) => [m.prop, m.machine]));

type SortKey = "label" | "material" | PropertyKey;
type SortDir = "asc" | "desc";

/**
 * One row per specimen, every property a sortable column (Phase 5). Supports a
 * label search, a "hide excluded" filter, an exclude checkbox per row (which
 * drops the specimen from the mean ± SD elsewhere), and linked selection —
 * clicking a row highlights it across the tab. Excluded rows are greyed.
 */
export function SpecimenTable() {
  const { specimens, materialViews, selection, setExcluded, toggleSpecimenSelected } =
    useTensileStore();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "label", dir: "asc" });
  const [query, setQuery] = useState("");
  const [hideExcluded, setHideExcluded] = useState(false);
  const [showInstrument, setShowInstrument] = useState(true);

  // Any instrument values present at all? (Drives the optional "vs instrument" toggle.)
  const hasMachine = useMemo(
    () => specimens.some((s) => s.machine && Object.keys(s.machine).length > 0),
    [specimens],
  );

  // specimen id → { name, color } for the Material column.
  const materialOf = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const mv of materialViews) {
      for (const id of mv.specimenIds) map.set(id, { name: mv.name, color: mv.color });
    }
    return map;
  }, [materialViews]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = specimens;
    if (q) list = list.filter((s) => s.label.toLowerCase().includes(q));
    if (hideExcluded) list = list.filter((s) => !s.excluded);

    const dir = sort.dir === "asc" ? 1 : -1;
    const getStr = (s: Specimen): string =>
      sort.key === "label" ? s.label : (materialOf.get(s.id)?.name ?? "");
    const getNum = (s: Specimen): number => s.props[sort.key as PropertyKey] as number;

    return [...list].sort((a, b) => {
      if (sort.key === "label" || sort.key === "material") {
        return dir * getStr(a).localeCompare(getStr(b), undefined, { numeric: true });
      }
      const av = getNum(a);
      const bv = getNum(b);
      // Non-finite (N/A) always sorts to the bottom.
      const aok = Number.isFinite(av);
      const bok = Number.isFinite(bv);
      if (!aok && !bok) return 0;
      if (!aok) return 1;
      if (!bok) return -1;
      return dir * (av - bv);
    });
  }, [specimens, query, hideExcluded, sort, materialOf]);

  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "label" || key === "material" ? "asc" : "desc" },
    );

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sort.key !== k) return <ChevronsUpDown className="h-3 w-3 opacity-40" />;
    return sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  const selected = new Set(selection.specimenIds);
  const numericCols = PROPERTY_META;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search specimens…"
            className="h-9 pl-8"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={hideExcluded}
            onCheckedChange={(c) => setHideExcluded(c === true)}
          />
          Hide excluded
        </label>
        {hasMachine && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={showInstrument}
              onCheckedChange={(c) => setShowInstrument(c === true)}
            />
            vs instrument
          </label>
        )}
        <span className="text-xs text-muted-foreground">
          {rows.length} of {specimens.length}
        </span>
      </div>

      <div className="overflow-auto rounded-xl border border-border/70">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="w-10 text-center">Use</TableHead>
              <HeadCell onClick={() => toggleSort("label")} className="sticky left-0 bg-muted/40">
                Specimen <SortIcon k="label" />
              </HeadCell>
              <HeadCell onClick={() => toggleSort("material")}>
                Material <SortIcon k="material" />
              </HeadCell>
              {numericCols.map((c) => (
                <HeadCell key={c.key} onClick={() => toggleSort(c.key)} className="text-right">
                  <span className="inline-flex items-center gap-1">
                    {c.label}
                    <span className="text-[10px] font-normal text-muted-foreground">({c.unit})</span>
                    <SortIcon k={c.key} />
                  </span>
                </HeadCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => {
              const mat = materialOf.get(s.id);
              const isSel = selected.has(s.id);
              return (
                <TableRow
                  key={s.id}
                  onClick={() => toggleSpecimenSelected(s.id)}
                  className={cn(
                    "cursor-pointer",
                    s.excluded && "opacity-45",
                    isSel && "bg-primary/5 hover:bg-primary/10",
                  )}
                >
                  <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={!s.excluded}
                      onCheckedChange={(c) => setExcluded(s.id, c !== true)}
                      aria-label={s.excluded ? "Include in stats" : "Exclude from stats"}
                    />
                  </TableCell>
                  <TableCell className="sticky left-0 bg-background font-medium">
                    {s.label}
                  </TableCell>
                  <TableCell>
                    {mat && (
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: mat.color }}
                        />
                        <span className="truncate">{mat.name}</span>
                      </span>
                    )}
                  </TableCell>
                  {numericCols.map((c) => {
                    const mk = MACHINE_BY_PROP.get(c.key);
                    const mv = mk && s.machine ? s.machine[mk] : undefined;
                    return (
                      <TableCell key={c.key} className="text-right tabular-nums">
                        {formatValue(c.key, s.props[c.key] as number)}
                        {showInstrument && mk && (
                          <span
                            className="block text-[10px] font-normal text-muted-foreground"
                            title="Instrument value"
                          >
                            {Number.isFinite(mv) ? `inst ${formatValue(c.key, mv as number)}` : "inst —"}
                          </span>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={numericCols.length + 3} className="py-8 text-center text-sm text-muted-foreground">
                  No specimens match the current filter.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function HeadCell({
  children,
  onClick,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <TableHead className={cn("whitespace-nowrap", className)}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 font-semibold text-foreground hover:text-primary"
      >
        {children}
      </button>
    </TableHead>
  );
}
