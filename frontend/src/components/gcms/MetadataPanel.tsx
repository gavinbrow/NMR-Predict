import { AlertTriangle } from "lucide-react";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Separator } from "@/components/ui/separator";
import type { RunMeta } from "@/lib/gcms/types";

/**
 * The GC/MS metadata panel. Ports `src/components/gpc/MetadataPanel.tsx` to the
 * GC/MS {@link RunMeta} shape, keeping its definition-list row style. Rows are
 * OMITTED when the value is undefined/empty — never render "undefined".
 *
 * Sections:
 *  - Sample: sample, operator, acquired date, instrument, serial number,
 *    inlet, method.
 *  - Acquisition: IONIZATION (shown prominently as "CI" with the CI reagent
 *    gas when `meta.ionization === "CI"`), polarity, scan mode, low/high mass,
 *    threshold, solvent delay, run time, source temp, quad temp.
 *  - Scan segments: a small table of `meta.scanSegments` when present.
 *  - Oven program: initial temp then a table of `meta.ovenRamps`.
 *  - Tune: `meta.tune` fields, plus its `entries` list inside a
 *    CollapsibleSection.
 *  - Warnings: every string in `warnings` as amber text.
 *  - Raw method text: `meta.raw.acqmeth` / `.prePost` / `.cnorm` each inside
 *    its own CollapsibleSection as a `<pre>`, collapsed by default.
 */
interface MetadataPanelProps {
  meta: RunMeta;
  warnings: string[];
  runName: string;
}

