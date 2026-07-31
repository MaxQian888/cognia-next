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
 * This is now a thin wrapper over the shared surface-aware engine
 * (`lib/editor-workbench/register-editor-actions.ts`) — canvas keeps its exact
 * action ids (`canvas.kb.<actionId>`), trigger source, and the net-new
 * word-wrap/minimap toggles, while every surface shares one registration path.
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

import {
  registerEditorActions,
  type EditorActionDef,
  type EditorActionDisposable,
} from "@/lib/editor-workbench/register-editor-actions"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco is dynamic-imported.
type MonacoNamespace = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MonacoEditor = any
export type MonacoDisposable = EditorActionDisposable

/** Editor-scoped canvas actions: built-in Monaco commands + the two toggles. */
const CANVAS_ACTIONS: EditorActionDef[] = [
  { id: "canvas.find", label: "Find", monacoCommand: "actions.find" },
  {
    id: "canvas.replace",
    label: "Replace",
    monacoCommand: "editor.action.startFindReplaceAction",
  },
  { id: "canvas.goToLine", label: "Go to Line…", monacoCommand: "editor.action.gotoLine" },
  { id: "canvas.format", label: "Format Document", monacoCommand: "editor.action.formatDocument" },
  {
    id: "edit.duplicate",
    label: "Duplicate Line",
    monacoCommand: "editor.action.copyLinesDownAction",
  },
  { id: "edit.comment", label: "Toggle Line Comment", monacoCommand: "editor.action.commentLine" },
  { id: "fold.foldAll", label: "Fold All", monacoCommand: "editor.foldAll" },
  { id: "fold.unfoldAll", label: "Unfold All", monacoCommand: "editor.unfoldAll" },
  { id: "fold.foldLevel1", label: "Fold Level 1", monacoCommand: "editor.foldLevel1" },
  { id: "fold.foldLevel2", label: "Fold Level 2", monacoCommand: "editor.foldLevel2" },
  {
    id: "canvas.toggleWordWrap",
    label: "Toggle Word Wrap",
    run: () => {
      const store = useCanvasSettingsStore.getState()
      store.updateEditorSettings({ wordWrap: !store.settings.editor.wordWrap })
    },
  },
  {
    id: "canvas.toggleMinimap",
    label: "Toggle Minimap",
    run: () => {
      const store = useCanvasSettingsStore.getState()
      store.updateEditorSettings({ minimap: !store.settings.editor.minimap })
    },
  },
]

export function registerCanvasEditorActions(
  editor: MonacoEditor,
  monaco: MonacoNamespace,
  bindings: Record<string, string>
): MonacoDisposable[] {
  return registerEditorActions(editor, monaco, {
    idPrefix: "canvas.kb.",
    triggerSource: "canvas-keybinding",
    bindings,
    actions: CANVAS_ACTIONS,
  })
}
