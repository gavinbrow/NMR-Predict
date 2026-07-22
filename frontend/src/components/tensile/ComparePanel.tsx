import { BarChart3, Download, GitCompare, ScatterChart as ScatterIcon, Spline } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BarErrorChart,
  DistributionChart,
  OverlaidCurvesChart,
  ScatterCompareChart,
} from "@/components/tensile/charts";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { downloadChartPng, downloadChartSvg } from "@/lib/tensile/chart-image";
import { buildBars, buildCurves, buildDistribution, buildScatter } from "@/lib/tensile/compare";
import { PROPERTY_META } from "@/lib/tensile/compute";
import { propertyLabel, propertyUnit } from "@/lib/tensile/format";
import { useTensileStore } from "@/lib/tensile/store";
import type { PropertyKey, Specimen } from "@/lib/tensile/types";

type View = "curves" | "bar" | "scatter" | "distribution";

/** A compact property dropdown reused for the bar/distribution/scatter axes. */
function PropertySelect({
  value,
  onChange,
  width = "w-[210px]",
}: {
  value: PropertyKey;
  onChange: (k: PropertyKey) => void;
  width?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as PropertyKey)}>
      <SelectTrigger className={`h-8 text-xs ${width}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PROPERTY_META.map((m) => (
          <SelectItem key={m.key} value={m.key} className="text-xs">
            {m.label} ({m.unit})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The Phase 7 compare workspace: four views (overlaid curves, mean ± SD bars,
 * property-vs-property scatter, and a per-material distribution) over a shared
 * selection. Selecting materials/specimens elsewhere filters every view; the
 * focused property (shared with the summary) drives the bar and distribution
 * views. Each figure can be downloaded as PNG or SVG.
 */
export function ComparePanel() {
  const { specimens, materialViews, selection, params, setProperty } = useTensileStore();
  const [view, setView] = useState<View>("curves");
  const [showPoints, setShowPoints] = useState(true);
  const [xKey, setXKey] = useState<PropertyKey>("E_MPa");
  const [yKey, setYKey] = useState<PropertyKey>("toughness");
  const chartRef = useRef<HTMLDivElement>(null);

  const property = selection.property;

  // Which materials/specimens are in scope, honoring the shared selection.
  const shownMaterials = useMemo(() => {
    if (selection.materialIds.length === 0) return materialViews;
    const set = new Set(selection.materialIds);
    return materialViews.filter((m) => set.has(m.id));
  }, [materialViews, selection.materialIds]);

  const shownSpecimens = useMemo<Specimen[]>(() => {
    if (selection.specimenIds.length > 0) {
      const set = new Set(selection.specimenIds);
      return specimens.filter((s) => set.has(s.id));
    }
    const ids = new Set(shownMaterials.flatMap((m) => m.specimenIds));
    return specimens.filter((s) => ids.has(s.id));
  }, [specimens, shownMaterials, selection.specimenIds]);

  const curves = useMemo(() => {
    // Lower the per-curve point budget as more curves are overlaid, to keep the
    // chart responsive with a lot of data loaded.
    const cap = shownSpecimens.length > 24 ? 120 : shownSpecimens.length > 12 ? 200 : 400;
    return buildCurves(materialViews, shownSpecimens, params, cap);
  }, [materialViews, shownSpecimens, params]);
  const bars = useMemo(() => buildBars(shownMaterials, property), [shownMaterials, property]);
  const scatter = useMemo(
    () => buildScatter(shownMaterials, xKey, yKey),
    [shownMaterials, xKey, yKey],
  );
  const dist = useMemo(
    () => buildDistribution(shownMaterials, property),
    [shownMaterials, property],
  );

  const download = async (kind: "png" | "svg") => {
    const stem = `tensile_${view}${view === "scatter" ? `_${xKey}_vs_${yKey}` : `_${property}`}`;
    try {
      if (kind === "png") await downloadChartPng(chartRef.current, `${stem}.png`);
      else downloadChartSvg(chartRef.current, `${stem}.svg`);
    } catch (err) {
      toast.error("Could not export the figure", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const empty = curves.length === 0 && shownMaterials.length === 0;

  const downloadMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1 text-xs">
          <Download className="h-3.5 w-3.5" />
          This figure
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => download("png")}>Download PNG</DropdownMenuItem>
        <DropdownMenuItem onClick={() => download("svg")}>Download SVG</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <CollapsibleSection
      title="Compare"
      icon={GitCompare}
      headerRight={downloadMenu}
      contentClassName="flex flex-col gap-3"
    >
      <Tabs value={view} onValueChange={(v) => setView(v as View)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList className="h-9">
            <TabsTrigger value="curves" className="gap-1 text-xs">
              <Spline className="h-3.5 w-3.5" /> Curves
            </TabsTrigger>
            <TabsTrigger value="bar" className="gap-1 text-xs">
              <BarChart3 className="h-3.5 w-3.5" /> Bar ± SD
            </TabsTrigger>
            <TabsTrigger value="scatter" className="gap-1 text-xs">
              <ScatterIcon className="h-3.5 w-3.5" /> Scatter
            </TabsTrigger>
            <TabsTrigger value="distribution" className="gap-1 text-xs">
              Distribution
            </TabsTrigger>
          </TabsList>

          {/* Per-view controls. */}
          {view === "scatter" ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">X</span>
              <PropertySelect value={xKey} onChange={setXKey} width="w-[180px]" />
              <span className="text-xs text-muted-foreground">Y</span>
              <PropertySelect value={yKey} onChange={setYKey} width="w-[180px]" />
            </div>
          ) : view === "curves" ? (
            <span className="text-xs text-muted-foreground">
              {curves.length} curve{curves.length === 1 ? "" : "s"}
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <PropertySelect value={property} onChange={setProperty} />
              {view === "bar" && (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox
                    checked={showPoints}
                    onCheckedChange={(c) => setShowPoints(c === true)}
                  />
                  points
                </label>
              )}
            </div>
          )}
        </div>

        <div ref={chartRef} className="mt-3 h-[380px]">
          {empty ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Nothing selected to compare.
            </div>
          ) : (
            <>
              <TabsContent value="curves" className="m-0 h-full">
                <OverlaidCurvesChart series={curves} />
              </TabsContent>
              <TabsContent value="bar" className="m-0 h-full">
                <BarErrorChart data={bars} unit={propertyUnit(property)} showPoints={showPoints} />
              </TabsContent>
              <TabsContent value="scatter" className="m-0 h-full">
                <ScatterCompareChart
                  points={scatter}
                  xLabel={propertyLabel(xKey)}
                  yLabel={propertyLabel(yKey)}
                />
              </TabsContent>
              <TabsContent value="distribution" className="m-0 h-full">
                <DistributionChart data={dist} unit={propertyUnit(property)} />
              </TabsContent>
            </>
          )}
        </div>
      </Tabs>
    </CollapsibleSection>
  );
}
