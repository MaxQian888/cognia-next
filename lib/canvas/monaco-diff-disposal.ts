/**
 * Workaround for @monaco-editor/react's DiffEditor unmount order (present
 * through 4.8.0-rc.3): its cleanup disposes the original/modified TextModels
 * *before* disposing the diff editor, while they are still attached. Since
 * monaco-editor ~0.5x the DiffEditorWidget asserts on that with
 * "TextModel got disposed before DiffEditorWidget model got reset", which
 * surfaces as a runtime error overlay in dev on every diff unmount.
 *
 * Call this from the DiffEditor `onMount`: it wraps the attached models'
 * `dispose()` to first reset the editor's model (`setModel(null)`), and
 * re-arms whenever the wrapper swaps models via `setModel`.
 */

import type { editor as MonacoEditor } from "monaco-editor"

export function guardDiffEditorModelDisposal(editor: MonacoEditor.IStandaloneDiffEditor): void {
  const guarded = new WeakSet<MonacoEditor.ITextModel>()

  const guardModel = (model: MonacoEditor.ITextModel) => {
    if (guarded.has(model)) return
    guarded.add(model)
    const realDispose = model.dispose.bind(model)
    model.dispose = () => {
      const attached = editor.getModel()
      if (attached && (attached.original === model || attached.modified === model)) {
        editor.setModel(null)
      }
      realDispose()
    }
  }

  const guardAttached = () => {
    const attached = editor.getModel()
    if (!attached) return
    guardModel(attached.original)
    guardModel(attached.modified)
  }

  const realSetModel = editor.setModel.bind(editor)
  editor.setModel = ((model: Parameters<typeof realSetModel>[0]) => {
    realSetModel(model)
    if (model) guardAttached()
  }) as typeof editor.setModel

  guardAttached()
}
