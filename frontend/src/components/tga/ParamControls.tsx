// Analysis-parameter controls for the TGA left rail: normalization mode, re-zero
// temperature, DTG window, DTG unit, Td thresholds, step threshold, residue
// temperature. Mirrors the tensile ParamControls idiom — every control writes
// straight into the store's `setParams`.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AnalysisParams, NormMode } from "@/lib/tga/types";

export function ParamControls({
  params,
  onPatch,
}: {
  params: AnalysisParams;
  onPatch: (p: Partial<AnalysisParams>) => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label className="text-[11px] text-muted-foreground">Normalization</Label>
        <Select
          value={params.normMode}
          onValueChange={(v) => onPatch({ normMode: v as NormMode })}
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="first">First point (100%)</SelectItem>
            <SelectItem value="sampleSize">Sample mass</SelectItem>
            <SelectItem value="max">Maximum weight</SelectItem>
            <SelectItem value="atTemperature">Re-zero at temperature</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {params.normMode === "atTemperature" && (
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Re-zero T (°C)</Label>
          <Input
            type="number"
            value={params.rezeroTempC ?? ""}
            onChange={(e) =>
              onPatch({ rezeroTempC: e.target.value === "" ? null : Number(e.target.value) })
            }
            className="h-8"
          />
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">DTG window</Label>
          <Input
            type="number"
            value={params.dtgWindow}
            min={5}
            step={2}
            onChange={(e) => onPatch({ dtgWindow: Math.max(5, Number(e.target.value)) })}
            className="h-8"
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">DTG unit</Label>
          <Select
            value={params.dtgUnit}
            onValueChange={(v) => onPatch({ dtgUnit: v as "%/°C" | "%/min" })}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="%/°C">% / °C</SelectItem>
              <SelectItem value="%/min">% / min</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Step threshold (%)</Label>
          <Input
            type="number"
            value={params.stepMinLossPct}
            min={0.1}
            step={0.1}
            onChange={(e) => onPatch({ stepMinLossPct: Math.max(0.1, Number(e.target.value)) })}
            className="h-8"
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">Residue T (°C)</Label>
          <Input
            type="number"
            value={params.residueTempC ?? ""}
            placeholder="final"
            onChange={(e) =>
              onPatch({ residueTempC: e.target.value === "" ? null : Number(e.target.value) })
            }
            className="h-8"
          />
        </div>
      </div>
      <div className="grid gap-1">
        <Label className="text-[11px] text-muted-foreground">
          Td thresholds (comma-separated)
        </Label>
        <Input
          value={params.tdThresholds.join(", ")}
          onChange={(e) =>
            onPatch({
              tdThresholds: e.target.value
                .split(",")
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isFinite(n) && n > 0),
            })
          }
          className="h-8"
        />
      </div>
    </div>
  );
}