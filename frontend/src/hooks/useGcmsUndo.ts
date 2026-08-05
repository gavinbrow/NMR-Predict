import type { ChromPeak, ManualSpecPeak, SpecPeak } from "@/lib/gcms/types";
import { useCallback, useRef } from "react";

export interface GcmsPeakSnapshot {
  chromPeaks: ChromPeak[];
  manualChromPeaks: ChromPeak[];
  dismissedChromPeakIds: Set<string>;
  specPeaks: SpecPeak[];
  manualSpecPeaks: ManualSpecPeak[];
  dismissedSpecPeakIds: Set<string>;
  label: string;
}

export function useGcmsUndo(maxHistory = 50) {
  const pastRef = useRef<GcmsPeakSnapshot[]>([]);

  const pushSnapshot = useCallback(
    (snapshot: GcmsPeakSnapshot) => {
      pastRef.current.push(snapshot);
      if (pastRef.current.length > maxHistory) pastRef.current.shift();
    },
    [maxHistory],
  );

  const popSnapshot = useCallback((): GcmsPeakSnapshot | null => {
    return pastRef.current.pop() ?? null;
  }, []);

  const clear = useCallback(() => {
    pastRef.current = [];
  }, []);

  const canUndo = useCallback(() => pastRef.current.length > 0, []);

  return { pushSnapshot, popSnapshot, clear, canUndo };
}

export function cloneGcmsPeakSnapshot(snapshot: GcmsPeakSnapshot): GcmsPeakSnapshot {
  return {
    chromPeaks: snapshot.chromPeaks.map((p) => ({ ...p })),
    manualChromPeaks: snapshot.manualChromPeaks.map((p) => ({ ...p })),
    dismissedChromPeakIds: new Set(snapshot.dismissedChromPeakIds),
    specPeaks: snapshot.specPeaks.map((p) => ({ ...p })),
    manualSpecPeaks: snapshot.manualSpecPeaks.map((p) => ({ ...p })),
    dismissedSpecPeakIds: new Set(snapshot.dismissedSpecPeakIds),
    label: snapshot.label,
  };
}

export function buildGcmsPeakSnapshot(
  source: Omit<GcmsPeakSnapshot, "label"> & { label: string },
): GcmsPeakSnapshot {
  return cloneGcmsPeakSnapshot(source);
}
