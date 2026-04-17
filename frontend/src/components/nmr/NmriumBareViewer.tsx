import { useEffect, useMemo, useReducer, useRef } from "react";
import type { MutableRefObject, ReactNode } from "react";
import type { NMRiumCore, NmriumState } from "@zakodium/nmrium-core";
import type { FileCollection } from "file-collection";
import { ErrorBoundary } from "react-error-boundary";
import { AssignmentProvider } from "nmrium/lib/component/assignment/AssignmentProvider.js";
import { useChartData } from "nmrium/lib/component/context/ChartContext.js";
import { CoreProvider } from "nmrium/lib/component/context/CoreContext.js";
import { useDispatch } from "nmrium/lib/component/context/DispatchContext.js";
import { FilterSyncOptionsProvider } from "nmrium/lib/component/context/FilterSyncOptionsContext.js";
import { GlobalProvider } from "nmrium/lib/component/context/GlobalContext.js";
import { KeyModifiersProvider } from "nmrium/lib/component/context/KeyModifierContext.js";
import { LoggerProvider } from "nmrium/lib/component/context/LoggerContext.js";
import type { PreferencesStateContext } from "nmrium/lib/component/context/PreferencesContext.js";
import { PreferencesProvider } from "nmrium/lib/component/context/PreferencesContext.js";
import { SortSpectraProvider } from "nmrium/lib/component/context/SortSpectraContext.js";
import { ToasterProvider } from "nmrium/lib/component/context/ToasterContext.js";
import { TopicMoleculeProvider } from "nmrium/lib/component/context/TopicMoleculeContext.js";
import { AlertProvider } from "nmrium/lib/component/elements/Alert.js";
import { DialogProvider } from "nmrium/lib/component/elements/DialogManager.js";
import { ExportManagerProvider } from "nmrium/lib/component/elements/export/ExportManager.js";
import { HighlightProvider } from "nmrium/lib/component/highlight/index.js";
import { defaultGetSpinner, SpinnerProvider } from "nmrium/lib/component/loader/SpinnerContext.js";
import { NMRiumViewer } from "nmrium/lib/component/main/NMRiumViewer.js";
import NMRiumStateProvider from "nmrium/lib/component/main/NMRiumStateProvider.js";
import { StateError } from "nmrium/lib/component/main/StateError.js";
import preferencesReducer, {
  initPreferencesState,
  preferencesInitialState,
  readSettings,
} from "nmrium/lib/component/reducer/preferences/preferencesReducer.js";

export type HighlightBand = {
  color?: string;
  id: string;
  range: [number, number];
};

export type SignalAnnotation = {
  color: string;
  id: string;
  label: string;
  ppm: number;
};

type NmriumBareViewerProps = {
  aggregator: FileCollection;
  core: NMRiumCore;
  emptyText?: ReactNode;
  state: Partial<NmriumState>;
  onHoverPpm?: (ppm: number | null) => void;
  highlightBands?: HighlightBand[];
  signalAnnotations?: SignalAnnotation[];
};

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;

  if (expanded.length !== 6) {
    return `rgba(14, 165, 233, ${alpha})`;
  }

  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

// Runs inside the NMRIUM provider tree so it can read the chart scale and
// dispatch actions. Binds a native dblclick handler (zoom reset) and a
// mousemove handler (ppm -> parent) to the viewer's outer div.
function InteractionBridge({
  rootRef,
  viewerRef,
  onHoverPpm,
}: {
  rootRef: MutableRefObject<HTMLDivElement | null>;
  viewerRef: MutableRefObject<HTMLDivElement | null>;
  onHoverPpm?: (ppm: number | null) => void;
}) {
  const dispatch = useDispatch();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartData = useChartData() as any;
  const xDomain: number[] | undefined = chartData?.xDomain;
  const width: number = chartData?.width ?? 0;
  const marginLeft: number = chartData?.margin?.left ?? 0;
  const marginRight: number = chartData?.margin?.right ?? 0;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleDoubleClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      dispatch({
        type: "FULL_ZOOM_OUT",
        payload: { zoomType: "BIDIRECTIONAL" },
      });
    };

    const handleMove = (event: MouseEvent) => {
      if (!onHoverPpm) return;
      const viewer = viewerRef.current ?? root;
      if (!xDomain || xDomain.length !== 2 || width <= 0) return;

      const rect = viewer.getBoundingClientRect();
      if (rect.width <= 0) return;

      const xSvg = ((event.clientX - rect.left) / rect.width) * width;
      const usableStart = marginLeft;
      const usableEnd = width - marginRight;
      const usableWidth = usableEnd - usableStart;
      if (xSvg < usableStart || xSvg > usableEnd || usableWidth <= 0) {
        onHoverPpm(null);
        return;
      }

      const frac = (xSvg - usableStart) / usableWidth;
      const ppm = xDomain[1] - frac * (xDomain[1] - xDomain[0]);
      onHoverPpm(ppm);
    };

    const handleLeave = () => onHoverPpm?.(null);

    root.addEventListener("dblclick", handleDoubleClick);
    root.addEventListener("mousemove", handleMove);
    root.addEventListener("mouseleave", handleLeave);
    return () => {
      root.removeEventListener("dblclick", handleDoubleClick);
      root.removeEventListener("mousemove", handleMove);
      root.removeEventListener("mouseleave", handleLeave);
    };
  }, [dispatch, marginLeft, marginRight, onHoverPpm, rootRef, viewerRef, width, xDomain]);

  return null;
}

