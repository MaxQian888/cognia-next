import JSZip from "jszip"
import { createDocument, applyDocumentOperations } from "./model"
import { exportDocx, exportTranscriptDocx, importDocx, validateDocxRoundTrip } from "./docx"

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

async function fixture(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }))
}

async function readPackageXml(bytes: Uint8Array, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const file = zip.file(name)
  return file ? file.async("string") : ""
}

const documentXml = (body: string) =>
  `<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`

it("exports a native DOCX, reopens it, and imports its text", async () => {
  const model = applyDocumentOperations(createDocument("Brief", "Hello Cognia"), [
    { op: "appendHeading", text: "Details", level: 2 },
    {
      op: "appendTable",
      rows: [
        ["A", "B"],
        ["1", "2"],
      ],
    },
  ])
  const bytes = await exportDocx(model)
  await expect(validateDocxRoundTrip(bytes)).resolves.toMatchObject({
    valid: true,
    text: expect.stringContaining("Hello Cognia"),
  })
  const imported = await importDocx(bytes, "brief.docx")
  expect(imported).toMatchObject({ title: "Brief", sourceFilename: "brief.docx" })
  expect(imported.blocks.some((block) => block.type === "table")).toBe(true)
})

it("exports ordered list items with real decimal numbering", async () => {
  const model = applyDocumentOperations(createDocument("Steps"), [
    { op: "appendListItem", text: "First", ordered: true },
    { op: "appendListItem", text: "Bullet", ordered: false },
  ])
  const xml = await readPackageXml(await exportDocx(model), "word/numbering.xml")
  expect(xml).toContain('w:val="decimal"')
  const doc = await readPackageXml(await exportDocx(model), "word/document.xml")
  expect(doc).toContain("<w:numPr>")
})

it("imports headings, ordered/unordered lists, and tables structurally", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(`
      <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Section</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>Ordered item</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:numId w:val="6"/></w:numPr></w:pPr><w:r><w:t>Bullet item</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>H1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>H2</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:t>Tail</w:t></w:r></w:p>`),
    "word/numbering.xml": `<?xml version="1.0"?><w:numbering ${W}>
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
      <w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num>
      <w:num w:numId="6"><w:abstractNumId w:val="1"/></w:num>
    </w:numbering>`,
  })
  const model = await importDocx(bytes, "structured.docx")
  expect(model.blocks[0]).toMatchObject({ type: "heading", level: 2, text: "Section" })
  expect(model.blocks[1]).toMatchObject({ type: "list-item", ordered: true, text: "Ordered item" })
  expect(model.blocks[2]).toMatchObject({ type: "list-item", ordered: false, text: "Bullet item" })
  expect(model.blocks[3]).toMatchObject({
    type: "table",
    rows: [
      ["H1", "H2"],
      ["a", "b"],
    ],
  })
  expect(model.blocks[4]).toMatchObject({ type: "paragraph", text: "Tail" })
})

it("imports Word comments anchored to blocks with resolved state", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(`
      <w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Annotated</w:t></w:r><w:commentRangeEnd w:id="0"/></w:p>
      <w:p><w:r><w:t>Plain</w:t></w:r></w:p>`),
    "word/comments.xml": `<?xml version="1.0"?>
      <w:comments ${W} xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
        <w:comment w:id="0" w:author="Jane" w14:paraId="ABC123"><w:p><w:r><w:t>Check this</w:t></w:r></w:p></w:comment>
      </w:comments>`,
    "word/commentsExtended.xml": `<?xml version="1.0"?>
      <w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
        <w15:commentEx w15:paraId="ABC123" w15:done="1"/>
      </w15:commentsEx>`,
  })
  const model = await importDocx(bytes, "reviewed.docx")
  expect(model.comments).toHaveLength(1)
  expect(model.comments[0]).toMatchObject({
    blockId: model.blocks[0].id,
    author: "Jane",
    text: "Check this",
    resolved: true,
  })
  // Imported comments are real model comments — not loss warnings.
  expect(model.importedFeatures).not.toContain("comments")
})

it("preserves line breaks, tabs, and numeric XML entities on import", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(`
      <w:p><w:r><w:t>Line one</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Line two</w:t></w:r></w:p>
      <w:p><w:r><w:tab/></w:r><w:r><w:t>Indented &amp; &#x4E2D;&#25991;</w:t></w:r></w:p>`),
  })
  const model = await importDocx(bytes, "text.docx")
  expect(model.blocks[0]).toMatchObject({ text: "Line one\nLine two" })
  expect(model.blocks[1]).toMatchObject({ text: "\tIndented & 中文" })
})

it("reads the document title from core.xml", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(`<w:p><w:r><w:t>Body</w:t></w:r></w:p>`),
    "docProps/core.xml": `<?xml version="1.0"?>
      <cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quarterly Plan</dc:title></cp:coreProperties>`,
  })
  const model = await importDocx(bytes, "fallback.docx")
  expect(model.title).toBe("Quarterly Plan")
})

it("flags unsupported features without blocking clean documents", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(`
      <w:p><w:hyperlink w:id="rId1"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>
      <w:p><w:r><w:instrText> TOC </w:instrText></w:r></w:p>`),
    "word/footnotes.xml": "<w:footnotes/>",
    "word/media/image1.png": "png",
  })
  const model = await importDocx(bytes, "rich.docx")
  expect(model.importedFeatures).toEqual(
    expect.arrayContaining(["images", "hyperlinks", "footnotes", "fields (TOC, cross-references)"])
  )
  // The link text still lands in the paragraph text.
  expect(model.blocks[0]).toMatchObject({ text: "link" })

  const clean = await fixture({
    "word/document.xml": documentXml(`<w:p><w:r><w:t>Clean</w:t></w:r></w:p>`),
  })
  expect((await importDocx(clean, "clean.docx")).importedFeatures).toEqual([])
})

it("exports real Word comments and pending tracked changes", async () => {
  const model = applyDocumentOperations(createDocument("Review", "Original"), [
    { op: "replaceText", blockId: "b1", text: "Edited", trackChange: true },
    { op: "addComment", blockId: "b1", text: "Check", author: "Jane" },
  ])
  const bytes = await exportDocx(model)
  const commentsXml = await readPackageXml(bytes, "word/comments.xml")
  expect(commentsXml).toContain("Check")
  expect(commentsXml).toContain('w:author="Jane"')
  const documentXml = await readPackageXml(bytes, "word/document.xml")
  expect(documentXml).toContain("<w:ins")
  expect(documentXml).toContain("<w:del")
  expect(documentXml).toContain("commentRangeStart")
})

it("exports a session transcript as a DOCX blob", async () => {
  const blob = await exportTranscriptDocx(
    {
      session: { title: "Design review" },
      messages: [
        { role: "user", content: "Sketch the flow" },
        {
          role: "assistant",
          parts: [
            { type: "text", text: "Here is the plan." },
            { type: "reasoning", text: "thinking" },
          ],
        },
      ],
    },
    { title: "Transcript", user: "User", assistant: "Assistant", system: "System" }
  )
  expect(blob.type).toContain("wordprocessingml")
  const text = (await validateDocxRoundTrip(new Uint8Array(await blob.arrayBuffer()))).text
  expect(text).toContain("Design review")
  expect(text).toContain("Here is the plan.")
  expect(text).not.toContain("thinking")
})

it("rejects invalid DOCX packages", async () => {
  await expect(importDocx(new Uint8Array([1, 2, 3]), "bad.docx")).rejects.toThrow()
})
