/**
 * Tests for EPUB Parser
 */

import JSZip from "jszip"
import { parseEPUB, extractEPUBEmbeddableContent, type EPUBParseResult } from "./epub-parser"

async function createValidEpubBuffer(): Promise<ArrayBuffer> {
  const zip = new JSZip()

  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>`
  )

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?>
    <package version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <metadata>
        <dc:title>Sample Book</dc:title>
        <dc:creator>Author A</dc:creator>
        <dc:language>en</dc:language>
      </metadata>
      <manifest>
        <item id="chap1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
        <item id="chap2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine>
        <itemref idref="chap1"/>
        <itemref idref="chap2"/>
      </spine>
    </package>`
  )

  zip.file(
    "OEBPS/chapter1.xhtml",
    "<html><head><title>Intro</title></head><body><h1>Intro</h1><p>Chapter one text.</p></body></html>"
  )
  zip.file(
    "OEBPS/chapter2.xhtml",
    "<html><head><title>Next</title></head><body><h1>Next</h1><p>Chapter two text.</p></body></html>"
  )

  const bytes = await zip.generateAsync({ type: "uint8array" })
  return Uint8Array.from(bytes).buffer
}

describe("parseEPUB", () => {
  it("parses metadata and chapter text", async () => {
    const buffer = await createValidEpubBuffer()
    const result = await parseEPUB(buffer)

    expect(result.chapterCount).toBe(2)
    expect(result.metadata.title).toBe("Sample Book")
    expect(result.metadata.author).toBe("Author A")
    expect(result.chapters[0].title).toBe("Intro")
    expect(result.text).toContain("Chapter one text.")
    expect(result.text).toContain("Chapter two text.")
  })

  it("throws explicit error for invalid archive", async () => {
    const corrupted = new Uint8Array([9, 8, 7, 6]).buffer
    await expect(parseEPUB(corrupted)).rejects.toThrow("Failed to parse EPUB file")
  })

  it("throws when no readable chapter content exists", async () => {
    const zip = new JSZip()
    zip.file(
      "META-INF/container.xml",
      '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'
    )
    zip.file(
      "content.opf",
      '<package><manifest><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>'
    )
    zip.file("c1.xhtml", "<html><body><script>var a=1;</script></body></html>")

    const bytes = await zip.generateAsync({ type: "uint8array" })
    const buffer = Uint8Array.from(bytes).buffer

    await expect(parseEPUB(buffer)).rejects.toThrow("No readable chapter content found")
  })
})

describe("extractEPUBEmbeddableContent", () => {
  it("includes metadata and chapter content", () => {
    const result: EPUBParseResult = {
      text: "## Intro\nHello chapter",
      chapterCount: 1,
      chapters: [{ id: "chap1", href: "chap1.xhtml", title: "Intro", text: "Hello chapter" }],
      metadata: { title: "Book A", author: "Author B" },
    }

    const embeddable = extractEPUBEmbeddableContent(result)

    expect(embeddable).toContain("Title: Book A")
    expect(embeddable).toContain("Author: Author B")
    expect(embeddable).toContain("Hello chapter")
  })
})
