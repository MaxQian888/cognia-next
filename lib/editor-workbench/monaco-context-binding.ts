/**
 * Cognia compat shim — binds a Monaco editor to the workbench context
 * so plugins / AI inspectors can read its state. cognia-next currently
 * uses a no-op binder that just calls back into
 * `setActiveEditorContext` once on bind.
 */

import { setActiveEditorContext } from "./editor-context-registry"

export interface BindMonacoContextOptions {
  editorId: string
  documentId?: string
  language?: string
  getValue?: () => string
  /** Cognia exposes a richer binding API; cognia-next ignores extras. */
  [key: string]: unknown
}

export interface MonacoContextBinding {
  dispose: () => void
}

export function bindMonacoContext(opts: BindMonacoContextOptions): () => void {
  setActiveEditorContext({
    editorId: opts.editorId,
    documentId: opts.documentId,
    language: opts.language,
    getValue: opts.getValue,
  })
  return () => setActiveEditorContext(null)
}

/**
 * Cognia name. cognia-next aliases to the same implementation. Returns
 * a `MonacoContextBinding` object instead of a bare disposer because
 * the canvas-panel destructures `.dispose`.
 */
export function bindMonacoEditorContext(opts: BindMonacoContextOptions): MonacoContextBinding {
  const dispose = bindMonacoContext(opts)
  return { dispose }
}
