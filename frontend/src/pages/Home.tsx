import { Activity, ArrowRight, BarChart3, FlaskConical, LineChart, Sparkles, Waves } from "lucide-react";
import { Link } from "react-router-dom";
import { AppShell } from "@/components/AppShell";

function WorkspaceCard({
  description,
  eyebrow,
  href,
  icon: Icon,
  title,
}: {
  description: string;
  eyebrow: string;
  href: string;
  icon: typeof LineChart;
  title: string;
}) {
  return (
    <Link
      to={href}
      className="group relative overflow-hidden rounded-3xl border border-border/70 bg-card p-7 text-left shadow-card transition-smooth hover:-translate-y-1 hover:border-primary/40 hover:shadow-elegant focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="absolute -right-16 -top-16 h-44 w-44 rounded-full bg-primary/10 blur-2xl transition-smooth group-hover:bg-primary/20" />
      <div className="relative">
        <div className="mb-8 flex items-center justify-between">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-primary shadow-elegant">
            <Icon className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="rounded-full border border-border/70 bg-background/80 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {eyebrow}
          </span>
        </div>

        <h2 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">{description}</p>

        <div className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-primary">
          Open workspace
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </div>
      </div>
    </Link>
  );
}

const Home = () => {
  return (
    <AppShell mainClassName="container py-10">
      <section className="relative overflow-hidden rounded-[2rem] border border-border/70 bg-card px-6 py-12 shadow-card sm:px-10 lg:px-14">
        <div className="absolute inset-0 bg-gradient-spectrum" />
        <div className="absolute -right-24 top-10 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-28 left-16 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />

        <div className="relative max-w-3xl">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1 text-xs font-semibold text-primary shadow-sm">
            <Sparkles className="h-3.5 w-3.5" />
            Local-first NMR workflow
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Pick the NMR workspace you need.
          </h1>
          <p className="mt-5 text-base leading-7 text-muted-foreground sm:text-lg">
            Use spectrum analysis for local NMRium review and processing, or jump into
            prediction to draw molecules, run models, and compare predicted spectra.
          </p>
        </div>
      </section>

      <section className="mt-8 grid gap-5 sm:grid-cols-2">
        <WorkspaceCard
          href="/analysis"
          icon={LineChart}
          eyebrow="NMRium"
          title="Spectrum analysis"
          description="Open a local NMRium workspace for loading, inspecting, processing, and exporting spectra directly in the browser."
        />
        <WorkspaceCard
          href="/prediction"
          icon={FlaskConical}
          eyebrow="Models"
          title="Prediction"
          description="Draw molecules, choose prediction engines, compare overlays, and link atoms to predicted peaks."
        />
        <WorkspaceCard
          href="/kinetics"
          icon={Activity}
          eyebrow="Kinetics"
          title="NMR Kinetics"
          description="Load a time-series of spectra, integrate tracked peaks, and fit growth/decay curves to extract rate constants and half-lives."
        />
        <WorkspaceCard
          href="/maldi"
          icon={BarChart3}
          eyebrow="Mass spec"
          title="MALDI interpretation"
          description="Import a MALDI spectrum, pick peaks, detect polymer repeat units, and assign oligomer series — all in the browser."
        />
        <WorkspaceCard
          href="/ir"
          icon={Waves}
          eyebrow="Infrared"
          title="IR Kinetics"
          description="Read Shimadzu IRAffinity-1S .ispd files, overlay and export spectra, and track an IR peak's disappearance over time to fit reaction kinetics."
        />
      </section>
    </AppShell>
  );
};

export default Home;
