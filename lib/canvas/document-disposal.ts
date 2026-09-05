/**
 * Cross-store cleanup for a deleted Canvas document.
 *
 * `deleteCanvasDocument` removes the row from the artifact store, but a
 * document is referenced from several places that store knows nothing about:
 * the comment store holds its threads in memory, and the collaboration layer
 * holds its session. Importing those from the artifact store would drag their
 * module side effects (a legacy localStorage migration, a Dexie open) into
 * every consumer of a persisted, near-universally imported store.
 *
 * So they register a disposer instead, the same shape
 * `lib/project/project-bucket-purge.ts` uses for workspace purges. A disposer
 * that throws is logged and skipped: one owner failing to let go must not stop
 * the others, and the document row is already gone by then.
 *
 * Registration is idempotent per name, so a module re-evaluated under Jest's
 * module registry does not accumulate duplicates.
 */

import { loggers } from "@cognia/logging"

export type CanvasDocumentDisposer = (documentId: string) => void

const disposers = new Map<string, CanvasDocumentDisposer>()

export function registerCanvasDocumentDisposer(
  name: string,
  disposer: CanvasDocumentDisposer
): void {
  disposers.set(name, disposer)
}

export function unregisterCanvasDocumentDisposer(name: string): void {
  disposers.delete(name)
}

/** Names currently registered, newest last. Exposed for the dormancy guard. */
export function canvasDocumentDisposerNames(): string[] {
  return [...disposers.keys()]
}

export function disposeCanvasDocument(documentId: string): void {
  for (const [name, disposer] of disposers) {
    try {
      disposer(documentId)
    } catch (error) {
      loggers.canvas.warn("canvas document disposer failed", {
        disposer: name,
        documentId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
