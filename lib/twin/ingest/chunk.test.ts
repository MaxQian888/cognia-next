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
