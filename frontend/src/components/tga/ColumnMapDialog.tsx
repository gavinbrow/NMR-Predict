// Column mapper for generic CSV / spreadsheet imports.
//
// A native TGA file names its own columns; an arbitrary export from someone
// else's instrument does not. When `autoDetectColumnMap` can't find a
// confident Time / Temperature / Weight trio, the dispatcher hands the cell
// grid back in `needsMapping` and this dialog asks which column is which,
// previewing the first rows so the answer is obvious from the data rather than
// from the header wording.
//
// The answer is remembered per header signature in localStorage, so the second
// import of the same layout needs one click (or none, when the same file name
// comes back in the same session).

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { rememberMap } from "@/lib/tga/columnMaps";
import { headerSignature } from "@/lib/tga/parse/genericTable";
import type { PendingColumnMap } from "@/lib/tga/parse";
import type { ColumnMap } from "@/lib/tga/types";

/** How many rows of the grid the preview table shows. */
const PREVIEW_ROWS = 6;

/** A column picker over the grid's header row. Value `-1` means "none". */
function ColumnSelect({
  value,
  onChange,
  headers,
  allowNone,
}: {
  value: number;
  onChange: (v: number) => void;
  headers: string[];
  allowNone?: boolean;
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowNone && (
          <SelectItem value="-1" className="text-xs">
            (none)
          </SelectItem>
        )}
        {headers.map((h, i) => (
          <SelectItem key={i} value={String(i)} className="text-xs">
            {`${colName(i)} — ${h || "(blank)"}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Spreadsheet column name for a zero-based index (0 → A, 26 → AA). */
function colName(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function ColumnMapDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  /** The file waiting on a mapping, or null when the dialog is closed. */
  pending: PendingColumnMap | null;
  onCancel: () => void;
  onConfirm: (map: ColumnMap) => void;
}) {
  // The dialog is remounted per pending file (keyed by the caller), so seeding
  // state from props here is correct rather than stale.
  const [headerRow, setHeaderRow] = useState(pending?.suggestion?.headerRow ?? 0);
  const [firstDataRow, setFirstDataRow] = useState(
    pending?.suggestion?.firstDataRow ?? (pending?.suggestion?.headerRow ?? 0) + 1,
  );
  const [time, setTime] = useState(pending?.suggestion?.time ?? 0);
  const [temperature, setTemperature] = useState(pending?.suggestion?.temperature ?? 1);
  const [weight, setWeight] = useState(pending?.suggestion?.weight ?? 2);
  const [weightPct, setWeightPct] = useState(pending?.suggestion?.weightPct ?? -1);
  const [dtg, setDtg] = useState(pending?.suggestion?.dtg ?? -1);
  const [weightUnit, setWeightUnit] = useState<ColumnMap["weightUnit"]>(
    pending?.suggestion?.weightUnit ?? "mg",
  );
  const [tempUnit, setTempUnit] = useState<ColumnMap["tempUnit"]>(
    pending?.suggestion?.tempUnit ?? "C",
  );

  // Memoized so the `headers` memo below has a stable dependency (a fresh []
  // every render would recompute it every time).
  const rows = useMemo(() => pending?.grid.rows ?? [], [pending]);
  const headers = useMemo(() => {
    const row = rows[headerRow] ?? [];
    // Pad to the widest row so a short header line doesn't hide later columns.
    const width = rows.slice(0, 40).reduce((m, r) => Math.max(m, r.length), row.length);
    return Array.from({ length: width }, (_, i) => String(row[i] ?? "").trim());
  }, [rows, headerRow]);

  if (!pending) return null;

  const previewRows = rows.slice(firstDataRow, firstDataRow + PREVIEW_ROWS);
  const valid = time >= 0 && temperature >= 0 && weight >= 0 && firstDataRow > headerRow - 1;

  const confirm = () => {
    const map: ColumnMap = {
      time,
      temperature,
      weight,
      ...(weightPct >= 0 ? { weightPct } : {}),
      ...(dtg >= 0 ? { dtg } : {}),
      weightUnit,
      tempUnit,
      headerRow,
      firstDataRow,
    };
    rememberMap(headerSignature(rows[headerRow] ?? []), map);
    onConfirm(map);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Map columns — {pending.fileName}</DialogTitle>
          <DialogDescription>
            This file's columns couldn't be identified automatically. Pick which column holds
            each signal; the preview below updates as you choose.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Time">
            <ColumnSelect value={time} onChange={setTime} headers={headers} />
          </Field>
          <Field label="Temperature">
            <ColumnSelect value={temperature} onChange={setTemperature} headers={headers} />
          </Field>
          <Field label="Weight">
            <ColumnSelect value={weight} onChange={setWeight} headers={headers} />
          </Field>
          <Field label="Weight % (optional)">
            <ColumnSelect value={weightPct} onChange={setWeightPct} headers={headers} allowNone />
          </Field>
          <Field label="Deriv. weight (optional)">
            <ColumnSelect value={dtg} onChange={setDtg} headers={headers} allowNone />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Weight unit">
              <Select
                value={weightUnit}
                onValueChange={(v) => setWeightUnit(v as ColumnMap["weightUnit"])}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mg" className="text-xs">mg</SelectItem>
                  <SelectItem value="g" className="text-xs">g</SelectItem>
                  <SelectItem value="%" className="text-xs">%</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Temp. unit">
              <Select
                value={tempUnit}
                onValueChange={(v) => setTempUnit(v as ColumnMap["tempUnit"])}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="C" className="text-xs">°C</SelectItem>
                  <SelectItem value="K" className="text-xs">K</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Header row (0-based)">
            <Input
              type="number"
              min={0}
              value={headerRow}
              onChange={(e) => {
                const v = Math.max(0, Number(e.target.value) || 0);
                setHeaderRow(v);
                if (firstDataRow <= v) setFirstDataRow(v + 1);
              }}
              className="h-8 text-xs"
            />
          </Field>
          <Field label="First data row (0-based)">
            <Input
              type="number"
              min={0}
              value={firstDataRow}
              onChange={(e) => setFirstDataRow(Math.max(0, Number(e.target.value) || 0))}
              className="h-8 text-xs"
            />
          </Field>
        </div>

        <div className="max-h-56 overflow-auto rounded-lg border border-border/60">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border/60">
                {headers.map((h, i) => {
                  const role =
                    i === time
                      ? "Time"
                      : i === temperature
                        ? "Temp"
                        : i === weight
                          ? "Weight"
                          : i === weightPct
                            ? "Weight %"
                            : i === dtg
                              ? "Deriv."
                              : null;
                  return (
                    <th
                      key={i}
                      className={`whitespace-nowrap px-2 py-1 text-left font-medium ${
                        role ? "text-primary" : "text-muted-foreground"
                      }`}
                    >
                      {colName(i)}
                      {role ? ` · ${role}` : ""}
                      <div className="font-normal text-muted-foreground">{h || "—"}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((r, ri) => (
                <tr key={ri} className="border-b border-border/30">
                  {headers.map((_, ci) => (
                    <td key={ci} className="whitespace-nowrap px-2 py-0.5 tabular-nums">
                      {String(r[ci] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Skip this file
          </Button>
          <Button size="sm" disabled={!valid} onClick={confirm}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
