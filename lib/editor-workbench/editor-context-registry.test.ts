import {
  getActiveEditorContext,
  setActiveEditorContext,
  subscribeActiveEditor,
} from "./editor-context-registry"

beforeEach(() => {
  setActiveEditorContext(null)
})

describe("editor-context-registry", () => {
  it("returns null until something is set", () => {
    expect(getActiveEditorContext()).toBeNull()
  })

  it("set then get round-trips a context", () => {
    setActiveEditorContext({ editorId: "e1", language: "ts" })
    expect(getActiveEditorContext()).toEqual({ editorId: "e1", language: "ts" })
  })

  it("notifies subscribers on every set call", () => {
    const fn = jest.fn()
    const off = subscribeActiveEditor(fn)
    setActiveEditorContext({ editorId: "e1" })
    setActiveEditorContext({ editorId: "e2" })
    setActiveEditorContext(null)
    expect(fn).toHaveBeenCalledTimes(3)
    expect(fn).toHaveBeenNthCalledWith(1, { editorId: "e1" })
    expect(fn).toHaveBeenNthCalledWith(3, null)
    off()
  })

  it("disposing a subscription stops notifications", () => {
    const fn = jest.fn()
    const off = subscribeActiveEditor(fn)
    off()
    setActiveEditorContext({ editorId: "x" })
    expect(fn).not.toHaveBeenCalled()
  })

  it("supports multiple concurrent subscribers", () => {
    const fns = [jest.fn(), jest.fn()]
    fns.forEach((fn) => subscribeActiveEditor(fn))
    setActiveEditorContext({ editorId: "z" })
    fns.forEach((fn) => expect(fn).toHaveBeenCalledTimes(1))
  })
})