function useOverlayGeometry(
  rootRef: MutableRefObject<HTMLDivElement | null>,
  viewerRef: MutableRefObject<HTMLDivElement | null>,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartData = useChartData() as any;
  const xDomain: number[] | undefined = chartData?.xDomain;
  const width: number = chartData?.width ?? 0;
  const height: number = chartData?.height ?? 0;
  const margin = chartData?.margin;

  if (
    !xDomain ||
    xDomain.length !== 2 ||
    width <= 0 ||
    height <= 0 ||
    !margin ||
    !rootRef.current ||
    !viewerRef.current
  ) {
    return null;
  }

  const rootRect = rootRef.current.getBoundingClientRect();
  const viewerRect = viewerRef.current.getBoundingClientRect();
  if (viewerRect.width <= 0 || viewerRect.height <= 0) {
    return null;
  }

  const marginLeft = margin.left ?? 0;
  const marginRight = margin.right ?? 0;
  const marginTop = margin.top ?? 0;
  const marginBottom = margin.bottom ?? 0;
  const domainSpan = xDomain[1] - xDomain[0];
  if (domainSpan === 0) {
    return null;
  }

  const xScale = viewerRect.width / width;
  const yScale = viewerRect.height / height;
  const offsetLeft = viewerRect.left - rootRect.left;
  const offsetTop = viewerRect.top - rootRect.top;

  const ppmToPixel = (ppm: number) =>
    offsetLeft +
    (marginLeft + ((xDomain[1] - ppm) / domainSpan) * (width - marginLeft - marginRight)) *
      xScale;

  return {
    height,
    marginBottom,
    marginLeft,
    marginRight,
    marginTop,
    offsetLeft,
    offsetTop,
    ppmToPixel,
    width,
    xScale,
    yScale,
  };
}

function HighlightOverlay({
  bands,
  rootRef,
  viewerRef,
}: {
  bands: HighlightBand[];
  rootRef: MutableRefObject<HTMLDivElement | null>;
  viewerRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const geometry = useOverlayGeometry(rootRef, viewerRef);
  if (!geometry || bands.length === 0) {
    return null;
  }

  const {
    height,
    marginBottom,
    marginLeft,
    marginRight,
    marginTop,
    offsetLeft,
    offsetTop,
    ppmToPixel,
    width,
    xScale,
    yScale,
  } = geometry;

  const minX = offsetLeft + marginLeft * xScale;
  const maxX = offsetLeft + (width - marginRight) * xScale;
  const top = offsetTop + marginTop * yScale;
  const overlayHeight = Math.max(0, (height - marginTop - marginBottom) * yScale);

  return (
    <>
      {bands.map((band) => {
        const [low, high] = band.range[0] < band.range[1] ? band.range : [band.range[1], band.range[0]];
        let left = ppmToPixel(high);
        let right = ppmToPixel(low);
        if (left > right) [left, right] = [right, left];

        left = Math.max(minX, left);
        right = Math.min(maxX, right);
        if (right - left < 1) {
          return null;
        }

        const stroke = band.color ?? "#0ea5e9";
        return (
          <div
            key={band.id}
            className="pointer-events-none absolute rounded-sm"
            style={{
              left,
              top,
              width: right - left,
              height: overlayHeight,
              backgroundColor: hexToRgba(stroke, 0.12),
              border: `1px solid ${hexToRgba(stroke, 0.55)}`,
              zIndex: 5,
            }}
          />
        );
      })}
    </>
  );
}

function SignalAnnotationsOverlay({
  annotations,
  rootRef,
  viewerRef,
}: {
  annotations: SignalAnnotation[];
  rootRef: MutableRefObject<HTMLDivElement | null>;
  viewerRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const geometry = useOverlayGeometry(rootRef, viewerRef);
  if (!geometry || annotations.length === 0) {
    return null;
  }

  const { height, marginBottom, marginLeft, marginRight, offsetLeft, offsetTop, ppmToPixel, width, xScale, yScale } =
    geometry;

  const minX = offsetLeft + marginLeft * xScale;
  const maxX = offsetLeft + (width - marginRight) * xScale;
  const baseTop = offsetTop + (height - marginBottom + 12) * yScale;
  const placed: Array<{ end: number; level: number }> = [];

  return (
    <>
      {[...annotations]
        .sort((a, b) => b.ppm - a.ppm)
        .map((annotation) => {
          const x = Math.min(maxX, Math.max(minX, ppmToPixel(annotation.ppm)));
          const labelWidth = Math.max(28, annotation.label.length * 7 + 14);

          let level = 0;
          for (const existing of placed) {
            if (x - labelWidth / 2 < existing.end + 8 && level <= existing.level) {
              level = existing.level + 1;
            }
          }
          placed.push({ end: x + labelWidth / 2, level });

          return (
            <div
              key={annotation.id}
              className="pointer-events-none absolute flex -translate-x-1/2 flex-col items-center"
              style={{
                left: x,
                top: baseTop + level * 18,
                zIndex: 6,
              }}
            >
              <div
                className="mb-1 h-2 w-px rounded-full"
                style={{ backgroundColor: annotation.color }}
              />
              <span
                className="rounded-full border px-1.5 py-0.5 text-[10px] font-semibold shadow-sm"
                style={{
                  color: annotation.color,
                  borderColor: hexToRgba(annotation.color, 0.28),
                  backgroundColor: "rgba(255,255,255,0.95)",
                }}
              >
                {annotation.label}
              </span>
            </div>
          );
        })}
    </>
  );
}

function ViewerFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-muted/20 px-4 text-center text-sm text-muted-foreground">
      NMRIUM could not render this spectrum in the current browser state.
    </div>
  );
}

