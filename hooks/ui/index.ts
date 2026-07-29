/**
 * Generic UI hooks: clipboard, viewport / breakpoint observers.
 */

export { useCopy } from "./use-copy"
export { useIsMobile } from "./use-mobile"
export { useMediaQuery, useIsNarrow } from "./use-media-query"
export { useBreakpoint, type Breakpoint } from "./use-breakpoint"
export {
  useRangeSelection,
  type RangeSelectionMouseEvent,
  type UseRangeSelectionResult,
} from "./use-range-selection"
export {
  useResizableLayout,
  type Layout as ResizableLayout,
  type UseResizableLayoutResult,
} from "./use-resizable-layout"
export {
  useEdgeResize,
  type UseEdgeResizeOptions,
  type UseEdgeResizeResult,
} from "./use-edge-resize"
export {
  useDeferredLoading,
  LOADING_DELAY_MS,
  LOADING_MIN_DISPLAY_MS,
  type DeferredLoadingOptions,
} from "./use-deferred-loading"
export {
  useLoadingPhase,
  ESCALATED_AT_MS,
  PROLONGED_AT_MS,
  type LoadingPhase,
  type LoadingPhaseName,
  type LoadingPhaseOptions,
} from "./use-loading-phase"
export { useLiveQueryState, type LiveQueryState } from "./use-live-query-state"
