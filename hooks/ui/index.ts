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
