/** @jest-environment jsdom */
import {
  CANVAS_EXECUTE_EVENT,
  requestCanvasExecute,
  type CanvasExecuteDetail,
} from "./canvas-execute-event"

describe("requestCanvasExecute", () => {
  it("raises the execute event with the document id", () => {
    const seen: CanvasExecuteDetail[] = []
    const handler = (event: Event) => {
      seen.push((event as CustomEvent<CanvasExecuteDetail>).detail)
    }
    window.addEventListener(CANVAS_EXECUTE_EVENT, handler)

    requestCanvasExecute("doc_1")

    window.removeEventListener(CANVAS_EXECUTE_EVENT, handler)
    expect(seen).toEqual([{ documentId: "doc_1" }])
  })

  it("addresses one document, so a second panel ignores it", () => {
    // The execution panel filters on the id: two Canvas shells open on
    // different documents must not both run.
    const seen: string[] = []
    const handler = (event: Event) => {
      seen.push((event as CustomEvent<CanvasExecuteDetail>).detail.documentId)
    }
    window.addEventListener(CANVAS_EXECUTE_EVENT, handler)

    requestCanvasExecute("doc_a")
    requestCanvasExecute("doc_b")

    window.removeEventListener(CANVAS_EXECUTE_EVENT, handler)
    expect(seen).toEqual(["doc_a", "doc_b"])
  })
})
