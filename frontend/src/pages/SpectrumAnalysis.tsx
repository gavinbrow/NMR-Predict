import initNmriumCore from "@zakodium/nmrium-core-plugins";
import { DatabaseZap, FileUp, HardDrive, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { NMRium } from "nmrium";
import { AppShell } from "@/components/AppShell";

function FeaturePill({
  children,
  icon: Icon,
}: {
  children: string;
  icon: typeof FileUp;
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm">
      <Icon className="h-3.5 w-3.5 text-primary" />
      {children}
    </span>
  );
}

const SpectrumAnalysis = () => {
  const core = useMemo(() => initNmriumCore(), []);

  return (
    <AppShell
      headerAccessory={
        <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 font-medium text-success">
          <HardDrive className="h-3 w-3" />
          Local NMRium workspace
        </span>
      }
      mainClassName="px-4 py-5 sm:px-6"
    >
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <section className="rounded-3xl border border-border/70 bg-card p-5 shadow-card">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">
                Spectrum analysis
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                Local NMRium
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                Drop supported NMR data files into the workspace below, process them locally,
                and export when you are ready. Nothing here needs the prediction backend.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <FeaturePill icon={FileUp}>Drag and drop spectra</FeaturePill>
              <FeaturePill icon={DatabaseZap}>Process in-browser</FeaturePill>
              <FeaturePill icon={ShieldCheck}>Local workspace</FeaturePill>
            </div>
          </div>
        </section>

        <section className="h-[calc(100vh-245px)] min-h-[640px] overflow-hidden rounded-3xl border border-border/70 bg-white shadow-card">
          <NMRium
            core={core}
            emptyText={
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                  <FileUp className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Drop NMR files here to start analysis.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    NMRium will keep this workspace local in your browser session.
                  </p>
                </div>
              </div>
            }
          />
        </section>
      </div>
    </AppShell>
  );
};

export default SpectrumAnalysis;
