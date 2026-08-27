// Metadata panel: shows the selected run's instrument, operator, pan, gases,
// method program, sample mass, and run date — from `TgaMetadata`.

import type { TgaRunAnalyzed } from "@/lib/tga/store";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="w-28 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-xs text-foreground">{value || "—"}</span>
    </div>
  );
}

/** First / last finite value of a signal — the temperature and time the run
 *  actually started and finished at, which is not always what the method asked
 *  for (a run can be stopped early, or start from an ambient hold). */
function ends(arr: Float64Array): { first: number; last: number } | null {
  let first: number | null = null;
  let last: number | null = null;
  for (let i = 0; i < arr.length; i += 1) {
    if (Number.isFinite(arr[i])) {
      first = arr[i];
      break;
    }
  }
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(arr[i])) {
      last = arr[i];
      break;
    }
  }
  return first == null || last == null ? null : { first, last };
}

export function MetadataPanel({ run }: { run: TgaRunAnalyzed | null }) {
  if (!run) {
    return <p className="text-xs text-muted-foreground">Select a run to see its metadata.</p>;
  }
  const m = run.meta;
  const temp = ends(run.tempC);
  const time = ends(run.timeMin);
  return (
    <div className="grid gap-1">
      <Row label="Instrument" value={m.instrument} />
      <Row label="Operator" value={m.operator} />
      <Row label="Sample" value={m.sampleName} />
      <Row label="Sample mass" value={m.sampleSizeMg != null ? `${m.sampleSizeMg.toFixed(3)} mg` : ""} />
      <Row label="Start temp" value={temp ? `${temp.first.toFixed(2)} °C` : ""} />
      <Row label="Finish temp" value={temp ? `${temp.last.toFixed(2)} °C` : ""} />
      <Row
        label="Duration"
        value={time ? `${(time.last - time.first).toFixed(2)} min` : ""}
      />
      <Row label="Data points" value={run.tempC.length.toLocaleString()} />
      <Row label="Pan" value={m.pan} />
      <Row label="Gases" value={m.gases} />
      <Row label="Run date" value={m.runDate} />
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