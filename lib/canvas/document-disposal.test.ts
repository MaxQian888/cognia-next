import {
  canvasDocumentDisposerNames,
  disposeCanvasDocument,
  registerCanvasDocumentDisposer,
  unregisterCanvasDocumentDisposer,
} from "./document-disposal"

const warn = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: {
    canvas: {
      warn: (...args: unknown[]) => warn(...args),
    },
  },
}))

afterEach(() => {
  for (const name of canvasDocumentDisposerNames()) {
    unregisterCanvasDocumentDisposer(name)
  }
  warn.mockClear()
})

describe("canvas document disposal registry", () => {
  it("calls every registered disposer with the document id", () => {
    const comments = jest.fn()
    const collaboration = jest.fn()
    registerCanvasDocumentDisposer("comments", comments)
    registerCanvasDocumentDisposer("collaboration", collaboration)

    disposeCanvasDocument("doc_1")

    expect(comments).toHaveBeenCalledWith("doc_1")
    expect(collaboration).toHaveBeenCalledWith("doc_1")
  })

  it("registers idempotently by name", () => {
    // Jest re-evaluates modules across suites. A registry that appended would
    // call a store's disposer once per re-evaluation.
    const first = jest.fn()
    const second = jest.fn()
    registerCanvasDocumentDisposer("comments", first)
    registerCanvasDocumentDisposer("comments", second)

    disposeCanvasDocument("doc_1")

    expect(canvasDocumentDisposerNames()).toEqual(["comments"])
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("keeps going when one disposer throws, and says which one", () => {
    // The document row is already gone by this point, so one owner failing to
    // let go must not strand the others holding a reference to it.
    const survivor = jest.fn()
    registerCanvasDocumentDisposer("broken", () => {
      throw new Error("dexie is closed")
    })
    registerCanvasDocumentDisposer("survivor", survivor)

    expect(() => disposeCanvasDocument("doc_1")).not.toThrow()
    expect(survivor).toHaveBeenCalledWith("doc_1")
    expect(warn).toHaveBeenCalledWith(
      "canvas document disposer failed",
      expect.objectContaining({ disposer: "broken", documentId: "doc_1" })
    )
  })

  it("stops calling a disposer once it is unregistered", () => {
    const disposer = jest.fn()
    registerCanvasDocumentDisposer("comments", disposer)
    unregisterCanvasDocumentDisposer("comments")

    disposeCanvasDocument("doc_1")

    expect(disposer).not.toHaveBeenCalled()
    expect(canvasDocumentDisposerNames()).toEqual([])
  })

  it("is a no-op when nothing has registered", () => {
    expect(() => disposeCanvasDocument("doc_1")).not.toThrow()
  })
})
