import type { DragEvent } from "react"
import {
  buildNodeRef,
  EXPR_DRAG_MIME,
  serializeExprDrag,
  type PathSegment,
} from "@/lib/workflow/editor/expr-ref"

/**
 * Props spread onto a data-view field chip to make it a drag source for the
 * expression editor. On drop, `ExpressionField` reads `EXPR_DRAG_MIME` and
 * inserts the corresponding `{{ $node['id'].path }}` reference. A `text/plain`
 * fallback carries the same string so dropping into a plain input still pastes
 * something useful.
 */
export function exprDragProps(
  nodeId: string,
  segments: ReadonlyArray<PathSegment>
): { draggable: true; onDragStart: (e: DragEvent) => void } {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(EXPR_DRAG_MIME, serializeExprDrag(nodeId, segments))
      e.dataTransfer.setData("text/plain", buildNodeRef(nodeId, segments))
      e.dataTransfer.effectAllowed = "copy"
    },
  }
}
