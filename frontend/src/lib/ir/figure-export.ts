// Figure downloads. The preview SVG (FigureSvg) *is* the artifact: SVG export
// serializes a full-resolution offscreen render of it, and PNG export
// rasterizes that same SVG on a canvas at 1–4× scale. Unlike the tensile
// chart capture there is no white canvas pre-fill — a transparent-background
// figure exports with real alpha. Everything stays in the browser.

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { FigureSvg } from "@/components/ir/figure/FigureSvg";
import { triggerDownload } from "./export";
import type { FigureData, FigureOptions } from "./figure";

/**
 * Canvas ceilings for the PNG raster path. Browsers cap a single canvas
 * dimension near 16 384 px and the total area near ~268 MP (conservative across
 * Chrome/Firefox/Safari); the `data:`-URI `<img>` rasterization used below adds
 * no higher headroom. Past these a canvas silently allocates blank, so callers
 * must refuse the export rather than emit an empty PNG.
 */
export const MAX_PNG_DIM = 16384;
export const MAX_PNG_AREA = 268_000_000;

/** Resolved output pixel size for a PNG export, and whether it fits the limits. */
export function pngExportSize(
  width: number,
  height: number,
  scale: number,
): { outW: number; outH: number; ok: boolean } {
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const ok = outW <= MAX_PNG_DIM && outH <= MAX_PNG_DIM && outW * outH <= MAX_PNG_AREA;
  return { outW, outH, ok };
}

/** Standalone SVG markup of a rendered figure (explicit size, no CSS classes). */
export function serializeFigureSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.removeAttribute("class");
  const vb = svg.viewBox.baseVal;
  clone.setAttribute("width", String(vb?.width || svg.clientWidth || 900));
  clone.setAttribute("height", String(vb?.height || svg.clientHeight || 560));
  return new XMLSerializer().serializeToString(clone);
}

/** Rasterize a rendered figure SVG to a PNG blob at `scale`× its viewBox size. */
export async function figureSvgToPng(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const vb = svg.viewBox.baseVal;
  const w = vb?.width || svg.clientWidth || 900;
  const h = vb?.height || svg.clientHeight || 560;
  // Refuse an oversize raster loudly — a canvas past the browser limits allocates
  // blank, so this would otherwise download an empty PNG. The UI disables the
  // button ahead of this; the guard covers any other caller.
  const { outW, outH, ok } = pngExportSize(w, h, scale);
  if (!ok) {
    throw new Error(
      `Requested PNG (${outW}×${outH}px) exceeds the browser canvas limit — lower the scale/DPI or the figure size.`,
    );
  }
  const markup = serializeFigureSvg(svg);
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to rasterize figure SVG"));
    img.src = src;
  });

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  // No background pre-fill: a transparent figure stays transparent.
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, w, h);

  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("PNG encoding failed");
  return blob;
}

/**
 * Mount the figure at full resolution (no preview decimation) in a detached
 * React root and hand back the rendered <svg> plus a cleanup callback.
 */
