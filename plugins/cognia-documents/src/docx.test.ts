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
      <w:p><w:r><w:instrText> TOC </w:instrText></w:r></w:p>
      <w:p><w:r><w:t>Cited</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`),
    "word/footnotes.xml": `<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"/><w:footnote w:id="1"><w:p><w:r><w:t>Note</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    "word/media/image1.png": "png",
  })
  const model = await importDocx(bytes, "rich.docx")
  expect(model.importedFeatures).toEqual(
    expect.arrayContaining(["images", "hyperlinks", "footnotes", "fields"])
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

it("does not flag the separator-only notes parts every DOCX writer emits", async () => {
  const separators = (kind: "footnote" | "endnote") =>
    `<w:${kind}s ${W}><w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}>` +
    `<w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}></w:${kind}s>`
  const bytes = await fixture({
    "word/document.xml": documentXml(`<w:p><w:r><w:t>Plain</w:t></w:r></w:p>`),
    "word/footnotes.xml": separators("footnote"),
    "word/endnotes.xml": separators("endnote"),
  })
  expect((await importDocx(bytes, "plain.docx")).importedFeatures).toEqual([])
})

it("flags a real endnote even without a body reference", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(`<w:p><w:r><w:t>Body</w:t></w:r></w:p>`),
    "word/endnotes.xml": `<w:endnotes ${W}><w:endnote w:id="2"><w:p><w:r><w:t>Orphan note</w:t></w:r></w:p></w:endnote></w:endnotes>`,
  })
  expect((await importDocx(bytes, "notes.docx")).importedFeatures).toEqual(["endnotes"])
})

it("round-trips its own export without false losses or a duplicated title", async () => {
  const model = applyDocumentOperations(createDocument("Quarterly brief", "Opening line"), [
    { op: "appendHeading", text: "Details", level: 2 },
    { op: "addComment", blockId: "b1", text: "Check", author: "Jane" },
  ])
  const imported = await importDocx(await exportDocx(model), "brief.docx")
  expect(imported.title).toBe("Quarterly brief")
  expect(imported.importedFeatures).toEqual([])
  expect(imported.blocks.map((block) => ("text" in block ? block.text : ""))).toEqual([
    "Opening line",
    "Details",
  ])
  expect(imported.blocks[0].id).toBe("b1")
  expect(imported.comments).toEqual([
    expect.objectContaining({ blockId: "b1", text: "Check", author: "Jane" }),
  ])
})

it("uses a leading Title paragraph as the title and keeps a Subtitle as content", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(`
      <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Visible title</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr><w:r><w:t>Sub</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body</w:t></w:r></w:p>`),
    "docProps/core.xml": `<?xml version="1.0"?>
      <cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Stale core title</dc:title></cp:coreProperties>`,
  })
  const model = await importDocx(bytes, "titled.docx")
  expect(model.title).toBe("Visible title")
  expect(model.blocks).toEqual([
    { id: "b1", type: "heading", level: 1, text: "Sub" },
    { id: "b2", type: "paragraph", text: "Body" },
  ])
})

it("keeps a leading Title paragraph as content when the caller names the document", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(`
      <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body</w:t></w:r></w:p>`),
  })
  const renamed = await importDocx(bytes, "q3.docx", undefined, "Q3 review")
  expect(renamed.title).toBe("Q3 review")
  expect(renamed.blocks).toEqual([
    { id: "b0", type: "heading", level: 1, text: "Quarterly Report" },
    { id: "b1", type: "paragraph", text: "Body" },
  ])
  // Naming it what it already says changes nothing: no duplicate heading.
  const same = await importDocx(bytes, "q3.docx", undefined, "Quarterly Report")
  expect(same.blocks.map((block) => block.id)).toEqual(["b1"])
})

it("keeps a Title-only document's comments on its title", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(
      `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:commentRangeStart w:id="0"/><w:r><w:t>Only a title</w:t></w:r></w:p>`
    ),
    "word/comments.xml": `<?xml version="1.0"?><w:comments ${W}><w:comment w:id="0" w:author="Jane"><w:p><w:r><w:t>Check</w:t></w:r></w:p></w:comment></w:comments>`,
  })
  const model = await importDocx(bytes, "title-only.docx")
  expect(model.title).toBe("Only a title")
  expect(model.blocks).toEqual([{ id: "b0", type: "heading", level: 1, text: "Only a title" }])
  expect(model.comments).toEqual([
    expect.objectContaining({ blockId: "b0", text: "Check", author: "Jane" }),
  ])
})

it("writes the caller's localized labels for empty comments and missing authors", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(
      `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Annotated</w:t></w:r></w:p>`
    ),
    "word/comments.xml": `<?xml version="1.0"?><w:comments ${W}><w:comment w:id="0"><w:p/></w:comment></w:comments>`,
  })
  const model = await importDocx(bytes, "", {
    emptyComment: "（空批注）",
    unknownAuthor: "未知",
    untitled: "文档",
  })
  expect(model.title).toBe("文档")
  expect(model.comments[0]).toMatchObject({ text: "（空批注）", author: "未知" })
})

it("rejects invalid DOCX packages", async () => {
  await expect(importDocx(new Uint8Array([1, 2, 3]), "bad.docx")).rejects.toThrow()
})
