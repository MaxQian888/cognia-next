/**
 * Coverage for `chunk.ts`. We don't re-test the underlying Cognia
 * `chunkDocument` (that's covered separately in `lib/ai/embedding/`); we
 * just check the format-aware strategy picker, the heading-trail inference,
 * and the offsets / metadata propagation.
 */

import { prepareChunks } from "./chunk"

describe("prepareChunks", () => {
  it("returns no chunks for an empty input", () => {
    const chunks = prepareChunks({
      redactedText: "",
      originalText: "",
      format: "markdown",
    })
    expect(chunks).toEqual([])
  })

  it("uses the heading strategy for markdown and inferes a heading trail", () => {
    const md = `# Onboarding\n\n## Day 1\n\nWelcome to the team. ${"x".repeat(900)}`
    const chunks = prepareChunks({
      redactedText: md,
      originalText: md,
      format: "markdown",
      options: { chunkSize: 500, chunkOverlap: 50 },
    })
    expect(chunks.length).toBeGreaterThan(0)
    const first = chunks[0]
    expect(first.strategy).toBe("heading")
    expect(first.tokenCount).toBeGreaterThan(0)
    expect(first.charStart).toBeGreaterThanOrEqual(0)
    expect(first.charEnd).toBeGreaterThan(first.charStart)
    expect(first.metadata.headingPath?.[0]).toBe("Onboarding")
  })

  it("uses paragraph strategy for chat exports", () => {
    const chat = "speaker A says hello\n\nspeaker B replies\n\nspeaker A: " + "x".repeat(800)
    const chunks = prepareChunks({
      redactedText: chat,
      originalText: chat,
      format: "slack-export",
      options: { chunkSize: 400, chunkOverlap: 50 },
    })
    expect(chunks[0].strategy).toBe("paragraph")
  })

  it("uses code strategy for source files", () => {
    const code = ["function a() { return 1 }", "function b() { return 2 }"].join("\n\n")
    const chunks = prepareChunks({
      redactedText: code,
      originalText: code,
      format: "code",
      options: { chunkSize: 50, chunkOverlap: 10 },
    })
    expect(chunks[0].strategy).toBe("code")
  })

  it("merges baseMetadata onto every chunk", () => {
    const text =
      Array.from({ length: 8 }, (_, i) => `Paragraph ${i}.\n\n`).join("") + "x".repeat(2500)
    const chunks = prepareChunks({
      redactedText: text,
      originalText: text,
      // chat-export uses the paragraph strategy and reliably emits multiple
      // chunks for inputs of this size.
      format: "slack-export",
      baseMetadata: { filePath: "/repo/notes.md" },
      options: { chunkSize: 300, chunkOverlap: 20 },
    })
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    for (const chunk of chunks) {
      expect(chunk.metadata.filePath).toBe("/repo/notes.md")
    }
  })

  it("respects an explicit strategy override", () => {
    const text = "# Foo\n\n## Bar\n\nbody " + "x".repeat(800)
    const chunks = prepareChunks({
      redactedText: text,
      originalText: text,
      format: "markdown",
      strategy: "fixed",
      options: { chunkSize: 200, chunkOverlap: 20 },
    })
    expect(chunks[0].strategy).toBe("fixed")
    // No heading inference when strategy is not "heading".
    expect(chunks[0].metadata.headingPath).toBeUndefined()
  })
})

describe("prepareChunks — pageMap stamping", () => {
  const BOX_1 = { x: 10, y: 10, width: 100, height: 50 }
  const BOX_2 = { x: 200, y: 300, width: 60, height: 40 }

  it("stamps pageNumber and the page bboxUnion for a within-page chunk", () => {
    const pageOne = "first page paragraph body"
    const pageTwo = "second page paragraph body"
    const text = `${pageOne}\n\n${pageTwo}`
    const chunks = prepareChunks({
      redactedText: text,
      originalText: text,
      format: "pdf",
      strategy: "paragraph",
      // Small chunk size so each paragraph (= page) becomes its own chunk.
      options: { chunkSize: 30, chunkOverlap: 0 },
      pageMap: [
        { pageNumber: 1, charStart: 0, charEnd: pageOne.length, bboxUnion: BOX_1 },
        { pageNumber: 2, charStart: pageOne.length + 2, charEnd: text.length, bboxUnion: BOX_2 },
      ],
    })

    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0].metadata.pageNumber).toBe(1)
    expect(chunks[0].metadata.pageEnd).toBeUndefined()
    expect(chunks[0].metadata.bboxUnion).toEqual(BOX_1)
    const last = chunks[chunks.length - 1]
    expect(last.metadata.pageNumber).toBe(2)
    expect(last.metadata.bboxUnion).toEqual(BOX_2)
  })

  it("stamps pageEnd and the cross-page bbox union for a spanning chunk", () => {
    // One unbroken paragraph that the page boundary cuts through the middle
    // of — the single chunk overlaps both pages.
    const text = "an unbroken run of words that crosses the synthetic page boundary midway"
    const mid = Math.floor(text.length / 2)
    const chunks = prepareChunks({
      redactedText: text,
      originalText: text,
      format: "pdf",
      strategy: "paragraph",
      pageMap: [
        { pageNumber: 1, charStart: 0, charEnd: mid, bboxUnion: BOX_1 },
        { pageNumber: 2, charStart: mid, charEnd: text.length, bboxUnion: BOX_2 },
      ],
    })

    expect(chunks).toHaveLength(1)
    expect(chunks[0].metadata.pageNumber).toBe(1)
    expect(chunks[0].metadata.pageEnd).toBe(2)
    // Union of BOX_1 (10..110, 10..60) and BOX_2 (200..260, 300..340).
    expect(chunks[0].metadata.bboxUnion).toEqual({ x: 10, y: 10, width: 250, height: 330 })
  })

  it("omits bboxUnion when no overlapped page carries one", () => {
    const text = "page text without any spatial information at all"
    const chunks = prepareChunks({
      redactedText: text,
      originalText: text,
      format: "pdf",
      strategy: "paragraph",
      pageMap: [{ pageNumber: 3, charStart: 0, charEnd: text.length }],
    })

    expect(chunks[0].metadata.pageNumber).toBe(3)
    expect(chunks[0].metadata.bboxUnion).toBeUndefined()
  })

  it("leaves metadata untouched when no pageMap is provided", () => {
    const text = "pdf text chunked without a native pageMap"
    const chunks = prepareChunks({
      redactedText: text,
      originalText: text,
      format: "pdf",
    })

    expect(chunks[0].metadata.pageNumber).toBeUndefined()
    expect(chunks[0].metadata.pageEnd).toBeUndefined()
    expect(chunks[0].metadata.bboxUnion).toBeUndefined()
  })

  it("stamps nothing for a chunk that overlaps no page range", () => {
    const text = "short"
    const chunks = prepareChunks({
      redactedText: text,
      originalText: text,
      format: "pdf",
      strategy: "paragraph",
      // Page ranges entirely after the text — nothing overlaps.
      pageMap: [{ pageNumber: 9, charStart: 100, charEnd: 200, bboxUnion: BOX_1 }],
    })

    expect(chunks[0].metadata.pageNumber).toBeUndefined()
    expect(chunks[0].metadata.bboxUnion).toBeUndefined()
  })
})
