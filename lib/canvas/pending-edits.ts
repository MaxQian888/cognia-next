/**
 * Edits an editor is still holding back, and a way to ask for them now.
 *
 * The Canvas editor commits keystrokes to the artifact store on a debounce, so
 * for a moment after typing the store is behind the buffer. Anything that
 * reads the store to decide what the document says (joining a collaboration
 * session is the case this exists for) would read the older text, and the
 * keystrokes in flight would then be cancelled by the store update that
 * follows: in neither copy.
 *
 * The editor lives in a sibling component, so it registers a flush here per
 * document and a reader calls `flushPendingCanvasEdits` first. The same shape
 * as `document-disposal.ts`. A flush that throws is logged and skipped: the
 * reader still gets the store as it is.
 */

import { loggers } from "@cognia/logging"

export type CanvasEditFlusher = () => void

const flushers = new Map<string, Set<CanvasEditFlusher>>()

/** Register a flush for one document. Returns the unregister. */
export function registerCanvasEditFlusher(
  documentId: string,
  flusher: CanvasEditFlusher
): () => void {
  const set = flushers.get(documentId) ?? new Set()
  set.add(flusher)
  flushers.set(documentId, set)
  return () => {
    const current = flushers.get(documentId)
    current?.delete(flusher)
    if (current && current.size === 0) flushers.delete(documentId)
  }
}

/** Commit whatever an editor is holding back for this document, synchronously. */
export function flushPendingCanvasEdits(documentId: string): void {
  const set = flushers.get(documentId)
  if (!set) return
  for (const flusher of [...set]) {
    try {
      flusher()
    } catch (error) {
      loggers.canvas.warn("canvas pending edit flush failed", {
        documentId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