async function renderOffscreenFigure(
  data: FigureData,
  options: FigureOptions,
): Promise<{ svg: SVGSVGElement; cleanup: () => void }> {
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${options.width}px;height:${options.height}px;`;
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(FigureSvg, { data, options, decimate: false }));
  // Two animation frames let React commit and the browser lay the SVG out.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const svg = host.querySelector("svg[data-figure-svg]");
  const cleanup = () => {
    root.unmount();
    host.remove();
  };
  if (!svg) {
    cleanup();
    throw new Error("Figure failed to render");
  }
  return { svg: svg as SVGSVGElement, cleanup };
}

/** Download the figure as a true-vector .svg file. */
export async function downloadFigureSvg(
  data: FigureData,
  options: FigureOptions,
  filename: string,
): Promise<void> {
  const { svg, cleanup } = await renderOffscreenFigure(data, options);
  try {
    const markup = serializeFigureSvg(svg);
    triggerDownload(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }), filename);
  } finally {
    cleanup();
  }
}

/** Download the figure as a PNG at `scale`× resolution (1–4). */
export async function downloadFigurePng(
  data: FigureData,
  options: FigureOptions,
  scale: number,
  filename: string,
): Promise<void> {
  const { svg, cleanup } = await renderOffscreenFigure(data, options);
  try {
    triggerDownload(await figureSvgToPng(svg, scale), filename);
  } finally {
    cleanup();
  }
}

/** Compose multiple figures into one stacked parent SVG (figure i translated
 *  to y = sum of heights[0..i-1], parent width = max child width). Returns the
 *  serialized markup plus the composed pixel dimensions. Shared by the SVG
 *  and PNG stacked exporters. */
async function composeStackedSvg(
  figs: { data: FigureData; options: FigureOptions }[],
): Promise<{ markup: string; width: number; height: number }> {
  const rendered = await Promise.all(figs.map((f) => renderOffscreenFigure(f.data, f.options)));
  const SVG_NS = "http://www.w3.org/2000/svg";
  try {
    let totalH = 0;
    let maxW = 0;
    const children: SVGSVGElement[] = [];
    for (const { svg } of rendered) {
      const vb = svg.viewBox.baseVal;
      const w = vb?.width || svg.clientWidth || 900;
      const h = vb?.height || svg.clientHeight || 560;
      maxW = Math.max(maxW, w);
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("x", "0");
      clone.setAttribute("y", String(totalH));
      clone.removeAttribute("class");
      totalH += h;
      children.push(clone);
    }
    const parent = document.createElementNS(SVG_NS, "svg");
    parent.setAttribute("xmlns", SVG_NS);
    parent.setAttribute("width", String(maxW));
    parent.setAttribute("height", String(totalH));
    parent.setAttribute("viewBox", `0 0 ${maxW} ${totalH}`);
    for (const child of children) parent.appendChild(child);
    const markup = new XMLSerializer().serializeToString(parent);
    return { markup, width: maxW, height: totalH };
  } finally {
    for (const { cleanup } of rendered) cleanup();
  }
}

/** Download multiple figures as a single stacked .svg file (chromatogram above,
 *  spectrum below, one parent SVG with nested `<svg>` children). */
export async function downloadStackedFigureSvg(
  figs: { data: FigureData; options: FigureOptions }[],
  filename: string,
): Promise<void> {
  const { markup } = await composeStackedSvg(figs);
  triggerDownload(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }), filename);
}

/** Download multiple figures as a single stacked .png file at `scale`× resolution. */
export async function downloadStackedFigurePng(
  figs: { data: FigureData; options: FigureOptions }[],
  scale: number,
  filename: string,
): Promise<void> {
  const { markup, width, height } = await composeStackedSvg(figs);
  const { outW, outH, ok } = pngExportSize(width, height, scale);
  if (!ok) {
    throw new Error(
      `Requested PNG (${outW}×${outH}px) exceeds the browser canvas limit — lower the scale/DPI or the figure size.`,
    );
  }
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to rasterize stacked figure SVG"));
    img.src = src;
  });
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("PNG encoding failed");
  triggerDownload(blob, filename);
}

/**
 * Rasterize the figure to a PNG **data URL** at `scale`× resolution, instead of
 * downloading it. Same offscreen full-resolution render as
 * {@link downloadFigurePng} — this variant exists so a report generator (the
 * TGA PDF, say) can embed the exact figure the user styled without a round trip
 * through the filesystem.
 */
export async function figurePngDataUrl(
  data: FigureData,
  options: FigureOptions,
  scale = 2,
): Promise<string> {
  const { svg, cleanup } = await renderOffscreenFigure(data, options);
  try {
    const blob = await figureSvgToPng(svg, scale);
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Failed to encode figure PNG"));
      reader.readAsDataURL(blob);
    });
  } finally {
    cleanup();
  }
}
