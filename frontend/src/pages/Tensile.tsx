import { BarChart3, FileSpreadsheet, Layers, Spline, Sliders, Table2, Trash2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { CollapsibleSection } from "@/components/tensile/CollapsibleSection";
import { ComparePanel } from "@/components/tensile/ComparePanel";
import { ExportMenu } from "@/components/tensile/ExportMenu";
import { FileCard } from "@/components/tensile/FileCard";
import { FileDropzone } from "@/components/tensile/FileDropzone";
import { MaterialsPanel } from "@/components/tensile/MaterialsPanel";
import { ParamControls } from "@/components/tensile/ParamControls";
import { SpecimenTable } from "@/components/tensile/SpecimenTable";
import { StressStrainChart } from "@/components/tensile/StressStrainChart";
import { SummaryPanel } from "@/components/tensile/SummaryPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TensileProvider, useTensileStore } from "@/lib/tensile/store";

/** A single capability tile shown on the empty Tensile workspace. */
function CapabilityTile({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: typeof Spline;
  title: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
        <Icon className="h-5 w-5 text-primary" />
      </div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}

/** Empty state: hero blurb + the big dropzone + capability tiles. */
function EmptyWorkspace() {
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
      <section className="rounded-3xl border border-border/70 bg-card p-5 shadow-card">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">
          Tensile analysis
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
          Tensile property extraction & comparison
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Drop zwickRoell / Instron tensile Excel exports and read the standard mechanical
          properties — Young&apos;s modulus, tensile strength, yield, elongation and toughness —
          recomputed in your browser. Compare multiple files side-by-side, tune the analysis
          parameters live, and group specimens into materials. Nothing leaves your machine.
        </p>
      </section>

      <Card className="border-border/70 shadow-card">
        <CardContent className="flex flex-col gap-6 px-6 py-8">
          <FileDropzone />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <CapabilityTile
              icon={Spline}
              title="Find the values"
              description="Per-specimen modulus, UTS, yield, elongation and toughness, recomputed locally."
            />
            <CapabilityTile
              icon={Layers}
              title="Compare files"
              description="Load several workbooks at once and group specimens into named materials."
            />
            <CapabilityTile
              icon={Sliders}
              title="Tune live"
              description="Drag the modulus window and yield parameters; everything recomputes instantly."
            />
            <CapabilityTile
              icon={BarChart3}
              title="Organize"
              description="A sortable, filterable specimen table with live mean ± SD per material."
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** The populated workspace: files + params + materials on the left, chart + table on the right. */
function PopulatedWorkspace() {
  const { files } = useTensileStore();

  return (
    <div className="mx-auto flex w-full max-w-[1700px] flex-col gap-4 lg:flex-row">
      {/* Left rail */}
      <aside className="flex w-full flex-col gap-4 lg:w-[340px] lg:shrink-0">
        <CollapsibleSection
          title="Files"
          icon={FileSpreadsheet}
          count={files.length}
          contentClassName="flex flex-col gap-3"
        >
          <FileDropzone compact />
          <div className="flex flex-col gap-2">
            {files.map((f) => (
              <FileCard key={f.id} file={f} />
            ))}
          </div>
        </CollapsibleSection>

        <ParamControls />

        <MaterialsPanel />
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <SummaryPanel />

        <CollapsibleSection title="Stress–strain curves" icon={Spline}>
          <div className="h-[420px]">
            <StressStrainChart />
          </div>
        </CollapsibleSection>

        <ComparePanel />

        <CollapsibleSection title="Per-specimen properties" icon={Table2}>
          <SpecimenTable />
        </CollapsibleSection>
      </div>
    </div>
  );
}

/** Header accessory: counts + clear-all, only meaningful once data is loaded. */
function HeaderAccessory() {
  const { hasData, files, specimens, materialViews, clearAll } = useTensileStore();
  if (!hasData) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 font-medium text-success">
        <FileSpreadsheet className="h-3 w-3" />
        Local tensile workspace
      </span>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground">
        {files.length} file{files.length === 1 ? "" : "s"} · {specimens.length} specimens ·{" "}
        {materialViews.length} material{materialViews.length === 1 ? "" : "s"}
      </span>
      <ExportMenu />
      <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={clearAll}>
        <Trash2 className="h-3 w-3" />
        Clear all
      </Button>
    </div>
  );
}

function TensileWorkspace() {
  const { hasData } = useTensileStore();
  return (
    <AppShell headerAccessory={<HeaderAccessory />} mainClassName="px-4 py-5 sm:px-6">
      {hasData ? <PopulatedWorkspace /> : <EmptyWorkspace />}
    </AppShell>
  );
}

/**
 * Tensile analysis workspace. Phases 0–1 ship the tab and the parser; Phases 2–6
 * add the compute engine, the store, the multi-file upload flow, the
 * organize/sort UI, and live parameter tuning. The provider lives here so the
 * whole store survives tab switches via the app's keep-alive routing.
 */
const Tensile = () => (
  <TensileProvider>
    <TensileWorkspace />
  </TensileProvider>
);

export default Tensile;
