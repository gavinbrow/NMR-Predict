import { Download, FileCode, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FigureData, FigureOptions } from "@/lib/ir/figure";
import { downloadFigurePng, downloadFigureSvg } from "@/lib/ir/figure-export";
import { FigureControls } from "./FigureControls";
import { FigureSvg } from "./FigureSvg";

interface FigureMakerProps {
  data: FigureData;
  options: FigureOptions;
  onChange: (next: FigureOptions) => void;
}

/** Checkerboard backdrop so a transparent figure background is visible. */
const CHECKER: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,#e2e8f0 25%,transparent 25%)," +
    "linear-gradient(-45deg,#e2e8f0 25%,transparent 25%)," +
    "linear-gradient(45deg,transparent 75%,#e2e8f0 75%)," +
    "linear-gradient(-45deg,transparent 75%,#e2e8f0 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
};

/**
 * The figure editor: live WYSIWYG preview + export bar on the left, the full
 * styling panel on the right. The preview SVG is the same component the
 * exporters render, so the saved file matches the screen exactly.
 */
export function FigureMaker({ data, options, onChange }: FigureMakerProps) {
  const [scale, setScale] = useState(2);
  const [busy, setBusy] = useState(false);
  const stem = data.sourceName ?? "figure";

  const exportSvg = async () => {
    setBusy(true);
    try {
      await downloadFigureSvg(data, options, `${stem}.svg`);
    } finally {
      setBusy(false);
    }
  };

  const exportPng = async () => {
    setBusy(true);
    try {
      await downloadFigurePng(data, options, scale, `${stem}_${scale}x.png`);
    } finally {
      setBusy(false);
    }
  };

  // Drag-zoom on the preview writes manual axis bounds; legend drags write a
  // custom legend position. Both live in `options`, so exports match the screen.
  const handleZoom = (next: { x?: { min: number; max: number }; y?: { min: number; max: number } }) =>
    onChange({
      ...options,
      x: next.x ? { ...options.x, min: next.x.min, max: next.x.max } : options.x,
      y: next.y ? { ...options.y, min: next.y.min, max: next.y.max } : options.y,
    });
  const handleLegendMove = (custom: { x: number; y: number }) =>
    onChange({ ...options, legend: { ...options.legend, custom } });
  const zoomed =
    options.x.min !== null ||
    options.x.max !== null ||
    options.y.min !== null ||
    options.y.max !== null;
  const resetZoom = () =>
    onChange({
      ...options,
      x: { ...options.x, min: null, max: null },
      y: { ...options.y, min: null, max: null },
    });

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-4">
        <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-card">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Drag across the plot to zoom (drag sideways for x-only) · drag the legend to move it.
            </p>
            <Button variant="ghost" size="sm" disabled={!zoomed} onClick={resetZoom}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Reset zoom
            </Button>
          </div>
          <div
            className="overflow-hidden rounded-lg"
            style={options.background === "transparent" ? CHECKER : undefined}
          >
            <FigureSvg
              data={data}
              options={options}
              interactive
              onZoom={handleZoom}
              onLegendMove={handleLegendMove}
              className="h-auto w-full"
            />
          </div>
        </div>

        <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Export</h3>
              <p className="text-xs text-muted-foreground">
                SVG is true vector · PNG saves at{" "}
                {Math.round(options.width * scale)}×{Math.round(options.height * scale)}px
                {options.background === "transparent" ? " with transparency" : ""}.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Select value={String(scale)} onValueChange={(v) => setScale(Number(v))}>
                <SelectTrigger className="h-9 w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4].map((s) => (
                    <SelectItem key={s} value={String(s)}>
                      {s}×
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" disabled={busy} onClick={exportSvg}>
                <FileCode className="mr-1.5 h-4 w-4" />
                SVG
              </Button>
              <Button size="sm" disabled={busy} onClick={exportPng}>
                <Download className="mr-1.5 h-4 w-4" />
                PNG
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* The styling panel scrolls on its own so reaching the bottom controls
          never means scrolling the whole page/dialog. */}
      <div className="min-w-0 xl:sticky xl:top-0 xl:max-h-[calc(100vh-7rem)] xl:overflow-y-auto xl:pr-1">
        <FigureControls data={data} options={options} onChange={onChange} />
      </div>
    </div>
  );
}
