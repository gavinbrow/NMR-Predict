import { Download, FileSpreadsheet, FileText, Loader2, Table2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  BarErrorChart,
  DistributionChart,
  OverlaidCurvesChart,
  ScatterCompareChart,
} from "@/components/tensile/charts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { renderElementToPng } from "@/lib/tensile/chart-image";
import { buildBars, buildCurves, buildDistribution, buildScatter } from "@/lib/tensile/compare";
import {
  downloadExcel,
  downloadPdf,
  downloadSpecimensCsv,
  downloadSummaryCsv,
  type ExportFigure,
  type ExportInput,
} from "@/lib/tensile/export";
import { propertyLabel, propertyUnit } from "@/lib/tensile/format";
import { useTensileStore } from "@/lib/tensile/store";

const FIG_W = 760;
const FIG_H = 380;

/**
 * The export menu (Phase 9): one-click full Excel workbook and PDF report, plus
 * per-table CSV downloads. The PDF/Excel embed the four compare figures, which
 * are rasterized off-screen so they're captured regardless of which compare tab
 * is on screen. Everything is generated client-side.
 */
export function ExportMenu() {
  const { files, specimens, materialViews, params, selection } = useTensileStore();
  const [busy, setBusy] = useState(false);

  const input: ExportInput = {
    files,
    specimens,
    materials: materialViews,
    params,
  };

  /** Rasterize the four compare views for the report. */
  const captureFigures = async (): Promise<ExportFigure[]> => {
    const property = selection.property;
    const curves = buildCurves(materialViews, specimens, params);
    const bars = buildBars(materialViews, property);
    const scatter = buildScatter(materialViews, "E_MPa", "toughness");
    const dist = buildDistribution(materialViews, property);

    const jobs: { title: string; element: React.ReactElement }[] = [
      {
        title: "Overlaid stress–strain curves",
        element: <OverlaidCurvesChart series={curves} width={FIG_W} height={FIG_H} />,
      },
      {
        title: `${propertyLabel(property)} — mean ± SD by material`,
        element: (
          <BarErrorChart data={bars} unit={propertyUnit(property)} showPoints width={FIG_W} height={FIG_H} />
        ),
      },
      {
        title: `${propertyLabel("E_MPa")} vs ${propertyLabel("toughness")}`,
        element: (
          <ScatterCompareChart
            points={scatter}
            xLabel={propertyLabel("E_MPa")}
            yLabel={propertyLabel("toughness")}
            width={FIG_W}
            height={FIG_H}
          />
        ),
      },
      {
        title: `${propertyLabel(property)} — distribution by material`,
        element: <DistributionChart data={dist} unit={propertyUnit(property)} width={FIG_W} height={FIG_H} />,
      },
    ];

    const figures: ExportFigure[] = [];
    for (const job of jobs) {
      let png = "";
      try {
        png = await renderElementToPng(job.element, FIG_W, FIG_H, 2);
      } catch {
        png = "";
      }
      figures.push({ title: job.title, png });
    }
    return figures;
  };

  const run = async (kind: "excel" | "pdf" | "specimens-csv" | "summary-csv") => {
    if (specimens.length === 0) {
      toast.warning("Nothing to export yet", { description: "Load a file first." });
      return;
    }
    setBusy(true);
    try {
      if (kind === "specimens-csv") {
        downloadSpecimensCsv(input);
      } else if (kind === "summary-csv") {
        downloadSummaryCsv(input);
      } else {
        const figures = await captureFigures();
        if (kind === "excel") await downloadExcel(input, figures);
        else downloadPdf(input, figures);
      }
      toast.success("Export ready");
    } catch (err) {
      toast.error("Export failed", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" disabled={busy}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Full report</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => run("excel")}>
          <FileSpreadsheet className="mr-2 h-4 w-4" />
          Excel workbook
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => run("pdf")}>
          <FileText className="mr-2 h-4 w-4" />
          PDF report
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Tables</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => run("specimens-csv")}>
          <Table2 className="mr-2 h-4 w-4" />
          Specimens CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => run("summary-csv")}>
          <Table2 className="mr-2 h-4 w-4" />
          Summary CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
