import * as Y from "yjs"

import {
  encodeCrdtAnchor,
  lineRangeFromOffsets,
  resolveCrdtAnchor,
  type CanvasCrdtAnchor,
} from "./relative-anchor"

function docWith(content: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc()
  const text = doc.getText("content")
  text.insert(0, content)
  return { doc, text }
}

describe("encodeCrdtAnchor", () => {
  it("names a range inside the document", () => {
    const { text } = docWith("hello world")
    expect(encodeCrdtAnchor(text, 6, 11)).toEqual({
      anchor: expect.any(String),
      head: expect.any(String),
    })
  })

  it("refuses offsets that describe no range, rather than clamping them", () => {
    // A clamped anchor points at the wrong text and never says so.
    const { text } = docWith("hello")
    expect(encodeCrdtAnchor(text, -1, 3)).toBeNull()
    expect(encodeCrdtAnchor(text, 3, 1)).toBeNull()
    expect(encodeCrdtAnchor(text, 0, 99)).toBeNull()
    expect(encodeCrdtAnchor(text, 1.5, 3)).toBeNull()
  })

  it("accepts an empty range, which is where a caret comment sits", () => {
    const { text } = docWith("hello")
    expect(encodeCrdtAnchor(text, 3, 3)).not.toBeNull()
  })
})

describe("resolveCrdtAnchor", () => {
  it("returns the same range when nothing changed", () => {
    const { doc, text } = docWith("hello world")
    const anchor = encodeCrdtAnchor(text, 6, 11)!
    expect(resolveCrdtAnchor(doc, anchor)).toEqual({ start: 6, end: 11 })
  })

  it("moves with the text when something is inserted above it", () => {
    // The whole point. An absolute offset would now be five characters wrong,
    // and the revision check would have greyed the comment out instead.
    const { doc, text } = docWith("hello world")
    const anchor = encodeCrdtAnchor(text, 6, 11)!
    text.insert(0, "SAY ")
    const resolved = resolveCrdtAnchor(doc, anchor)!
    expect(resolved).toEqual({ start: 10, end: 15 })
    expect(text.toString().slice(resolved.start, resolved.end)).toBe("world")
  })

  it("moves when text above it is deleted", () => {
    const { doc, text } = docWith("hello world")
    const anchor = encodeCrdtAnchor(text, 6, 11)!
    text.delete(0, 6)
    const resolved = resolveCrdtAnchor(doc, anchor)!
    expect(text.toString().slice(resolved.start, resolved.end)).toBe("world")
  })

  it("keeps naming the same characters through a concurrent edit by a peer", () => {
    const opener = new Y.Doc()
    const openerText = opener.getText("content")
    openerText.insert(0, "hello world")

    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(opener))
    const peerText = peer.getText("content")

    const anchor = encodeCrdtAnchor(openerText, 6, 11)!
    // Both edit at once, then converge.
    openerText.insert(5, ",")
    peerText.insert(0, ">> ")
    Y.applyUpdate(opener, Y.encodeStateAsUpdate(peer))
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(opener))

    const resolved = resolveCrdtAnchor(opener, anchor)!
    expect(openerText.toString().slice(resolved.start, resolved.end)).toBe("world")
    expect(openerText.toString()).toBe(peerText.toString())
  })

  it("leaves an insertion at the start boundary outside the range", () => {
    // The comment was about the characters that were there, not about
    // whatever gets typed against their edge.
    const { doc, text } = docWith("hello world")
    const anchor = encodeCrdtAnchor(text, 6, 11)!
    text.insert(6, "big ")
    const resolved = resolveCrdtAnchor(doc, anchor)!
    expect(text.toString().slice(resolved.start, resolved.end)).toBe("world")
  })

  it("leaves an insertion at the end boundary outside the range", () => {
    const { doc, text } = docWith("hello world")
    const anchor = encodeCrdtAnchor(text, 6, 11)!
    text.insert(11, "wide")
    const resolved = resolveCrdtAnchor(doc, anchor)!
    expect(text.toString().slice(resolved.start, resolved.end)).toBe("world")
  })

  it("collapses rather than pointing at whatever moved in when the text is deleted", () => {
    const { doc, text } = docWith("hello world")
    const anchor = encodeCrdtAnchor(text, 6, 11)!
    text.delete(6, 5)
    const resolved = resolveCrdtAnchor(doc, anchor)
    // Both ends survive as the same collapsed point, so the comment is
    // reported as covering nothing rather than covering its neighbour.
    expect(resolved).toEqual({ start: 6, end: 6 })
  })

  it("returns null for an anchor that is not decodable", () => {
    const { doc } = docWith("hello")
    const nonsense: CanvasCrdtAnchor = { anchor: "not base64 !!", head: "also not" }
    expect(resolveCrdtAnchor(doc, nonsense)).toBeNull()
  })

  it("returns null for an anchor from a different document", () => {
    const { text } = docWith("hello world")
    const anchor = encodeCrdtAnchor(text, 6, 11)!
    const other = new Y.Doc()
    other.getText("content").insert(0, "unrelated")
    expect(resolveCrdtAnchor(other, anchor)).toBeNull()
  })
})

describe("lineRangeFromOffsets", () => {
  it("reports one-based lines and columns", () => {
    expect(lineRangeFromOffsets("abc", 0, 3)).toEqual({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 4,
    })
  })

  it("counts a newline into the next line", () => {
    const content = "one\ntwo\nthree"
    expect(lineRangeFromOffsets(content, 4, 7)).toEqual({
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 4,
    })
  })

  it("spans lines", () => {
    const content = "one\ntwo\nthree"
    const range = lineRangeFromOffsets(content, 0, 9)
    expect(range.startLine).toBe(1)
    expect(range.endLine).toBe(3)
  })

  it("clamps an offset past the end rather than reporting a negative column", () => {
    const range = lineRangeFromOffsets("abc", 0, 999)
    expect(range.endLine).toBe(1)
    expect(range.endColumn).toBe(4)
  })
})
