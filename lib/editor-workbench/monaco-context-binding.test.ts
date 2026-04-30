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
})
