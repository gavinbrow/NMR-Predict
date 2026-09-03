// Thin re-export of the GC/MS view helpers the DSC plot/figure share. The
// `downsample` (min/max-envelope) and `sliceRange` (binary-search window)
// functions are general over any `{x, y}` series, so DSC reuses them rather
// than duplicating the logic, exactly as TGA does (`lib/tga/view.ts`). See
// `lib/gcms/view.ts` for the implementations.

export { downsample, sliceRange } from "@/lib/gcms/view";
export type { XYSeries } from "@/lib/gcms/types";
