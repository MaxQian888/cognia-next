import { createDocument, DOCX_MIME, type DocumentBlock, type DocumentModel } from "./model"

export async function importDocx(
  bytes: Uint8Array,
  filename = "document.docx"
): Promise<DocumentModel> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(bytes)
  if (!zip.file("word/document.xml"))
    throw new Error("Invalid DOCX package: word/document.xml is missing.")
  const features: string[] = []
  if (zip.file("word/comments.xml")) features.push("comments")
  const xml = await zip.file("word/document.xml")!.async("string")
  if (/<w:(ins|del)\b/.test(xml)) features.push("tracked changes")
  if (
    zip.file("word/settings.xml") &&
    /<w:documentProtection\b/.test(await zip.file("word/settings.xml")!.async("string"))
  )
    features.push("document protection")
  const title = filename.replace(/\.docx$/i, "") || "Document"
  const model = createDocument(title)
  model.sourceFilename = filename
  model.importedFeatures = features
  model.blocks = extractParagraphText(xml).map((text, index) => ({
    id: `b${index + 1}`,
    type: "paragraph" as const,
    text,
  }))
  return model
}

export async function exportDocx(model: DocumentModel): Promise<Uint8Array> {
  const docx = await import("docx")
  const children = model.blocks.map((block) => renderBlock(block, docx))
  if (model.comments.length) {
    children.push(
      new docx.Paragraph({
        children: [new docx.TextRun({ text: "Review comments", bold: true })],
      })
    )
    for (const comment of model.comments)
      children.push(
        new docx.Paragraph({
          text: `[${comment.resolved ? "resolved" : "open"}] ${comment.author}: ${comment.text}`,
        })
      )
  }
  const document = new docx.Document({
    creator: "Cognia",
    title: model.title,
    sections: [{ children }],
  })
  const blob = await docx.Packer.toBlob(document)
  return new Uint8Array(await blob.arrayBuffer())
}

export async function validateDocxRoundTrip(
  bytes: Uint8Array
): Promise<{ valid: boolean; text: string }> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(bytes)
  const valid = Boolean(zip.file("[Content_Types].xml") && zip.file("word/document.xml"))
  if (!valid) return { valid: false, text: "" }
  const text = extractParagraphText(await zip.file("word/document.xml")!.async("string")).join(
    "\n\n"
  )
  return { valid: true, text }
}

function renderBlock(block: DocumentBlock, docx: typeof import("docx")) {
  const { HeadingLevel, Paragraph, Table, TableCell, TableRow, WidthType } = docx
  if (block.type === "table")
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: block.rows.map(
        (row) =>
          new TableRow({
            children: row.map((cell) => new TableCell({ children: [new Paragraph(cell)] })),
          })
      ),
    })
  if (block.type === "heading")
    return new Paragraph({
      text: block.text,
      heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
        block.level - 1
      ],
    })
  if (block.type === "list-item")
    return new Paragraph({
      text: block.text,
      bullet: block.ordered ? undefined : { level: 0 },
      numbering: block.ordered ? { reference: "default-numbering", level: 0 } : undefined,
    })
  return new Paragraph(block.text)
}

function extractParagraphText(xml: string): string[] {
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((match) =>
      [...match[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
        .map((text) => decodeXml(text[1]))
        .join("")
    )
    .map((text) => text.trim())
    .filter(Boolean)
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

export { DOCX_MIME }
