import { Download, FileCode, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fitFigureBox } from "@/lib/ir/figure";
import type { FigureData, FigureOptions, PeakLabelOverride } from "@/lib/ir/figure";
import { downloadFigurePng, downloadFigureSvg, pngExportSize } from "@/lib/ir/figure-export";
import { FigureControls } from "./FigureControls";
import { FigureSvg } from "./FigureSvg";

/** PNG export scale multipliers (WP5e). */
const SCALE_MULTIPLIERS = [1, 2, 3, 4, 6, 8, 10];
/** Print-DPI presets. The figure's px width is treated as inches at 96 dpi, so a
 *  target of D dpi is simply a D/96 scale (independent of the figure size). */
const DPI_PRESETS = [150, 300, 600];
const DPI_BASE = 96;

interface FigureMakerProps {
  data: FigureData;
  options: FigureOptions;
  onChange: (next: FigureOptions) => void;
  /**
   * MS-only figure-only delete, forwarded to the selected-label editor as
   * "Delete peak from figure". A MALDI host wires it to drop the peak's stick +
   * label from the figure (the peak stays in the Peak table / exports). Absent
   * for IR/Kinetics, so no delete control appears there. (WP6b)
   */
  onDeletePeak?: (id: string) => void;
  /**
   * MS-only: whether the host is drawing the picked peaks as sticks. Passed down
   * so the toggle can live in the controls panel's "Peaks & labels" section
   * alongside everything else about the peaks, even though the host owns it.
   */
  showSticks?: boolean;
  onShowSticksChange?: (v: boolean) => void;
  /** MS-only: set (`color`) or clear (`null`) one peak's own colour in the host's
   *  peak model. Enables the per-peak swatches in the label list. */
  onSetPeakColor?: (id: string, color: string | null) => void;
  /**
   * Offer the fullscreen toggle. Defaults to true — the inline hosts (MALDI,
   * GC/MS) want it. {@link FigurePopout} passes false: it already IS a
   * near-fullscreen dialog, and a second overlay escaping that dialog's DOM
   * would fight its focus trap.
   */
  allowFullscreen?: boolean;
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

const PREVIEW_HINT =
  "Scroll over the plot to scale both y-axes, or over one axis to scale just that one · drag to zoom in · double-click to reset · drag the legend to move it.";

/**
 * The figure editor: live WYSIWYG preview + export bar on the left, the full
 * styling panel on the right. The preview SVG is the same component the
 * exporters render, so the saved file matches the screen exactly.
 *
 * Fullscreen keeps that same split — preview left, controls right — but hands
 * the preview the whole viewport instead of a column of the page, which is the
 * only way to inspect a dense spectrum's labels while still reaching the
 * control that fixes them.
 */
export function FigureMaker({
  data,
  options,
  onChange,
  onDeletePeak,
  showSticks,
  onShowSticksChange,
  onSetPeakColor,
  allowFullscreen = true,
}: FigureMakerProps) {
  const scale = options.pngScale ?? 2;
  const setScale = (next: number) => onChange({ ...options, pngScale: next });
  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const stem = data.sourceName ?? "figure";

  // The selected peak label (MS figures only): FigureSvg draws its ring and
  // FigureControls shows its placement editor. Transient preview state — losing
  // it on a tab switch is fine; the placement it edits lives in `options`.
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(null);
  // Drawn-vs-thinned label counts, reported up from the renderer so the controls
  // can surface "N labels hidden". Guarded so equal counts don't loop renders.
  const [labelStats, setLabelStats] = useState({ shown: 0, hiddenByThinning: 0 });
  const handleLabelStats = useCallback(
    (s: { shown: number; hiddenByThinning: number }) =>
      setLabelStats((prev) =>
        prev.shown === s.shown && prev.hiddenByThinning === s.hiddenByThinning ? prev : s,
      ),
    [],
  );

  // Fullscreen sizes the preview to the space it has, and it has to do so in JS
  // rather than in CSS — see `fitFigureBox` for why `max-height` on an inline
  // <svg> is not enough.
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const [previewBox, setPreviewBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!fullscreen) return;
    const el = previewBoxRef.current;
    if (!el) return;
    // Measure once up front rather than waiting for the observer's first call:
    // a ResizeObserver is suspended while the tab is hidden, and a figure that
    // renders at 0×0 until the tab is looked at is worse than no fullscreen.
    const measure = () => {
      const r = el.getBoundingClientRect();
      setPreviewBox((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    // A background tab delivers neither resize events nor ResizeObserver
    // callbacks, so a window resized while this tab was hidden would leave the
    // preview at its old size. Re-measure the moment it is looked at again.
    document.addEventListener("visibilitychange", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("visibilitychange", measure);
    };
  }, [fullscreen]);

  // The export is unaffected by any of this; it renders from `options.width`
  // and `options.height`, not from what the preview happens to be scaled to.
  const fitted = fitFigureBox(previewBox, options);

  // Escape leaves fullscreen, and the page behind it must not scroll under the
  // overlay. Escape is *shared* with every Radix popup the controls open, and
  // those do not stop the event: without the popper check, dismissing a Select
  // would also throw the user out of fullscreen.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[data-radix-popper-content-wrapper]")) return;
      setFullscreen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);

  // A label was dragged: write its px nudge into the figure-only override map
  // (through `onChange`, so it survives export and tab switches). Same pattern as
  // the legend drag below.
  const handleLabelMove = (id: string, offset: { dx: number; dy: number }) => {
    const prev = options.peakLabels.overrides[id] ?? {};
    const next: PeakLabelOverride = {
      ...prev,
      dx: Math.round(offset.dx * 10) / 10,
      dy: Math.round(offset.dy * 10) / 10,
    };
    onChange({
      ...options,
      peakLabels: {
        ...options.peakLabels,
        overrides: { ...options.peakLabels.overrides, [id]: next },
      },
    });
  };

  // Resolved PNG output size + whether it fits the browser canvas limits.
  const png = pngExportSize(options.width, options.height, scale);
  const dpiMatch = DPI_PRESETS.find((d) => d / DPI_BASE === scale);
  const scaleSuffix = dpiMatch ? `${dpiMatch}dpi` : `${scale}x`;

  const exportSvg = async () => {
    setBusy(true);
    try {
      await downloadFigureSvg(data, options, `${stem}.svg`);
    } finally {
      setBusy(false);
    }
  };

  const exportPng = async () => {
    if (!png.ok) return;
    setBusy(true);
    try {
      await downloadFigurePng(data, options, scale, `${stem}_${scaleSuffix}.png`);
    } finally {
      setBusy(false);
    }
  };

  // Drag-zoom on the preview writes manual axis bounds; legend drags write a
  // custom legend position. Both live in `options`, so exports match the screen.
  // Drag-zoom acts on the primary x and y only — a box drawn over the plot has
  // no sensible reading on a second, independent y-scale. Wheel-scale does
  // reach y2: over the plot it scales both axes together, over a gutter only
  // that axis (see `FigureSvg`'s wheel handler).
  const handleZoom = (next: {
    x?: { min: number; max: number };
    y?: { min: number; max: number };
    y2?: { min: number; max: number };
  }) =>
    onChange({
      ...options,
      x: next.x ? { ...options.x, min: next.x.min, max: next.x.max } : options.x,
      y: next.y ? { ...options.y, min: next.y.min, max: next.y.max } : options.y,
      y2:
        next.y2 && options.y2
          ? { ...options.y2, min: next.y2.min, max: next.y2.max }
          : options.y2,
    });
  const handleLegendMove = (custom: { x: number; y: number }) =>
    onChange({ ...options, legend: { ...options.legend, custom } });
  const zoomed =
    options.x.min !== null ||
    options.x.max !== null ||
    options.y.min !== null ||
    options.y.max !== null ||
    (options.y2 != null && (options.y2.min !== null || options.y2.max !== null));
  const resetZoom = () =>
    onChange({
      ...options,
      x: { ...options.x, min: null, max: null },
      y: { ...options.y, min: null, max: null },
      y2: options.y2 ? { ...options.y2, min: null, max: null } : options.y2,
    });

  // `className` differs between the two layouts: inline the SVG fills the column
  // width and grows as tall as it needs, while in fullscreen it is bounded by
  // the flex row it sits in so the whole figure stays on screen at once.
  const figure = (className: string) => (
    <FigureSvg
      data={data}
      options={options}
      interactive
      onZoom={handleZoom}
      onResetZoom={resetZoom}
      onLegendMove={handleLegendMove}
      selectedLabelId={selectedLabelId}
      onLabelSelect={setSelectedLabelId}
      onLabelMove={handleLabelMove}
      onLabelStats={handleLabelStats}
      className={className}
    />
  );

  const fullscreenButton = allowFullscreen ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setFullscreen((v) => !v)}
      title={fullscreen ? "Exit fullscreen (Esc)" : "Open the figure fullscreen"}
    >
      {fullscreen ? (
        <Minimize2 className="mr-1.5 h-3.5 w-3.5" />
      ) : (
        <Maximize2 className="mr-1.5 h-3.5 w-3.5" />
      )}
      {fullscreen ? "Exit fullscreen" : "Fullscreen"}
    </Button>
  ) : null;

  const resetZoomButton = (
    <Button variant="ghost" size="sm" disabled={!zoomed} onClick={resetZoom}>
      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
      Reset zoom
    </Button>
  );

  const exportBar = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Export</h3>
        <p className="text-xs text-muted-foreground">
          SVG is true vector · PNG saves at {png.outW}×{png.outH}px
          {options.background === "transparent" ? " with transparency" : ""}.
        </p>
        {!png.ok && (
          <p className="mt-1 text-[11px] text-destructive">
            Too large for the browser to rasterize — lower the scale/DPI or the figure size. SVG
            still exports at any size.
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Select value={String(scale)} onValueChange={(v) => setScale(Number(v))}>
          <SelectTrigger className="h-9 w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Multiplier</SelectLabel>
              {SCALE_MULTIPLIERS.map((s) => (
                <SelectItem key={`x${s}`} value={String(s)}>
                  {s}×
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Print DPI</SelectLabel>
              {DPI_PRESETS.map((d) => (
                <SelectItem key={`d${d}`} value={String(d / DPI_BASE)}>
                  {d} dpi
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" disabled={busy} onClick={exportSvg}>
          <FileCode className="mr-1.5 h-4 w-4" />
          SVG
        </Button>
        <Button size="sm" disabled={busy || !png.ok} onClick={exportPng}>
          <Download className="mr-1.5 h-4 w-4" />
          PNG
        </Button>
      </div>
    </div>
  );

  const controls = (
    <FigureControls
      data={data}
      options={options}
      onChange={onChange}
      selectedLabelId={selectedLabelId}
      onSelectLabel={setSelectedLabelId}
      hiddenByThinning={labelStats.hiddenByThinning}
      onDeleteLabelPeak={onDeletePeak}
      showSticks={showSticks}
      onShowSticksChange={onShowSticksChange}
      onSetPeakColor={onSetPeakColor}
    />
  );

  // Fullscreen is a portal to <body>, not a `fixed` div in place: the figure
  // maker sits several transformed/scrolling containers deep in both hosts, and
  // any one of them creating a stacking context would trap the overlay inside a
  // panel. `z-40` is deliberate — every Radix popup the controls open (Select,
  // Popover, the colour pickers) portals to <body> at `z-50`, so they keep
  // opening ABOVE the overlay instead of behind it.
  if (fullscreen) {
    return createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Figure maker, fullscreen"
        className="fixed inset-0 z-40 flex flex-col bg-background"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2">
          <p className="min-w-0 truncate text-[11px] text-muted-foreground">{PREVIEW_HINT}</p>
          <div className="flex shrink-0 items-center gap-1">
            {resetZoomButton}
            {fullscreenButton}
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
            <div
              ref={previewBoxRef}
              className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
            >
              {/* The checker sits on the fitted box, not the measured area, so a
                  transparent background is shown at exactly the figure's extent. */}
              <div
                className="overflow-hidden rounded-lg"
                style={{
                  width: fitted?.width,
                  height: fitted?.height,
                  ...(options.background === "transparent" ? CHECKER : {}),
                }}
              >
                {fitted && figure("block h-full w-full")}
              </div>
            </div>
            <div className="shrink-0 rounded-2xl border border-border/60 bg-card p-4 shadow-card">
              {exportBar}
            </div>
          </div>

          {/* The styling panel keeps its own scrollbar, so a long section never
              pushes the preview off the screen it was opened to fill. */}
          <div className="w-[360px] max-w-[42vw] shrink-0 overflow-y-auto border-l border-border/60 p-4">
            {controls}
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-4">
        <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-card">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">{PREVIEW_HINT}</p>
            <div className="flex shrink-0 items-center gap-1">
              {resetZoomButton}
              {fullscreenButton}
            </div>
          </div>
          <div
            className="overflow-hidden rounded-lg"
            style={options.background === "transparent" ? CHECKER : undefined}
          >
            {figure("h-auto w-full")}
          </div>
        </div>

        <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-card">{exportBar}</div>
      </div>

      {/* The styling panel scrolls on its own so reaching the bottom controls
          never means scrolling the whole page/dialog. */}
      <div className="min-w-0 xl:sticky xl:top-0 xl:max-h-[calc(100vh-7rem)] xl:overflow-y-auto xl:pr-1">
        {controls}
      </div>
    </div>
  );
}
