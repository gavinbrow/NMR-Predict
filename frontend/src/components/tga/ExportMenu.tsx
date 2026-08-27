// The TGA workspace's export menu: CSVs of the processed curves / summary /
// steps, a full Excel workbook with two native editable charts, a PDF report,
// and the `.tgaproj` project file (which can be opened again from here).
//
// The Excel and PDF exports embed the publication figure exactly as the user
// styled it — the page passes the same `FigureData`/`FigureOptions` the Figure
// tab renders, and it's rasterized off-screen at full resolution, so the report
// matches the preview regardless of which tab is on screen.

import { Download, FileSpreadsheet, FileText, FolderOpen, Loader2, Save, Table2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { figurePngDataUrl } from "@/lib/ir/figure-export";
import type { FigureData, FigureOptions } from "@/lib/ir/figure";
import { buildSummaryRows, tgaMetrics } from "@/lib/tga/compare";
import {
  deserializeTgaProject,
  downloadCurvesCsv,
  downloadSummaryCsv,
  downloadTgaProject,
  exportTgaExcel,
  exportTgaReportPdf,
  toCsv,
  buildStepsCsvRows,
} from "@/lib/tga/export";
import { triggerDownload } from "@/lib/ir/export";
import { useTgaStore } from "@/lib/tga/store";

/** How long to wait for the off-screen figure raster before exporting without
 *  it. See {@link ExportMenu}'s `captureFigure`. */
const FIGURE_RASTER_TIMEOUT_MS = 10_000;

export function ExportMenu({
  figureData,
  figureOptions,
  onFigureOptionsRestored,
}: {
  figureData: FigureData;
  figureOptions: FigureOptions;
  /** Called with the figure options a `.tgaproj` carried, so the host can
   *  restore the exact styling the project was saved with. */
  onFigureOptionsRestored: (options: FigureOptions | null) => void;
}) {
  const { runs, materials, params, rawState, loadProject } = useTgaStore();
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const visibleRuns = runs.filter((r) => r.visible);
  const exportRuns = visibleRuns.length > 0 ? visibleRuns : runs;
  const metrics = tgaMetrics(params.tdThresholds);
  const baseName = exportRuns[0]?.fileName.replace(/\.[^.]+$/, "") || "tga";

  /**
   * Rasterize the current figure. Failure is non-fatal — the report is still
   * worth having without the picture, so report and continue.
   *
   * Bounded, because the rasterizer settles by awaiting two animation frames
   * and a background tab delivers none: without the race, switching tabs while
   * a workbook is building leaves the export hanging on a spinner until the
   * page is looked at again. Ten seconds is far longer than a real raster takes.
   */
  const captureFigure = async (): Promise<string | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        figurePngDataUrl(figureData, figureOptions, 2),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), FIGURE_RASTER_TIMEOUT_MS);
        }),
      ]).then((png) => {
        if (png == null) {
          toast.warning("Exported without the figure", {
            description:
              "The figure didn't finish rendering — it only draws while the page is visible. Stay on this tab and export again to include it.",
          });
        }
        return png;
      });
    } catch (err) {
      toast.warning("Couldn't render the figure for the report", {
        description: err instanceof Error ? err.message : undefined,
      });
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const run = async (label: string, fn: () => void | Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(`${label} failed`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const openProject = (file: File) => {
    void run("Opening the project", async () => {
      const text = await file.text();
      const { state, figureOptions: saved } = deserializeTgaProject(text);
      loadProject(state);
      onFigureOptionsRestored(saved);
      toast.success(`Opened ${file.name}`, {
        description: `${state.runs.length} run(s), ${state.materials.length} material(s).`,
      });
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" disabled={busy}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            Export
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-xs">Report</DropdownMenuLabel>
          <DropdownMenuItem
            className="text-xs"
            onClick={() =>
              run("Excel export", async () => {
                const figurePng = await captureFigure();
                await exportTgaExcel({
                  runs: exportRuns,
                  materials,
                  params,
                  figurePng,
                  baseName,
                });
              })
            }
          >
            <FileSpreadsheet className="mr-2 h-3.5 w-3.5" />
            Excel workbook (+ charts)
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-xs"
            onClick={() =>
              run("PDF export", async () => {
                const figurePng = await captureFigure();
                exportTgaReportPdf({
                  runs: exportRuns,
                  materials,
                  params,
                  figurePng,
                  projectName: baseName,
                });
              })
            }
          >
            <FileText className="mr-2 h-3.5 w-3.5" />
            PDF report
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs">Tables (CSV)</DropdownMenuLabel>
          <DropdownMenuItem
            className="text-xs"
            onClick={() => run("Curves CSV", () => downloadCurvesCsv(exportRuns, baseName))}
          >
            <Table2 className="mr-2 h-3.5 w-3.5" />
            Processed curves
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-xs"
            onClick={() =>
              run("Summary CSV", () =>
                downloadSummaryCsv(
                  buildSummaryRows(exportRuns, materials, metrics),
                  metrics,
                  baseName,
                ),
              )
            }
          >
            <Table2 className="mr-2 h-3.5 w-3.5" />
            Summary table
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-xs"
            onClick={() =>
              run("Steps CSV", () =>
                triggerDownload(
                  new Blob([toCsv(buildStepsCsvRows(exportRuns))], {
                    type: "text/csv;charset=utf-8",
                  }),
                  `${baseName}-steps.csv`,
                ),
              )
            }
          >
            <Table2 className="mr-2 h-3.5 w-3.5" />
            Degradation steps
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs">Project</DropdownMenuLabel>
          <DropdownMenuItem
            className="text-xs"
            onClick={() =>
              run("Project save", () => downloadTgaProject(rawState, figureOptions, baseName))
            }
          >
            <Save className="mr-2 h-3.5 w-3.5" />
            Save .tgaproj
          </DropdownMenuItem>
          <DropdownMenuItem className="text-xs" onClick={() => fileInputRef.current?.click()}>
            <FolderOpen className="mr-2 h-3.5 w-3.5" />
            Open .tgaproj…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInputRef}
        type="file"
        accept=".tgaproj,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset first, so re-picking the same file fires change again.
          e.target.value = "";
          if (file) openProject(file);
        }}
      />
    </>
  );
}