export function MetadataPanel({ meta, warnings, runName }: MetadataPanelProps) {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-foreground">{runName}</h2>

      <Section title="Sample">
        <Row label="Sample" value={fmt(meta.sample)} />
        <Row label="Operator" value={fmt(meta.operator)} />
        <Row label="Acquired" value={fmt(meta.acquiredDate)} />
        <Row label="Instrument" value={fmt(meta.instrument)} />
        <Row label="Serial number" value={fmt(meta.serialNumber)} />
        <Row label="Inlet" value={fmt(meta.inlet)} />
        <Row label="Method" value={fmt(meta.method)} />
      </Section>

      <Separator />

      <Section title="Acquisition">
        {/* Ionization — show "CI" prominently with the reagent gas when CI. */}
        <Row
          label="Ionization"
          value={
            meta.ionization === "CI"
              ? `CI${meta.ciReagent ? ` (${meta.ciReagent})` : ""} — chemical ionisation`
              : fmt(meta.ionization)
          }
          emphasize={meta.ionization === "CI"}
        />
        <Row label="Polarity" value={fmt(meta.polarity)} />
        <Row label="Scan mode" value={fmt(meta.scanMode)} />
        <Row label="Low mass" value={fmtNum(meta.lowMass)} />
        <Row label="High mass" value={fmtNum(meta.highMass)} />
        <Row label="Threshold" value={fmtNum(meta.threshold)} />
        <Row label="Solvent delay (min)" value={fmtNum(meta.solventDelayMin)} />
        <Row label="Run time (min)" value={fmtNum(meta.runTimeMin)} />
        <Row label="Source temp (°C)" value={fmtNum(meta.sourceTemp)} />
        <Row label="Quad temp (°C)" value={fmtNum(meta.quadTemp)} />
      </Section>

      {meta.scanSegments && meta.scanSegments.length > 0 && (
        <>
          <Separator />
          <Section title="Scan segments">
            <div className="mt-1 overflow-auto rounded-md border border-border/60">
              <table className="w-full text-sm">
                <thead className="bg-card">
                  <tr>
                    <th className="h-7 px-2 text-left text-[11px] font-medium text-muted-foreground">Start</th>
                    <th className="h-7 px-2 text-left text-[11px] font-medium text-muted-foreground">Low m/z</th>
                    <th className="h-7 px-2 text-left text-[11px] font-medium text-muted-foreground">High m/z</th>
                  </tr>
                </thead>
                <tbody>
                  {meta.scanSegments.map((seg, i) => (
                    <tr key={i} className="h-7 border-b border-border/40 last:border-0">
                      <td className="px-2 font-mono text-xs">{seg.start}</td>
                      <td className="px-2 font-mono text-xs">{seg.lowMass}</td>
                      <td className="px-2 font-mono text-xs">{seg.highMass}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}

      {(meta.ovenInitialTempC != null || (meta.ovenRamps && meta.ovenRamps.length > 0)) && (
        <>
          <Separator />
          <Section title="Oven program">
            <Row label="Initial temp (°C)" value={fmtNum(meta.ovenInitialTempC)} />
            {meta.ovenRamps && meta.ovenRamps.length > 0 && (
              <div className="mt-1 overflow-auto rounded-md border border-border/60">
                <table className="w-full text-sm">
                  <thead className="bg-card">
                    <tr>
                      <th className="h-7 px-2 text-left text-[11px] font-medium text-muted-foreground">Rate (°C/min)</th>
                      <th className="h-7 px-2 text-left text-[11px] font-medium text-muted-foreground">Final (°C)</th>
                      <th className="h-7 px-2 text-left text-[11px] font-medium text-muted-foreground">Hold (min)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {meta.ovenRamps.map((ramp, i) => (
                      <tr key={i} className="h-7 border-b border-border/40 last:border-0">
                        <td className="px-2 font-mono text-xs">{ramp.rate}</td>
                        <td className="px-2 font-mono text-xs">{ramp.finalTemp}</td>
                        <td className="px-2 font-mono text-xs">{ramp.finalTime}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}

      {meta.tune && (
        <>
          <Separator />
          <Section title="Tune">
            <Row label="Tune file" value={fmt(meta.tune.tuneFile)} />
            <Row label="Tune date" value={fmt(meta.tune.tuneDate)} />
            <Row label="Emission current" value={fmtNum(meta.tune.emissionCurrent)} />
            <Row label="Electron energy" value={fmtNum(meta.tune.electronEnergy)} />
            <Row label="EM volts" value={fmtNum(meta.tune.emVolts)} />
            <Row label="Mass axis gain" value={fmtNum(meta.tune.massAxisGain)} />
            <Row label="Mass axis offset" value={fmtNum(meta.tune.massAxisOffset)} />
            {meta.tune.entries && meta.tune.entries.length > 0 && (
              <div className="mt-2">
                <CollapsibleSection title="Tune entries" defaultOpen={false} className="rounded-lg">
                  <div className="flex flex-col gap-0.5">
                    {meta.tune.entries.map((e, i) => (
                      <Row key={i} label={e.key} value={e.value} />
                    ))}
                  </div>
                </CollapsibleSection>
              </div>
            )}
          </Section>
        </>
      )}

      {warnings.length > 0 && <WarningList warnings={warnings} />}

      {meta.raw && (
        <>
          <Separator />
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Raw method text
            </h3>
            {meta.raw.acqmeth && (
              <CollapsibleSection title="acqmeth" defaultOpen={false} className="rounded-lg">
                <pre className="text-[10px] whitespace-pre-wrap text-muted-foreground">{meta.raw.acqmeth}</pre>
              </CollapsibleSection>
            )}
            {meta.raw.prePost && (
              <CollapsibleSection title="pre/post" defaultOpen={false} className="rounded-lg">
                <pre className="text-[10px] whitespace-pre-wrap text-muted-foreground">{meta.raw.prePost}</pre>
              </CollapsibleSection>
            )}
            {meta.raw.cnorm && (
              <CollapsibleSection title="cnorm" defaultOpen={false} className="rounded-lg">
                <pre className="text-[10px] whitespace-pre-wrap text-muted-foreground">{meta.raw.cnorm}</pre>
              </CollapsibleSection>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function fmt(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  return String(v);
}

function fmtNum(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return String(v);
}

function Row({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  // Rows with no real value are omitted entirely — never render "undefined".
  if (value === "—" || value === "undefined") return null;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={[
          "truncate text-right font-mono text-foreground",
          emphasize ? "font-semibold text-primary" : "",
        ].join(" ")}
      >
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  // Don't render a section whose every row was omitted.
  const hasChildren = Array.isArray(children)
    ? children.some((c) => c != null && c !== false)
    : children != null;
  if (!hasChildren) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{title}</h3>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function WarningList({ warnings }: { warnings: string[] }) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-[11px]">
      <p className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-500">
        <AlertTriangle className="h-3.5 w-3.5" />
        {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
      </p>
      <ul className="mt-1.5 space-y-0.5">
        {warnings.map((w, i) => (
          <li key={i} className="break-words text-amber-600 dark:text-amber-500">
            {w}
          </li>
        ))}
      </ul>
    </div>
  );
}