"use client"

/**
 * Claims ⌘/Ctrl+K for the workflow editor's own command palette.
 *
 * Two things have to happen together, which is why one hook owns both:
 *
 *   1. Publish `view.workflowEditor` for as long as the editor canvas is
 *      mounted. The global search descriptor (`app.commandPalette.toggle`) is
 *      gated on the exact negation, so this is what makes the app-wide palette
 *      stand down inside the editor.
 *   2. Register the editor palette on the shared app-shortcut dispatcher
 *      instead of a raw `window` listener. Before this, ADR-0129's dispatcher
 *      and `canvas.tsx`'s own keydown handler were two independent listeners on
 *      the same target — `preventDefault()` does not stop the sibling — so one
 *      ⌘K opened the node palette *and* the global search dialog.
 *
 * `allowInEditable` preserves the pre-migration behavior: the palette was in
 * the canvas listener's "never blocked" group, so it opens even while an
 * inspector field or a CodeMirror expression editor has focus.
 */

import { useEffect } from "react"

import { setContextKey } from "@/lib/plugin/context-keys/context-key-store"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"

/** The context key the editor publishes while mounted. */
export const WORKFLOW_EDITOR_CONTEXT_KEY = "view.workflowEditor"

export function useWorkflowCommandPaletteShortcut(toggle: () => void): void {
  useEffect(() => {
    setContextKey(WORKFLOW_EDITOR_CONTEXT_KEY, true)
    return () => setContextKey(WORKFLOW_EDITOR_CONTEXT_KEY, false)
  }, [])

  useAppShortcut("workflow.commandPalette.toggle", toggle, {
    allowInEditable: true,
    preventDefault: true,
  })
}

export default useWorkflowCommandPaletteShortcut
