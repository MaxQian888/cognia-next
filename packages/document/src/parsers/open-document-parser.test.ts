import JSZip from "jszip"
import {
  parseOpenDocumentPresentation,
  parseOpenDocumentSpreadsheet,
  parseOpenDocumentText,
} from "./open-document-parser"

async function createOpenDocumentBuffer(entries: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip()

  for (const [path, content] of Object.entries(entries)) {
    zip.file(path, content)
  }

  const bytes = await zip.generateAsync({ type: "uint8array" })
  return Uint8Array.from(bytes).buffer
}

describe("open-document-parser", () => {
  it("parses readable text and metadata from odt content", async () => {
    const buffer = await createOpenDocumentBuffer({
      "content.xml": `
        <office:document-content>
          <text:h text:outline-level="1">Chapter 1</text:h>
          <text:p>OpenDocument text paragraph</text:p>
        </office:document-content>
      `,
      "meta.xml": `
        <office:document-meta>
          <dc:title>Notebook</dc:title>
          <dc:creator>Alice</dc:creator>
        </office:document-meta>
      `,
    })

    const result = await parseOpenDocumentText(buffer)

    expect(result.text).toContain("Chapter 1")
    expect(result.text).toContain("OpenDocument text paragraph")
    expect(result.metadata?.title).toBe("Notebook")
    expect(result.metadata?.author).toBe("Alice")
  })

  it("parses sheet content from ods content", async () => {
    const buffer = await createOpenDocumentBuffer({
      "content.xml": `
        <office:document-content>
          <table:table table:name="Sheet A">
            <table:table-row>
              <table:table-cell><text:p>Name</text:p></table:table-cell>
              <table:table-cell><text:p>Value</text:p></table:table-cell>
            </table:table-row>
            <table:table-row>
              <table:table-cell><text:p>Alpha</text:p></table:table-cell>
              <table:table-cell><text:p>42</text:p></table:table-cell>
            </table:table-row>
          </table:table>
        </office:document-content>
      `,
    })

    const result = await parseOpenDocumentSpreadsheet(buffer)

    expect(result.sheetNames).toEqual(["Sheet A"])
    expect(result.sheets[0].data[1]).toEqual(["Alpha", "42"])
    expect(result.text).toContain("Sheet A")
  })

  it("parses slide text from odp content", async () => {
    const buffer = await createOpenDocumentBuffer({
      "content.xml": `
        <office:document-content>
          <draw:page draw:name="page1">
            <text:p>Roadmap</text:p>
            <text:p>Launch in Q4</text:p>
          </draw:page>
        </office:document-content>
      `,
      "meta.xml": `
        <office:document-meta>
          <dc:title>Launch Deck</dc:title>
          <dc:creator>Bob</dc:creator>
        </office:document-meta>
      `,
    })

    const result = await parseOpenDocumentPresentation(buffer)

    expect(result.slideCount).toBe(1)
    expect(result.slides[0].text).toContain("Roadmap")
    expect(result.metadata.title).toBe("Launch Deck")
  })

  it("throws actionable error for encrypted open document archives", async () => {
    const buffer = await createOpenDocumentBuffer({
      "META-INF/manifest.xml": `
        <manifest:manifest>
          <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
          <manifest:encryption-data />
        </manifest:manifest>
      `,
      "content.xml": "<office:document-content />",
    })

    await expect(parseOpenDocumentText(buffer)).rejects.toThrow("password protected")
  })
})
