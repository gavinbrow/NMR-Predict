// A transient "what am I hovering" label for dense curve charts.
//
// With many overlaid curves an always-on legend (or a multi-series tooltip) grows
// large enough to cover the plot. Instead, each series calls `show(name)` while
// the pointer is over its stroke; the returned `label` is rendered as a single
// small floating chip that auto-clears a short moment after the pointer stops
// moving over a curve — so you see the name of the curve under the cursor without
// a big legend blocking the figure.

import { useCallback, useEffect, useRef, useState } from "react";

export interface HoverLabel {
  /** The curve name currently under the pointer, or `null` once it has faded. */
  label: string | null;
  /** Call from a series' hover handler to (re)show its name. */
  show: (name: string) => void;
}

/** @param timeoutMs How long the chip lingers after the last hover event. */
export function useHoverLabel(timeoutMs = 1800): HoverLabel {
  const [label, setLabel] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const current = useRef<string | null>(null);

  const clearTimer = () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const show = useCallback(
    (name: string) => {
      clearTimer();
      if (current.current !== name) {
        current.current = name;
        setLabel(name);
      }
      timer.current = window.setTimeout(() => {
        current.current = null;
        setLabel(null);
      }, timeoutMs);
    },
    [timeoutMs],
  );

  useEffect(() => () => clearTimer(), []);

  return { label, show };
}