export function NmriumBareViewer({
  aggregator,
  core,
  emptyText,
  state,
  onHoverPpm,
  highlightBands,
  signalAnnotations,
}: NmriumBareViewerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const elementsWrapperRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const mainDivRef = useRef<HTMLDivElement>(null);

  const [preferencesState, dispatchPreferences] = useReducer(
    preferencesReducer,
    preferencesInitialState,
    initPreferencesState,
  );

  const preferencesProviderValue = useMemo<PreferencesStateContext>(
    () => ({ ...preferencesState, dispatch: dispatchPreferences }),
    [preferencesState],
  );

  useEffect(() => {
    const settings = readSettings();
    dispatchPreferences({
      type: "INIT_PREFERENCES",
      payload: {
        currentWorkspace: settings?.currentWorkspace,
      },
    });
  }, []);

  return (
    <ErrorBoundary FallbackComponent={ViewerFallback}>
      <div ref={mainDivRef} className="h-full" translate="no">
        <CoreProvider value={core}>
          <ExportManagerProvider>
            <GlobalProvider
              value={{
                rootRef: rootRef.current,
                elementsWrapperRef: elementsWrapperRef.current,
                viewerRef: viewerRef.current,
              }}
            >
              <PreferencesProvider value={preferencesProviderValue}>
                <LoggerProvider>
                  <KeyModifiersProvider>
                    <ToasterProvider>
                      <SortSpectraProvider>
                        <NMRiumStateProvider aggregator={aggregator} state={state}>
                          <TopicMoleculeProvider>
                            <DialogProvider>
                              <AlertProvider>
                                <HighlightProvider>
                                  <AssignmentProvider>
                                    <SpinnerProvider value={defaultGetSpinner}>
                                      <FilterSyncOptionsProvider>
                                        <div
                                          ref={rootRef}
                                          className="h-full w-full bg-white"
                                          style={{ position: "relative" }}
                                          tabIndex={0}
                                        >
                                          <StateError />
                                          <NMRiumViewer emptyText={emptyText} viewerRef={viewerRef} />
                                          <InteractionBridge
                                            rootRef={rootRef}
                                            viewerRef={viewerRef}
                                            onHoverPpm={onHoverPpm}
                                          />
                                          <HighlightOverlay
                                            bands={highlightBands ?? []}
                                            rootRef={rootRef}
                                            viewerRef={viewerRef}
                                          />
                                          <SignalAnnotationsOverlay
                                            annotations={signalAnnotations ?? []}
                                            rootRef={rootRef}
                                            viewerRef={viewerRef}
                                          />
                                          <div
                                            ref={elementsWrapperRef}
                                            id="main-wrapper"
                                            style={{
                                              position: "absolute",
                                              pointerEvents: "none",
                                              zIndex: 10,
                                              inset: 0,
                                            }}
                                          />
                                        </div>
                                      </FilterSyncOptionsProvider>
                                    </SpinnerProvider>
                                  </AssignmentProvider>
                                </HighlightProvider>
                              </AlertProvider>
                            </DialogProvider>
                          </TopicMoleculeProvider>
                        </NMRiumStateProvider>
                      </SortSpectraProvider>
                    </ToasterProvider>
                  </KeyModifiersProvider>
                </LoggerProvider>
              </PreferencesProvider>
            </GlobalProvider>
          </ExportManagerProvider>
        </CoreProvider>
      </div>
    </ErrorBoundary>
  );
}
