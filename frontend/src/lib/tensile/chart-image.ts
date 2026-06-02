// Turning recharts SVGs into downloadable images (Phase 9). recharts has no
// canvas/PNG API of its own, so we serialize the rendered <svg> and rasterize it
// through an <img> → <canvas>. Two entry points:
//
//   * capture from a *live* chart container (per-figure PNG/SVG download), and
//   * `renderElementToPng`, which mounts a chart at a fixed size in a detached
//     React root and captures it — used to build the four PDF figures regardless
//     of which compare tab is on screen.
//
// Everything stays in the browser; nothing is uploaded.

import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** The natural pixel size of a rendered SVG (from its width/height or layout box). */
function svgSize(svg: SVGSVGElement): { w: number; h: number } {
  const box = svg.getBoundingClientRect();
  const w = svg.width?.baseVal?.value || box.width || Number(svg.getAttribute("width")) || 760;
  const h = svg.height?.baseVal?.value || box.height || Number(svg.getAttribute("height")) || 380;
  return { w, h };
}

/** Serialize an SVG element to standalone SVG markup (with a white background). */
function serializeSvg(svg: SVGSVGElement, w: number, h: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  // Opaque background so the PNG/PDF isn't transparent.
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "0");
  rect.setAttribute("y", "0");
  rect.setAttribute("width", String(w));
  rect.setAttribute("height", String(h));
  rect.setAttribute("fill", "#ffffff");
  clone.insertBefore(rect, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}

/** Rasterize a rendered SVG element to a PNG data URL at `scale`× resolution. */
export async function svgToPng(svg: SVGSVGElement, scale = 2): Promise<string> {
  const { w, h } = svgSize(svg);
  const markup = serializeSvg(svg, w, h);
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to rasterize chart SVG"));
    img.src = src;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

/** Find the recharts SVG inside a container (the rendered chart surface). */
export function findChartSvg(container: HTMLElement | null): SVGSVGElement | null {
  if (!container) return null;
  return (container.querySelector("svg.recharts-surface") ??
    container.querySelector("svg")) as SVGSVGElement | null;
}

/** Download a live chart container's SVG as a PNG file. */
export async function downloadChartPng(container: HTMLElement | null, filename: string): Promise<void> {
  const svg = findChartSvg(container);
  if (!svg) throw new Error("No chart to export");
  const dataUrl = await svgToPng(svg, 2);
  const res = await fetch(dataUrl);
  triggerDownload(await res.blob(), filename);
}

/** Download a live chart container's SVG as an .svg file. */
export function downloadChartSvg(container: HTMLElement | null, filename: string): void {
  const svg = findChartSvg(container);
  if (!svg) throw new Error("No chart to export");
  const { w, h } = svgSize(svg);
  const markup = serializeSvg(svg, w, h);
  triggerDownload(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }), filename);
}

/**
 * Mount a chart element at a fixed size in a detached React root, wait for
 * recharts to paint, capture it to a PNG data URL, then tear the root down. Used
 * to build PDF figures for charts that may not be the active tab.
 */
export async function renderElementToPng(
  element: ReactElement,
  width: number,
  height: number,
  scale = 2,
): Promise<string> {
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;background:#ffffff;`;
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(element);
  // Two animation frames + a short settle let recharts compute layout and draw.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  await new Promise<void>((r) => setTimeout(r, 40));
  let png = "";
  const svg = findChartSvg(host);
  if (svg) png = await svgToPng(svg, scale);
  root.unmount();
  host.remove();
  return png;
}
