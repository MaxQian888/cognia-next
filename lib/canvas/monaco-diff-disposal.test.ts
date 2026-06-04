import { guardDiffEditorModelDisposal } from "./monaco-diff-disposal"
import type { editor as MonacoEditor } from "monaco-editor"

interface FakeModel {
  dispose: () => void
  disposed: boolean
}

function createFakeModel(): FakeModel {
  const model: FakeModel = {
    disposed: false,
    dispose: () => {
      model.disposed = true
    },
  }
  return model
}

interface FakeDiffEditor {
  editor: MonacoEditor.IStandaloneDiffEditor
  /** Model attached at the moment a real dispose ran (per dispose call). */
  attachedAtDispose: Array<{ original: FakeModel; modified: FakeModel } | null>
  setModelCalls: Array<unknown>
  attach: (original: FakeModel, modified: FakeModel) => void
  getAttached: () => { original: FakeModel; modified: FakeModel } | null
}

/**
 * Minimal stand-in for Monaco's IStandaloneDiffEditor: tracks the attached
 * model pair and records what was attached when each TextModel's real
 * dispose() executed — Monaco 0.55 throws "TextModel got disposed before
 * DiffEditorWidget model got reset" exactly when that is non-null.
 */
function createFakeDiffEditor(): FakeDiffEditor {
  let attached: { original: FakeModel; modified: FakeModel } | null = null
  const fake: FakeDiffEditor = {
    attachedAtDispose: [],
    setModelCalls: [],
    attach: (original, modified) => {
      attached = { original, modified }
    },
    getAttached: () => attached,
    editor: {
      getModel: () => attached,
      setModel: (model: unknown) => {
        fake.setModelCalls.push(model)
        attached = (model as { original: FakeModel; modified: FakeModel } | null) ?? null
      },
    } as unknown as MonacoEditor.IStandaloneDiffEditor,
  }
  return fake
}

/** Wires the model's dispose to record the attachment state, like Monaco's assertion. */
function recordAttachmentOnDispose(fake: FakeDiffEditor, model: FakeModel) {
  const real = model.dispose
  model.dispose = () => {
    fake.attachedAtDispose.push(fake.getAttached())
    real()
  }
}

describe("guardDiffEditorModelDisposal", () => {
  it("detaches the models from the editor before the first model dispose runs", () => {
    const fake = createFakeDiffEditor()
    const original = createFakeModel()
    const modified = createFakeModel()
    recordAttachmentOnDispose(fake, original)
    recordAttachmentOnDispose(fake, modified)
    fake.attach(original, modified)

    guardDiffEditorModelDisposal(fake.editor)

    // @monaco-editor/react's unmount order: models first, editor after.
    original.dispose()
    modified.dispose()

    expect(fake.attachedAtDispose).toEqual([null, null])
    expect(original.disposed).toBe(true)
    expect(modified.disposed).toBe(true)
  })

  it("detaches when the modified model is disposed first", () => {
    const fake = createFakeDiffEditor()
    const original = createFakeModel()
    const modified = createFakeModel()
    recordAttachmentOnDispose(fake, modified)
    fake.attach(original, modified)

    guardDiffEditorModelDisposal(fake.editor)
    modified.dispose()

    expect(fake.attachedAtDispose).toEqual([null])
    expect(modified.disposed).toBe(true)
  })

  it("only resets the editor model once for the pair", () => {
    const fake = createFakeDiffEditor()
    const original = createFakeModel()
    const modified = createFakeModel()
    fake.attach(original, modified)

    guardDiffEditorModelDisposal(fake.editor)
    original.dispose()
    modified.dispose()

    expect(fake.setModelCalls).toEqual([null])
  })

  it("guards models swapped in through setModel after mount", () => {
    const fake = createFakeDiffEditor()
    const first = { original: createFakeModel(), modified: createFakeModel() }
    fake.attach(first.original, first.modified)
    guardDiffEditorModelDisposal(fake.editor)

    // The wrapper swaps models when the diff content props change.
    const next = { original: createFakeModel(), modified: createFakeModel() }
    recordAttachmentOnDispose(fake, next.original)
    fake.editor.setModel(next as unknown as MonacoEditor.IDiffEditorModel)

    next.original.dispose()

    expect(fake.attachedAtDispose).toEqual([null])
    expect(next.original.disposed).toBe(true)
  })

  it("setModel still delegates to the editor", () => {
    const fake = createFakeDiffEditor()
    guardDiffEditorModelDisposal(fake.editor)

    const pair = { original: createFakeModel(), modified: createFakeModel() }
    fake.editor.setModel(pair as unknown as MonacoEditor.IDiffEditorModel)

    expect(fake.getAttached()).toEqual(pair)
  })

  it("does not re-wrap an already guarded model", () => {
    const fake = createFakeDiffEditor()
    const original = createFakeModel()
    const modified = createFakeModel()
    fake.attach(original, modified)

    guardDiffEditorModelDisposal(fake.editor)
    const wrapped = original.dispose
    // Re-attaching the same pair (e.g. a no-op prop update) must not stack wrappers.
    fake.editor.setModel({ original, modified } as unknown as MonacoEditor.IDiffEditorModel)

    expect(original.dispose).toBe(wrapped)
  })

  it("leaves disposal untouched when nothing is attached", () => {
    const fake = createFakeDiffEditor()
    guardDiffEditorModelDisposal(fake.editor)

    const stray = createFakeModel()
    stray.dispose()

    expect(stray.disposed).toBe(true)
    expect(fake.setModelCalls).toEqual([])
  })
})
