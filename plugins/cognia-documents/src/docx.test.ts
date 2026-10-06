import JSZip from "jszip"
import { createDocument, applyDocumentOperations } from "./model"
import {
  DOCX_FEATURE_IDS,
  exportDocx,
  exportTranscriptDocx,
  importDocx,
  transcriptModel,
  validateDocxRoundTrip,
} from "./docx"
import manifest from "../plugin.json"

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

it("round-trips its own content without a duplicated title and reports discarded comment dates", async () => {
  const model = applyDocumentOperations(createDocument("Quarterly brief", "Opening line"), [
    { op: "appendHeading", text: "Details", level: 2 },
    { op: "addComment", blockId: "b1", text: "Check", author: "Jane" },
  ])
  const imported = await importDocx(await exportDocx(model), "brief.docx")
  expect(imported.title).toBe("Quarterly brief")
  expect(imported.importedFeatures).toEqual(["comment-metadata"])
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

it("localizes every detected loss in both plugin locales", () => {
  for (const locale of Object.values(manifest.i18n.locales)) {
    for (const id of DOCX_FEATURE_IDS) expect(locale).toHaveProperty([`feature.${id}`])
  }
})

it("reports formatting and objects flattened by the plain-text block model", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(`
      <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>
        <w:r><w:rPr><w:b/><w:rFonts w:eastAsia="宋体"/><w:color w:val="FF0000"/></w:rPr><w:t>中文</w:t></w:r>
        <m:oMath><m:r><m:t>x</m:t></m:r></m:oMath><w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>
      </w:p>
      <w:tbl><w:tblPr><w:tblW w:type="dxa" w:w="5000"/></w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:fill="FFFF00"/></w:tcPr>
        <w:p><w:r><w:t>Outer</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:tc></w:tr></w:tbl>`),
  })
  const model = await importDocx(bytes)
  expect(model.importedFeatures).toEqual(
    expect.arrayContaining([
      "inline-formatting",
      "paragraph-formatting",
      "table-formatting",
      "nested-tables",
      "equations-symbols",
    ])
  )
  expect(model.blocks[0]).toMatchObject({ text: "中文" })
})

it.each([
  ['<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'],
  ['<w:pgMar w:left="720" w:right="720"/>'],
  ['<w:cols w:num="2"/>'],
  ['<w:pgNumType w:start="5"/>'],
])("reports a single custom section: %s", async (properties) => {
  const bytes = await fixture({
    "word/document.xml": documentXml("<w:p><w:r><w:t>Body</w:t></w:r></w:p>").replace(
      "<w:sectPr/>",
      `<w:sectPr>${properties}</w:sectPr>`
    ),
  })
  expect((await importDocx(bytes)).importedFeatures).toContain("section-page-setup")
})

it("compares built-in style definitions rather than trusting the style name", async () => {
  const model = applyDocumentOperations(createDocument("Styled"), [
    { op: "appendHeading", text: "Heading", level: 2 },
  ])
  const zip = await JSZip.loadAsync(await exportDocx(model))
  const styles = await zip.file("word/styles.xml")!.async("string")
  zip.file(
    "word/styles.xml",
    styles.replace(
      /(<w:style\b[^>]*w:styleId="Heading2"[^>]*>)/,
      '$1<w:rPr><w:rFonts w:eastAsia="SimSun"/></w:rPr>'
    )
  )
  expect(
    (await importDocx(await zip.generateAsync({ type: "uint8array" }))).importedFeatures
  ).toContain("styles")
})

