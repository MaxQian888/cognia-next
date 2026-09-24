// Goto-line for the mobile project editor.
//
// The desktop pane is Monaco, which listens for `PROJECT_EDITOR_GOTO_EVENT`
// and drains armed requests in `project-monaco.tsx`. The mobile pane is the
// CodeMirror `LightCodeEditor`, which knew nothing of either — so a search
// hit, a `:N` quick-open jump, a Problems click or a terminal file link
// opened the file on a phone and left the caret on line 1. This extension is
// the same contract on the CodeMirror side, mounted through the editor's
// `extensions` seam.

import type { Extension } from "@codemirror/state"
import { EditorView, ViewPlugin } from "@codemirror/view"
import {
  consumeProjectEditorGoto,
  PROJECT_EDITOR_GOTO_EVENT,
  type ProjectEditorGotoDetail,
} from "./editor-events"

/**
 * Put the caret at `line`:`column` (both 1-based, clamped to the document)
 * and scroll it to the middle of the viewport. Deliberately no `focus()`: on
 * a phone that would raise the virtual keyboard over the line just revealed.
 */
export function revealLightEditorLine(view: EditorView, line: number, column: number): void {
  const doc = view.state.doc
  const target = doc.line(Math.min(Math.max(1, Math.floor(line)), doc.lines))
  const pos = Math.min(target.from + Math.max(0, Math.floor(column) - 1), target.to)
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  })
}

/** Reveal goto requests addressed to `relPath` in this CodeMirror view. */
export function projectEditorGotoExtension(relPath: string): Extension {
  return ViewPlugin.define((view) => {
    let disposed = false
    const onGoto = (event: Event) => {
      const detail = (event as CustomEvent<ProjectEditorGotoDetail>).detail
      if (!detail || detail.relPath !== relPath) return
      // The live event consumed the request — its armed twin must not
      // re-apply on the next mount of this file.
      consumeProjectEditorGoto(relPath)
      revealLightEditorLine(view, detail.line, detail.column)
    }
    window.addEventListener(PROJECT_EDITOR_GOTO_EVENT, onGoto)
    // A request armed before this editor mounted (the cold-open case) is
    // drained once the view is live. Dispatching from inside a plugin
    // constructor is illegal — the view is mid-update — hence the microtask.
    queueMicrotask(() => {
      if (disposed) return
      const pending = consumeProjectEditorGoto(relPath)
      if (pending) revealLightEditorLine(view, pending.line, pending.column)
    })
    return {
      destroy() {
        disposed = true
        window.removeEventListener(PROJECT_EDITOR_GOTO_EVENT, onGoto)
      },
    }
  })
}
