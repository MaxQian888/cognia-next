/**
 * Apply the user's customizable canvas keybindings to a live Monaco editor.
 *
 * The keybinding store (`stores/canvas/keybinding-store.ts`) lets the user
 * rebind editor commands in Settings → Canvas → Keybindings, but until now
 * those bindings were never handed to Monaco — the editor only honored its own
 * hardcoded defaults, so rebinding had no effect. This registers a Monaco
 * action per editor-scoped binding so the stored combo actually drives the
 * command.
 *
 * Scope split (mirrors how the global window handler in
 * `use-canvas-keyboard-shortcuts.ts` divides responsibility):
 *  - `canvas.save` / `canvas.saveVersion` are app-level and handled globally
 *    (they must work whether or not the editor is focused), so they are NOT here.
 *  - `edit.selectAll` / `edit.copy` / `edit.cut` / `edit.paste` are left to
 *    Monaco + the browser natively — re-binding clipboard/selection keys is rare
 *    and risks breaking clipboard permissions, so we intentionally don't touch them.
 *  - `navigation.*Suggestion` are handled by the suggestions panel when focused.
 *  - Everything else editor-scoped (find/replace/goToLine/format, the net-new
 *    word-wrap/minimap toggles, line duplicate/comment, and folding) is registered here.
 */

import { keyComboToMonaco } from "./keybinding-monaco"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco is dynamic-imported.
type MonacoNamespace = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MonacoEditor = any
export interface MonacoDisposable {
  dispose: () => void
}

/** Editor-scoped binding action → built-in Monaco command id run via `editor.trigger`. */
const MONACO_COMMAND_BY_ACTION: Record<string, { command: string; label: string }> = {
  "canvas.find": { command: "actions.find", label: "Find" },
  "canvas.replace": { command: "editor.action.startFindReplaceAction", label: "Replace" },
  "canvas.goToLine": { command: "editor.action.gotoLine", label: "Go to Line…" },
  "canvas.format": { command: "editor.action.formatDocument", label: "Format Document" },
  "edit.duplicate": { command: "editor.action.copyLinesDownAction", label: "Duplicate Line" },
  "edit.comment": { command: "editor.action.commentLine", label: "Toggle Line Comment" },
  "fold.foldAll": { command: "editor.foldAll", label: "Fold All" },
  "fold.unfoldAll": { command: "editor.unfoldAll", label: "Unfold All" },
  "fold.foldLevel1": { command: "editor.foldLevel1", label: "Fold Level 1" },
  "fold.foldLevel2": { command: "editor.foldLevel2", label: "Fold Level 2" },
}

export function registerCanvasEditorActions(
  editor: MonacoEditor,
  monaco: MonacoNamespace,
  bindings: Record<string, string>
): MonacoDisposable[] {
  if (!editor?.addAction || !monaco) return []
  const disposables: MonacoDisposable[] = []

  const add = (actionId: string, label: string, run: (ed: MonacoEditor) => void) => {
    const combo = bindings[actionId]
    if (!combo) return
    const keybinding = keyComboToMonaco(combo, monaco)
    if (keybinding === null) return
    const disposable = editor.addAction({
      id: `canvas.kb.${actionId}`,
      label,
      keybindings: [keybinding],
      run,
    })
    if (disposable?.dispose) disposables.push(disposable)
  }

  for (const [actionId, { command, label }] of Object.entries(MONACO_COMMAND_BY_ACTION)) {
    add(actionId, label, (ed) => ed.trigger?.("canvas-keybinding", command, null))
  }

  // Word-wrap / minimap have no native Monaco keybinding — flipping the
  // persisted setting re-derives the editor options and re-applies them.
  add("canvas.toggleWordWrap", "Toggle Word Wrap", () => {
    const store = useCanvasSettingsStore.getState()
    store.updateEditorSettings({ wordWrap: !store.settings.editor.wordWrap })
  })
  add("canvas.toggleMinimap", "Toggle Minimap", () => {
    const store = useCanvasSettingsStore.getState()
    store.updateEditorSettings({ minimap: !store.settings.editor.minimap })
  })

  return disposables
}