it("reports unknown styles and document defaults but ignores unused custom styles", async () => {
  const source = { "word/document.xml": documentXml("<w:p><w:r><w:t>Body</w:t></w:r></w:p>") }
  const custom = `<w:style w:type="paragraph" w:styleId="Unused"><w:rPr><w:b/></w:rPr></w:style>`
  const plain = await fixture({
    ...source,
    "word/styles.xml": `<w:styles ${W}>${custom}</w:styles>`,
  })
  expect((await importDocx(plain)).importedFeatures).not.toContain("styles")
  const defaults = await fixture({
    ...source,
    "word/styles.xml": `<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:eastAsia="SimSun"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`,
  })
  expect((await importDocx(defaults)).importedFeatures).toContain("styles")
  const used = await fixture({
    "word/document.xml": documentXml(
      '<w:p><w:pPr><w:pStyle w:val="Custom"/></w:pPr><w:r><w:t>Body</w:t></w:r></w:p>'
    ),
  })
  expect((await importDocx(used)).importedFeatures).toContain("styles")
})

it("preserves per-level ordered/bullet semantics while reporting custom numbering", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(
      [0, 1, 2]
        .map(
          (level) =>
            `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>Level ${level}</w:t></w:r></w:p>`
        )
        .join("")
    ),
    "word/numbering.xml": `<w:numbering ${W}><w:abstractNum w:abstractNumId="0">
      <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
      <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
      <w:lvl w:ilvl="2"><w:numFmt w:val="decimal"/></w:lvl>
      </w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="0"/>
      <w:lvlOverride w:ilvl="2"><w:lvl w:ilvl="2"><w:numFmt w:val="bullet"/></w:lvl></w:lvlOverride></w:num></w:numbering>`,
  })
  const imported = await importDocx(bytes)
  expect(imported.blocks).toEqual([
    expect.objectContaining({ ordered: true }),
    expect.objectContaining({ ordered: false, level: 1 }),
    expect.objectContaining({ ordered: false, level: 2 }),
  ])
  expect(imported.importedFeatures).toContain("custom-numbering")
})

it("reports partial comment anchors and reply metadata", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(
      '<w:p><w:r><w:t>Before </w:t></w:r><w:commentRangeStart w:id="1"/><w:r><w:t>Selection</w:t></w:r><w:commentRangeEnd w:id="1"/></w:p>'
    ),
    "word/comments.xml": `<w:comments ${W}><w:comment w:id="1" w:author="Reviewer" w:date="2026-01-01T00:00:00Z"><w:p><w:r><w:t>Note</w:t></w:r></w:p></w:comment></w:comments>`,
    "word/commentsExtended.xml":
      '<w15:commentsEx><w15:commentEx w15:paraId="ABC" w15:paraIdParent="DEF"/></w15:commentsEx>',
  })
  const imported = await importDocx(bytes)
  expect(imported.comments[0]).toMatchObject({ author: "Reviewer", text: "Note" })
  expect(imported.importedFeatures).toEqual(
    expect.arrayContaining(["comment-metadata", "comment-anchors"])
  )
})

it("reports table-cell comment anchors even when they span a complete paragraph", async () => {
  const bytes = await fixture({
    "word/document.xml": documentXml(
      '<w:tbl><w:tr><w:tc><w:p><w:commentRangeStart w:id="1"/><w:r><w:t>Cell</w:t></w:r><w:commentRangeEnd w:id="1"/></w:p></w:tc></w:tr></w:tbl>'
    ),
    "word/comments.xml": `<w:comments ${W}><w:comment w:id="1" w:author="Reviewer"><w:p><w:r><w:t>Note</w:t></w:r></w:p></w:comment></w:comments>`,
  })
  expect((await importDocx(bytes)).importedFeatures).toContain("comment-anchors")
})

it("reports custom numbering restarts even with the writer's standard list format", async () => {
  const model = applyDocumentOperations(createDocument("Restart"), [
    { op: "appendListItem", text: "Fifth", ordered: true },
  ])
  const zip = await JSZip.loadAsync(await exportDocx(model))
  const numbering = await zip.file("word/numbering.xml")!.async("string")
  zip.file(
    "word/numbering.xml",
    numbering.replaceAll('<w:startOverride w:val="1"/>', '<w:startOverride w:val="5"/>')
  )
  expect(
    (await importDocx(await zip.generateAsync({ type: "uint8array" }))).importedFeatures
  ).toContain("custom-numbering")
})

