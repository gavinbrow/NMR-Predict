import { ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { FigureData } from "@/lib/ir/figure";
import { FigureMaker } from "./FigureMaker";
import { useFigureOptions } from "./useFigureOptions";

/**
 * A small "Make figure" button that opens the figure editor in a near-
 * fullscreen dialog. The options live here (at the always-mounted host level),
 * so styling persists across dialog close/reopen and across data updates.
 */
export function FigurePopout({ data, label = "Make figure" }: { data: FigureData; label?: string }) {
  const [options, setOptions] = useFigureOptions(data);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ImagePlus className="mr-1.5 h-4 w-4" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="h-[94vh] max-w-[96vw] overflow-y-auto sm:max-w-[96vw]">
        <DialogHeader>
          <DialogTitle>Figure maker</DialogTitle>
          <DialogDescription>
            Style the plot and export it as a publication-quality SVG or PNG.
          </DialogDescription>
        </DialogHeader>
        <FigureMaker data={data} options={options} onChange={setOptions} />
      </DialogContent>
    </Dialog>
  );
}
