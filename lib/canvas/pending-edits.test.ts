import { flushPendingCanvasEdits, registerCanvasEditFlusher } from "./pending-edits"

describe("pending canvas edits", () => {
  it("flushes only the named document", () => {
    const a = jest.fn()
    const b = jest.fn()
    const offA = registerCanvasEditFlusher("doc-a", a)
    const offB = registerCanvasEditFlusher("doc-b", b)
    flushPendingCanvasEdits("doc-a")
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    offA()
    offB()
  })

  it("stops flushing once unregistered", () => {
    const flush = jest.fn()
    const off = registerCanvasEditFlusher("doc-c", flush)
    off()
    flushPendingCanvasEdits("doc-c")
    expect(flush).not.toHaveBeenCalled()
  })

  it("keeps going when one flusher throws", () => {
    const failing = jest.fn(() => {
      throw new Error("editor gone")
    })
    const working = jest.fn()
    const offFailing = registerCanvasEditFlusher("doc-d", failing)
    const offWorking = registerCanvasEditFlusher("doc-d", working)
    expect(() => flushPendingCanvasEdits("doc-d")).not.toThrow()
    expect(working).toHaveBeenCalled()
    offFailing()
    offWorking()
  })

  it("does nothing for a document nobody is editing", () => {
    expect(() => flushPendingCanvasEdits("doc-none")).not.toThrow()
  })
})