it("does not report reconstructed layout, tables, list definitions, and styles as lost", async () => {
  const model = applyDocumentOperations(createDocument("Native", "Body"), [
    {
      op: "appendTable",
      rows: [
        ["甲", "乙"],
        ["1", "2"],
      ],
    },
    { op: "appendListItem", text: "First", ordered: true },
    { op: "appendListItem", text: "Nested", ordered: true, level: 1 },
    { op: "appendListItem", text: "Bullet", ordered: false },
    { op: "appendMarkdown", markdown: "> Quote\n\n```js\nconst n = 1\n```" },
  ])
  expect((await importDocx(await exportDocx(model))).importedFeatures).toEqual([])
})

it("round-trips deep headings, nested lists, quotes, and multi-line code", async () => {
  const model = applyDocumentOperations(createDocument("Rich"), [
    { op: "appendHeading", level: 5, text: "Level five" },
    { op: "appendListItem", text: "outer", ordered: true },
    { op: "appendListItem", text: "inner", ordered: true, level: 1 },
    { op: "appendListItem", text: "bullet deep", level: 3 },
    { op: "insertBlock", afterBlockId: "b4", block: { type: "quote", text: "Quoted words" } },
    {
      op: "insertBlock",
      afterBlockId: "b5",
      block: { type: "code", text: "def f():\n    return 1\n\nprint(f())" },
    },
    { op: "addComment", blockId: "b6", text: "Check output" },
  ])
  const bytes = await exportDocx(model)
  const xml = await readPackageXml(bytes, "word/document.xml")
  expect(xml).toContain('w:val="Heading5"')
  expect(xml).toContain('w:val="Quote"')
  expect(xml).toContain('w:val="SourceCode"')
  const styles = await readPackageXml(bytes, "word/styles.xml")
  expect(styles).toContain('w:styleId="Quote"')
  expect(styles).toContain('w:styleId="SourceCode"')

  const imported = await importDocx(bytes, "rich.docx")
  expect(imported.blocks.map(({ id: _id, ...block }) => block)).toEqual([
    { type: "heading", level: 5, text: "Level five" },
    { type: "list-item", ordered: true, text: "outer" },
    { type: "list-item", ordered: true, level: 1, text: "inner" },
    { type: "list-item", ordered: false, level: 3, text: "bullet deep" },
    { type: "quote", text: "Quoted words" },
    { type: "code", text: "def f():\n    return 1\n\nprint(f())" },
  ])
  expect(imported.comments).toEqual([
    expect.objectContaining({ blockId: imported.blocks[5].id, text: "Check output" }),
  ])
})

