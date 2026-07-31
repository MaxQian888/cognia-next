/**
 * Tests for Presentation Parser
 */

import JSZip from "jszip"
import {
  parsePresentation,
  extractPresentationEmbeddableContent,
  type PresentationParseResult,
} from "./presentation-parser"

async function createValidPptxBuffer(): Promise<ArrayBuffer> {
  const zip = new JSZip()

  zip.file(
    "ppt/slides/slide1.xml",
    "<p:sld><a:t>Quarterly Review</a:t><a:t>Revenue up 20%</a:t></p:sld>"
  )
  zip.file("ppt/slides/slide2.xml", "<p:sld><a:t>Roadmap</a:t><a:t>Launch in Q3</a:t></p:sld>")
  zip.file(
    "docProps/core.xml",
    "<cp:coreProperties><dc:title>Q2 Deck</dc:title><dc:creator>Alice</dc:creator></cp:coreProperties>"
  )

  const bytes = await zip.generateAsync({ type: "uint8array" })
  return Uint8Array.from(bytes).buffer
}

describe("parsePresentation", () => {
  it("parses slides and metadata from valid pptx", async () => {
    const buffer = await createValidPptxBuffer()
    const result = await parsePresentation(buffer)

    expect(result.slideCount).toBe(2)
    expect(result.slides[0].slideNumber).toBe(1)
    expect(result.slides[0].text).toContain("Quarterly Review")
    expect(result.metadata.title).toBe("Q2 Deck")
    expect(result.metadata.author).toBe("Alice")
    expect(result.text).toContain("Slide 1")
    expect(result.text).toContain("Launch in Q3")
  })

  it("throws explicit error for corrupted data", async () => {
    const corrupted = new Uint8Array([1, 2, 3, 4]).buffer
    await expect(parsePresentation(corrupted)).rejects.toThrow("Failed to parse presentation file")
  })

  it("throws when slides have no readable text", async () => {
    const zip = new JSZip()
    zip.file("ppt/slides/slide1.xml", "<p:sld><a:r></a:r></p:sld>")
    const bytes = await zip.generateAsync({ type: "uint8array" })
    const buffer = Uint8Array.from(bytes).buffer

    await expect(parsePresentation(buffer)).rejects.toThrow("No readable text content found")
  })
})

describe("extractPresentationEmbeddableContent", () => {
  it("includes metadata and body text", () => {
    const result: PresentationParseResult = {
      text: "## Slide 1\nOverview text",
      slideCount: 1,
      slides: [{ slideNumber: 1, title: "Overview", text: "Overview text" }],
      metadata: { title: "Deck Title", author: "Bob" },
    }

    const embeddable = extractPresentationEmbeddableContent(result)

    expect(embeddable).toContain("Title: Deck Title")
    expect(embeddable).toContain("Author: Bob")
    expect(embeddable).toContain("Overview text")
  })
})
