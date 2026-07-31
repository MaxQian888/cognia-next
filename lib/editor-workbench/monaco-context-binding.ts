/**
 * Binds a Monaco editor to the workbench context registry so plugins / AI
 * inspectors can read its live state. cognia-next now threads the full context
 * the plugin Canvas API expects — `contextId` + the live `editor` handle + the
 * current `selection`/`cursor` — so `getActiveCanvasEditor()` returns a real
 * editor instead of always falling back to the store snapshot.
 */

import {
  getActiveEditorContext,
  setActiveEditorContext,
  type ActiveEditorContext,
} from "./editor-context-registry"

export interface BindMonacoContextOptions {
  editorId: string
  /** Surface discriminator plugin APIs gate on (e.g. "canvas"). */
  contextId?: ActiveEditorContext["contextId"]
  /** Live Monaco editor handle, when the host can hand one out. */
  editor?: ActiveEditorContext["editor"]
  documentId?: string
  language?: string
  getValue?: () => string
  selection?: ActiveEditorContext["selection"]
  cursor?: ActiveEditorContext["cursor"]
  metadata?: Record<string, unknown>
  /** Cognia's richer binding API passes extras; cognia-next ignores unknown keys. */
  [key: string]: unknown
}

export interface MonacoContextBinding {
  dispose: () => void
  /** Patch the live selection/cursor (etc.) while this editor stays active. */
  update: (
    patch: Partial<Pick<ActiveEditorContext, "selection" | "cursor" | "language" | "metadata">>
  ) => void
}

function buildContext(opts: BindMonacoContextOptions): ActiveEditorContext {
  return {
    editorId: opts.editorId,
    contextId: opts.contextId,
    editor: opts.editor,
    documentId: opts.documentId,
    language: opts.language,
    getValue: opts.getValue,
    selection: opts.selection,
    cursor: opts.cursor,
    metadata: opts.metadata,
  }
}

export function bindMonacoContext(opts: BindMonacoContextOptions): () => void {
  setActiveEditorContext(buildContext(opts))
  return () => setActiveEditorContext(null)
}

/**
 * Cognia name. Returns a richer binding: `dispose` clears the slot, `update`
 * patches the live selection/cursor as long as this editor is still active
 * (a later-mounted editor claiming the single global slot is not clobbered).
 */
export function bindMonacoEditorContext(opts: BindMonacoContextOptions): MonacoContextBinding {
  let current = buildContext(opts)
  setActiveEditorContext(current)
  return {
    dispose: () => setActiveEditorContext(null),
    update: (patch) => {
      const active = getActiveEditorContext()
      if (active?.editorId !== current.editorId) return
      current = { ...current, ...patch }
      setActiveEditorContext(current)
    },
  }
}
