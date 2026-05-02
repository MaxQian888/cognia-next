/**
 * Editor-workbench context registry — Cognia uses this to share the
 * active Monaco editor between the canvas surface and the AI
 * inspector. cognia-next reproduces the surface with a minimal
 * in-memory registry; the canvas is currently the only consumer, so
 * a single global slot is enough.
 */

export interface ActiveEditorContext {
  editorId: string
  /**
   * Discriminator that tells plugin APIs which kind of editor is
   * focused. The canvas surface sets `"canvas"`; future Monaco hosts
   * (e.g., ai-inspector) will register their own ids.
   */
  contextId?: "canvas" | "ai-inspector" | (string & {})
  /**
   * Live Monaco editor handle, when the host can hand one out. Typed
   * permissively because the Monaco types aren't always available at
   * compile time (Monaco is dynamic-imported).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor?: any
  documentId?: string
  language?: string
  selection?: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  } | null
  cursor?: { line: number; column: number }
  getValue?: () => string
  /** Free-form metadata propagated to plugin APIs. */
  metadata?: Record<string, unknown>
}

let _active: ActiveEditorContext | null = null
const listeners = new Set<(ctx: ActiveEditorContext | null) => void>()

export function getActiveEditorContext(): ActiveEditorContext | null {
  return _active
}

export function setActiveEditorContext(ctx: ActiveEditorContext | null): void {
  _active = ctx
  listeners.forEach((fn) => fn(ctx))
}

export function subscribeActiveEditor(fn: (ctx: ActiveEditorContext | null) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
