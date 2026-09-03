// Read-only metadata panel for the selected run: instrument, operator,
// sample, mass, pan, run date, gases, cooler, cell constant, sample interval
// and exo direction from `DscMetadata` (§WP1.1), plus the parsed method
// program (`meta.methodSteps`). Mirrors `components/tga/MetadataPanel.tsx`.

import type { DscRunAnalyzed } from "@/lib/dsc/store";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="w-28 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-xs text-foreground">{value || "—"}</span>
    </div>
  );
}

export function MetadataPanel({ run }: { run: DscRunAnalyzed | null }) {
  if (!run) {
    return <p className="text-xs text-muted-foreground">Select a run to see its metadata.</p>;
  }
  const m = run.meta;
  return (
    <div className="grid gap-1">
      <Row label="Instrument" value={m.instrument} />
      <Row label="Operator" value={m.operator} />
      <Row label="Sample" value={m.sampleName} />
      <Row label="Sample mass" value={m.sampleMassMg != null ? `${m.sampleMassMg} mg` : ""} />
      <Row label="Pan" value={m.pan} />
      <Row label="Run date" value={m.runDate} />
      <Row label="Gases" value={m.gases} />
      <Row label="Cooler" value={m.cooler} />
      <Row label="Cell constant" value={m.cellConstant} />
      <Row label="Sample interval" value={m.sampleInterval} />
      <Row label="Exo direction" value={m.exoDirection === "up" ? "Up (exo +)" : "Down (exo −)"} />
      <div className="pt-2">
        <span className="text-[11px] text-muted-foreground">Method program</span>
        {m.methodSteps.length > 0 ? (
          <ol className="mt-1 grid gap-0.5 text-xs text-foreground">
            {m.methodSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">—</p>
        )}
      </div>
    </div>
  );
}
