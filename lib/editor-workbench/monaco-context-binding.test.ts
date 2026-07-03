import { bindMonacoContext, bindMonacoEditorContext } from "./monaco-context-binding"
import { getActiveEditorContext, setActiveEditorContext } from "./editor-context-registry"

beforeEach(() => setActiveEditorContext(null))

describe("bindMonacoContext", () => {
  it("publishes the context immediately", () => {
    const dispose = bindMonacoContext({
      editorId: "e1",
      documentId: "doc-1",
      language: "ts",
      getValue: () => "hello",
    })
    const ctx = getActiveEditorContext()
    expect(ctx?.editorId).toBe("e1")
    expect(ctx?.documentId).toBe("doc-1")
    expect(ctx?.language).toBe("ts")
    expect(ctx?.getValue?.()).toBe("hello")
    dispose()
    expect(getActiveEditorContext()).toBeNull()
  })

  it("ignores extra/free-form binding fields", () => {
    const dispose = bindMonacoContext({
      editorId: "e2",
      foo: "bar",
      anything: 1,
    })
    expect(getActiveEditorContext()?.editorId).toBe("e2")
    dispose()
  })
})

describe("bindMonacoEditorContext", () => {
  it("returns a binding object with .dispose()", () => {
    const binding = bindMonacoEditorContext({ editorId: "e3" })
    expect(typeof binding.dispose).toBe("function")
    expect(getActiveEditorContext()?.editorId).toBe("e3")
    binding.dispose()
    expect(getActiveEditorContext()).toBeNull()
  })

  it("threads contextId, the live editor, and selection/cursor", () => {
    const editor = { id: "monaco-1" }
    const selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }
    bindMonacoEditorContext({
      editorId: "e4",
      contextId: "canvas",
      editor,
      selection,
      cursor: { line: 1, column: 4 },
    })
    const ctx = getActiveEditorContext()
    expect(ctx?.contextId).toBe("canvas")
    expect(ctx?.editor).toBe(editor)
    expect(ctx?.selection).toEqual(selection)
    expect(ctx?.cursor).toEqual({ line: 1, column: 4 })
  })

  it("update() patches the live selection while this editor stays active", () => {
    const binding = bindMonacoEditorContext({ editorId: "e5", contextId: "canvas" })
    binding.update({
      selection: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 },
    })
    expect(getActiveEditorContext()?.selection).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 5,
    })
  })

  it("update() is a no-op once another editor claims the slot", () => {
    const first = bindMonacoEditorContext({ editorId: "e6" })
    bindMonacoEditorContext({ editorId: "e7" }) // second editor takes over the single slot
    first.update({ cursor: { line: 9, column: 9 } })
    // The active context is still e7, untouched by e6's stale update.
    expect(getActiveEditorContext()?.editorId).toBe("e7")
    expect(getActiveEditorContext()?.cursor).toBeUndefined()
  })
})
