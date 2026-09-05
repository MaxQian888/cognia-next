/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import * as Y from "yjs"

import { useCanvasCommentAnchors } from "./use-canvas-comment-anchors"
import type { ContextCommentAnchor } from "@/types/context-comment"

let doc: Y.Doc | null = null
let text: Y.Text | null = null
let sessionId: string | null = "session-1"

jest.mock("@/lib/canvas/collaboration/crdt-store", () => ({
  crdtStore: {
    sessionIdForDocument: () => sessionId,
    getYDoc: () => doc,
    getYText: () => text,
  },
}))

function seed(content: string) {
  doc = new Y.Doc()
  text = doc.getText("content")
  text.insert(0, content)
}

beforeEach(() => {
  sessionId = "session-1"
  seed("hello world")
})

describe("encode", () => {
  it("names the selection inside the shared document", () => {
    const { result } = renderHook(() => useCanvasCommentAnchors("doc-1"))
    expect(result.current.encode(6, 11)).toEqual({
      anchor: expect.any(String),
      head: expect.any(String),
    })
  })

  it("returns nothing when no session is open, so the comment stores as before", () => {
    // Degrading to nothing rather than to something wrong: with no shared
    // document there is nothing to anchor into.
    sessionId = null
    const { result } = renderHook(() => useCanvasCommentAnchors("doc-1"))
    expect(result.current.encode(6, 11)).toBeUndefined()
  })

  it("returns nothing for a selection outside the document", () => {
    const { result } = renderHook(() => useCanvasCommentAnchors("doc-1"))
    expect(result.current.encode(0, 999)).toBeUndefined()
  })

  it("returns nothing when there is no document at all", () => {
    const { result } = renderHook(() => useCanvasCommentAnchors(null))
    expect(result.current.encode(0, 1)).toBeUndefined()
  })
})

describe("resolve", () => {
  function anchorFor(start: number, end: number): ContextCommentAnchor {
    const { result } = renderHook(() => useCanvasCommentAnchors("doc-1"))
    return {
      kind: "text-range",
      start,
      end,
      revision: "v1",
      crdt: result.current.encode(start, end),
    }
  }

  it("moves the comment with the text it was written about", () => {
    // The behaviour the whole change exists for. With offsets alone this
    // comment would now point four characters early, and the revision check
    // would have greyed it out rather than moving it.
    const anchor = anchorFor(6, 11)
    text!.insert(0, "SAY ")

    const { result } = renderHook(() => useCanvasCommentAnchors("doc-1"))
    const resolved = result.current.resolve(anchor)
    expect(resolved).toMatchObject({ start: 10, end: 15 })
    expect(text!.toString().slice(10, 15)).toBe("world")
  })

  it("recomputes the line range that the comment UI shows", () => {
    const anchor = anchorFor(6, 11)
    text!.insert(0, "a new first line\n")

    const { result } = renderHook(() => useCanvasCommentAnchors("doc-1"))
    const resolved = result.current.resolve(anchor)
    expect(resolved).toMatchObject({
      lineRange: expect.objectContaining({ startLine: 2, endLine: 2 }),
    })
  })

  it("hands back the stored anchor untouched when the commented text was deleted", () => {
    // Deleting the span collapses both ends onto each other. Reporting that
    // empty range would render the comment as being about wherever the
    // collapse landed, which is the top of the document and never what was
    // meant. Keeping the stored offsets lets the revision check grey it out.
    const anchor = anchorFor(6, 11)
    text!.delete(6, 5)

    const { result } = renderHook(() => useCanvasCommentAnchors("doc-1"))
    expect(result.current.resolve(anchor)).toBe(anchor)
  })

  it("still moves a caret comment, which was empty to begin with", () => {
    // An empty resolved range is only suspicious when the comment used to
    // cover something.
    const anchor = anchorFor(6, 6)
    text!.insert(0, "SAY ")

    const { result } = renderHook(() => useCanvasCommentAnchors("doc-1"))
    expect(result.current.resolve(anchor)).toMatchObject({ start: 10, end: 10 })
  })

  it("leaves an anchor with no crdt half alone", () => {
    const legacy: ContextCommentAnchor = {
      kind: "text-range",
      start: 1,
      end: 2,
      revision: "v1",
    }
    const { result } = renderHook(() => useCanvasCommentAnchors("doc-1"))
    expect(result.current.resolve(legacy)).toBe(legacy)
  })

  it("leaves a whole-resource anchor alone", () => {
    const resourceAnchor: ContextCommentAnchor = { kind: "resource", revision: "v1" }
    const { result } = renderHook(() => useCanvasCommentAnchors("doc-1"))
    expect(result.current.resolve(resourceAnchor)).toBe(resourceAnchor)
  })

  it("leaves the anchor alone when the session has since closed", () => {
    const anchor = anchorFor(6, 11)
    sessionId = null
    const { result } = renderHook(() => useCanvasCommentAnchors("doc-1"))
    expect(result.current.resolve(anchor)).toBe(anchor)
  })
})