it("merges consecutive Word code paragraphs into one block and maps heading outlines to 6", async () => {
  const code = (text: string) =>
    `<w:p><w:pPr><w:pStyle w:val="HTMLPreformatted"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
  const bytes = await fixture({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": documentXml(
      [
        `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr></w:p>`,
        code("line 1"),
        code("  line 2"),
        `<w:p><w:pPr><w:pStyle w:val="HTMLPreformatted"/></w:pPr></w:p>`,
        code("line 4"),
        `<w:p><w:r><w:t>between</w:t></w:r></w:p>`,
        code("second block"),
        `<w:p><w:pPr><w:outlineLvl w:val="5"/></w:pPr><w:r><w:t>Outline six</w:t></w:r></w:p>`,
        `<w:p><w:pPr><w:pStyle w:val="IntenseQuote"/></w:pPr><w:r><w:t>Intense</w:t></w:r></w:p>`,
        `<w:p><w:pPr><w:numPr><w:ilvl w:val="12"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>clamped</w:t></w:r></w:p>`,
      ].join("")
    ),
  })
  const imported = await importDocx(bytes, "code.docx")
  expect(imported.blocks.map(({ id: _id, ...block }) => block)).toEqual([
    { type: "code", text: "line 1\n  line 2\n\nline 4" },
    { type: "paragraph", text: "between" },
    { type: "code", text: "second block" },
    { type: "heading", level: 6, text: "Outline six" },
    { type: "quote", text: "Intense" },
    { type: "list-item", ordered: true, level: 8, text: "clamped" },
  ])
})

it("turns transcript Markdown into real blocks nested under the role headings", () => {
  const model = transcriptModel(
    {
      messages: [
        { role: "user", content: "Compare **A** and B" },
        {
          role: "assistant",
          content:
            "# Verdict\n\n| Option | Score |\n| --- | --- |\n| A | 9 |\n\n- fast\n\n```sh\nrun\n```",
        },
        { role: "system", content: "   " },
      ],
    },
    { title: "Transcript", user: "User", assistant: "Assistant", system: "System" }
  )
  expect(model.title).toBe("Transcript")
  expect(model.blocks.map(({ id: _id, ...block }) => block)).toEqual([
    { type: "heading", level: 2, text: "User" },
    { type: "paragraph", text: "Compare A and B" },
    { type: "heading", level: 2, text: "Assistant" },
    { type: "heading", level: 3, text: "Verdict" },
    {
      type: "table",
      rows: [
        ["Option", "Score"],
        ["A", "9"],
      ],
    },
    { type: "list-item", ordered: false, text: "fast" },
    { type: "code", text: "run", language: "sh" },
  ])
})

it("writes each line break between the lines it separates, blank lines included", async () => {
  const model = applyDocumentOperations(createDocument("Breaks", "first\n\nthird\tcol"), [
    { op: "appendParagraph", text: "old line\nold two" },
    { op: "replaceText", blockId: "b2", text: "new line\n\nnew three", trackChange: true },
  ])
  const bytes = await exportDocx(model)
  const imported = await importDocx(bytes, "breaks.docx")
  // Imported text drops the pending deletion and keeps the insertion.
  expect(imported.blocks.map((block) => (block.type === "table" ? "" : block.text))).toEqual([
    "first\n\nthird\tcol",
    "new line\n\nnew three",
  ])
  const xml = await readPackageXml(bytes, "word/document.xml")
  const deleted = [...xml.matchAll(/<w:del\b[\s\S]*?<\/w:del>/g)].map((match) => match[0]).join("")
  expect(deleted.indexOf("old line")).toBeLessThan(deleted.indexOf("<w:br/>"))
  expect(deleted.indexOf("<w:br/>")).toBeLessThan(deleted.indexOf("old two"))
})

it("keeps a comment on a later line of merged code on that code block", async () => {
  const code = (inner: string) => `<w:p><w:pPr><w:pStyle w:val="SourceCode"/></w:pPr>${inner}</w:p>`
  const bytes = await fixture({
    "word/document.xml": documentXml(
      [
        `<w:p><w:r><w:t>Intro</w:t></w:r></w:p>`,
        code(`<w:r><w:t>first()</w:t></w:r>`),
        code(
          `<w:commentRangeStart w:id="3"/><w:r><w:t>second()</w:t></w:r><w:commentRangeEnd w:id="3"/>`
        ),
        `<w:p><w:r><w:t>After</w:t></w:r></w:p>`,
      ].join("")
    ),
    "word/comments.xml": `<?xml version="1.0"?>
      <w:comments ${W}>
        <w:comment w:id="3" w:author="Ana"><w:p><w:r><w:t>Rename second</w:t></w:r></w:p></w:comment>
      </w:comments>`,
  })
  const model = await importDocx(bytes, "code.docx")
  expect(model.blocks.map((block) => block.type)).toEqual(["paragraph", "code", "paragraph"])
  expect(model.blocks[1]).toMatchObject({ text: "first()\nsecond()" })
  expect(model.comments).toEqual([
    expect.objectContaining({ blockId: model.blocks[1].id, author: "Ana", text: "Rename second" }),
  ])
})
