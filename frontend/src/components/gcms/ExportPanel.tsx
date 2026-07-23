import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type ExportKind =
  | "chromCsv"
  | "spectrumCsv"
  | "chromPeakCsv"
  | "spectrumPeakCsv"
  | "msp"
  | "metadata"
  | "chromPng"
  | "spectrumPng"
  | "reportPng"
  | "reportSvg";

interface ExportPanelProps {
  disabled?: boolean;
  scale: number;
  onScaleChange(s: number): void;
  onExport(kind: ExportKind): void;
}

const DATA_BUTTONS: { kind: ExportKind; label: string }[] = [
  { kind: "chromCsv", label: "Chromatogram CSV" },
  { kind: "spectrumCsv", label: "Spectrum CSV" },
  { kind: "chromPeakCsv", label: "Chrom. peaks CSV" },
  { kind: "spectrumPeakCsv", label: "Spectrum peaks CSV" },
  { kind: "msp", label: "Spectrum MSP" },
  { kind: "metadata", label: "Metadata (txt)" },
];

const IMAGE_BUTTONS: { kind: ExportKind; label: string }[] = [
  { kind: "chromPng", label: "Chromatogram PNG" },
  { kind: "spectrumPng", label: "Spectrum PNG" },
  { kind: "reportPng", label: "Combined report PNG" },
  { kind: "reportSvg", label: "Combined report SVG" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

export function ExportPanel({ disabled, scale, onScaleChange, onExport }: ExportPanelProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-3">
      <Section title="Data">
        {DATA_BUTTONS.map((b) => (
          <Button
            key={b.kind}
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onExport(b.kind)}
          >
            {b.label}
          </Button>
        ))}
      </Section>
      <Section title="Images">
        {IMAGE_BUTTONS.map((b) => (
          <Button
            key={b.kind}
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onExport(b.kind)}
          >
            {b.label}
          </Button>
        ))}
      </Section>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Scale
        </span>
        <Select value={String(scale)} onValueChange={(v) => onScaleChange(Number(v))}>
          <SelectTrigger className="h-8 w-24 text-xs" disabled={disabled}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">1x</SelectItem>
            <SelectItem value="2">2x</SelectItem>
            <SelectItem value="3">3x</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}