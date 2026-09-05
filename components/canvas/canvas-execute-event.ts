/**
 * "Run this document" as a window event, matching the `canvas-action` /
 * `canvas-save` / `canvas-goto-line` bus the rest of the Canvas shell uses.
 *
 * The editor pane raises it and the workbench's execution panel answers, which
 * is what lets the `run` action reach the real runtime. Before this, `run`
 * asked the model to describe what it thought the code would do, in a shell
 * that was already capable of running it, and printed the answer nowhere.
 */

export const CANVAS_EXECUTE_EVENT = "canvas-execute"

export interface CanvasExecuteDetail {
  documentId: string
}

export function requestCanvasExecute(documentId: string): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<CanvasExecuteDetail>(CANVAS_EXECUTE_EVENT, { detail: { documentId } })
  )
}
