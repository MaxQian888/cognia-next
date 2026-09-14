import { createDocument, DOCX_MIME, type DocumentBlock, type DocumentModel } from "./model"

interface ImportedCommentInfo {
  author: string
  text: string
  paraId?: string
}

type DocxFileChild = import("docx").FileChild
type DocxParagraphChild = import("docx").ParagraphChild

/** Minimal structural view of a JSZip instance (keeps helpers sync-friendly). */
interface ZipLike {
  file(name: string): { async(kind: "string"): Promise<string> } | null
  files: Record<string, unknown>
}

export async function importDocx(
  bytes: Uint8Array,
  filename = "document.docx"
): Promise<DocumentModel> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(bytes)
  const documentFile = zip.file("word/document.xml")
  if (!documentFile) throw new Error("Invalid DOCX package: word/document.xml is missing.")
  const xml = await documentFile.async("string")

  const features = await detectFeatures(zip, xml)
  const numbering = await readNumbering(zip)
  const comments = await readComments(zip)
  const commentDone = await readResolvedCommentParaIds(zip)
  const coreTitle = await readCoreTitle(zip)

  const title = coreTitle || filename.replace(/\.docx$/i, "") || "Document"
  const model = createDocument(title)
  model.sourceFilename = filename
  model.importedFeatures = features

  const commentIdsByBlock = new Map<number, number[]>()
  model.blocks = scanBody(xml, numbering, commentIdsByBlock)
  let commentSequence = 1
  for (const [blockIndex, commentIds] of commentIdsByBlock) {
    const block = model.blocks[blockIndex]
    if (!block) continue
    for (const commentId of commentIds) {
      const info = comments.get(commentId)
      if (!info) continue
      model.comments.push({
        id: `m${commentSequence++}`,
        blockId: block.id,
        text: info.text || "(empty comment)",
        author: info.author || "Unknown",
        resolved: info.paraId ? commentDone.has(info.paraId) : false,
      })
    }
  }
  // comments.xml entries that never anchored to a paragraph still carry content
  // the user wrote — surface them on the first block rather than dropping them.
  const anchored = new Set([...commentIdsByBlock.values()].flat())
  for (const [commentId, info] of comments) {
    if (anchored.has(commentId)) continue
    const blockId = model.blocks[0]?.id
    if (!blockId) break
    model.comments.push({
      id: `m${commentSequence++}`,
      blockId,
      text: info.text || "(empty comment)",
      author: info.author || "Unknown",
      resolved: info.paraId ? commentDone.has(info.paraId) : false,
    })
  }
  return model
}

export async function exportDocx(model: DocumentModel): Promise<Uint8Array> {
  const docx = await import("docx")
  const commentNumber = new Map<string, number>()
  model.comments.forEach((comment, index) => commentNumber.set(comment.id, index + 1))
  const children: DocxFileChild[] = [
    new docx.Paragraph({ text: model.title, heading: docx.HeadingLevel.TITLE }),
  ]
  for (const block of model.blocks) children.push(renderBlock(block, model, commentNumber, docx))
  const document = new docx.Document({
    creator: "Cognia",
    title: model.title,
    comments: model.comments.length
      ? {
          children: model.comments.map((comment) => ({
            id: commentNumber.get(comment.id)!,
            author: comment.author,
            date: new Date(),
            resolved: comment.resolved,
            children: [new docx.Paragraph(comment.text)],
          })),
        }
      : undefined,
    numbering: {
      config: [
        {
          reference: "default-numbering",
          levels: [
            {
              level: 0,
              format: docx.LevelFormat.DECIMAL,
              text: "%1.",
              alignment: docx.AlignmentType.START,
            },
          ],
        },
      ],
    },
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

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function renderBlock(
  block: DocumentBlock,
  model: DocumentModel,
  commentNumber: Map<string, number>,
  docx: typeof import("docx")
): DocxFileChild {
  const { HeadingLevel, Paragraph, Table, TableCell, TableRow, WidthType } = docx
  if (block.type === "table")
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: block.rows.map(
        (row) =>
          new TableRow({
            children: row.map(
              (cell) =>
                new TableCell({
                  children: cell.split("\n").map((line) => new Paragraph(line)),
                })
            ),
          })
      ),
    })
  const runs = paragraphChildren(block, model, commentNumber, docx)
  if (block.type === "heading")
    return new Paragraph({
      children: runs,
      heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
        block.level - 1
      ],
    })
  if (block.type === "list-item")
    return new Paragraph({
      children: runs,
      bullet: block.ordered ? undefined : { level: 0 },
      numbering: block.ordered ? { reference: "default-numbering", level: 0 } : undefined,
    })
  return new Paragraph({ children: runs })
}

/**
 * Build a paragraph's run list: real Word comment ranges around the text, and
 * pending tracked changes emitted as w:ins/w:del pairs (del = earliest pending
 * `before`, ins = the block's current text).
 */
function paragraphChildren(
  block: Extract<DocumentBlock, { type: "paragraph" | "heading" | "list-item" }>,
  model: DocumentModel,
  commentNumber: Map<string, number>,
  docx: typeof import("docx")
): DocxParagraphChild[] {
  const { CommentRangeEnd, CommentRangeStart, CommentReference, TextRun } = docx
  const pending = model.changes.find((change) => change.blockId === block.id && !change.accepted)
  const date = new Date().toISOString()
  const runs: DocxParagraphChild[] = pending
    ? [
        ...revisionRuns(pending.before, docx.DeletedTextRun, pending.id, 0, date, docx),
        ...revisionRuns(block.text, docx.InsertedTextRun, pending.id, 5000, date, docx),
      ]
    : textRuns(block.text, docx)
  const comments = model.comments.filter((comment) => comment.blockId === block.id)
  if (!comments.length) return runs
  return [
    ...comments.map((comment) => new CommentRangeStart(commentNumber.get(comment.id)!)),
    ...runs,
    ...comments.map((comment) => new CommentRangeEnd(commentNumber.get(comment.id)!)),
    new TextRun({
      children: comments.map((comment) => new CommentReference(commentNumber.get(comment.id)!)),
    }),
  ]
}

function textRuns(text: string, docx: typeof import("docx")): DocxParagraphChild[] {
  const { Tab, TextRun } = docx
  const runs: DocxParagraphChild[] = []
  const lines = splitText(text)
  lines.forEach((line, index) => {
    const segments = line.split("\t")
    segments.forEach((segment, segmentIndex) => {
      runs.push(
        new TextRun({
          text: segment,
          break: segmentIndex === segments.length - 1 && index < lines.length - 1 ? 1 : undefined,
        })
      )
      if (segmentIndex < segments.length - 1) runs.push(new TextRun({ children: [new Tab()] }))
    })
  })
  return runs
}

function splitText(text: string): string[] {
  return text.split("\n")
}

type RevisionRunCtor =
  (typeof import("docx"))["InsertedTextRun"] | (typeof import("docx"))["DeletedTextRun"]

function revisionRuns(
  text: string,
  Ctor: RevisionRunCtor,
  changeId: string,
  salt: number,
  date: string,
  docx: typeof import("docx")
): DocxParagraphChild[] {
  const { Tab } = docx
  const base = (Number.parseInt(changeId.replace(/\D+/g, ""), 10) || 0) * 10000 + salt
  const runs: DocxParagraphChild[] = []
  let runIndex = 0
  text.split("\n").forEach((line, index, lines) => {
    const segments = line.split("\t")
    segments.forEach((segment, segmentIndex) => {
      if (segment)
        runs.push(
          new Ctor({
            text: segment,
            id: base + runIndex++,
            author: "Cognia",
            date,
            break: segmentIndex === segments.length - 1 && index < lines.length - 1 ? 1 : undefined,
          })
        )
      else if (segmentIndex === segments.length - 1 && index < lines.length - 1)
        runs.push(
          new Ctor({
            children: [new docx.CarriageReturn()],
            id: base + runIndex++,
            author: "Cognia",
            date,
          })
        )
      if (segmentIndex < segments.length - 1)
        runs.push(
          new Ctor({
            children: [new Tab()],
            id: base + runIndex++,
            author: "Cognia",
            date,
          })
        )
    })
  })
  return runs
}

// ---------------------------------------------------------------------------
// Import — feature detection
// ---------------------------------------------------------------------------

async function detectFeatures(zip: ZipLike, documentXml: string): Promise<string[]> {
  const features: string[] = []
  const names = Object.keys(zip.files)
  const has = (prefix: string) => names.some((name) => name.startsWith(prefix))
  if (/<w:(ins|del|moveFrom|moveTo)\b/.test(documentXml)) features.push("tracked changes")
  const settings = zip.file("word/settings.xml")
  if (settings && /<w:documentProtection\b/.test(await settings.async("string")))
    features.push("document protection")
  if (has("word/media/")) features.push("images")
  if (/<w:hyperlink\b/.test(documentXml)) features.push("hyperlinks")
  if (/<w:(drawing|pict)\b/.test(documentXml)) features.push("drawings")
  if (has("word/embeddings/") || has("word/diagrams/")) features.push("embedded objects")
  if (zip.file("word/footnotes.xml")) features.push("footnotes")
  if (zip.file("word/endnotes.xml")) features.push("endnotes")
  if (names.some((name) => /^word\/(header|footer)\d*\.xml$/.test(name)))
    features.push("headers/footers")
  if (/<w:(instrText|fldSimple)\b|<w:fldChar\b/.test(documentXml))
    features.push("fields (TOC, cross-references)")
  if (/<w:sdt\b/.test(documentXml)) features.push("content controls")
  // Every body ends with one sectPr (page setup) — only flag real section
  // breaks, where layout actually varies across the document.
  if ((documentXml.match(/<w:sectPr\b/g) ?? []).length > 1) features.push("section page setup")
  if (/<w:altChunk\b/.test(documentXml)) features.push("embedded external content")
  if (/<w:(gridSpan|vMerge)\b/.test(documentXml)) features.push("merged table cells")
  if (/<w:br[^>]*w:type="page"/.test(documentXml)) features.push("page breaks")
  return features
}

// ---------------------------------------------------------------------------
// Import — numbering (ordered vs bullet)
// ---------------------------------------------------------------------------

type NumberingInfo = Map<string, "ordered" | "bullet">

async function readNumbering(zip: ZipLike): Promise<NumberingInfo> {
  const file = zip.file("word/numbering.xml")
  const info: NumberingInfo = new Map()
  if (!file) return info
  const xml = await file.async("string")
  const abstractFormat = new Map<string, string>()
  for (const match of xml.matchAll(
    /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g
  )) {
    const levelZero = /<w:lvl\b[^>]*w:ilvl="0"[^>]*>([\s\S]*?)<\/w:lvl>/.exec(match[2])
    const format = /<w:numFmt\b[^>]*w:val="([^"]+)"/.exec(levelZero?.[1] ?? match[2])
    if (format) abstractFormat.set(match[1], format[1])
  }
  for (const match of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const abstract = /<w:abstractNumId\b[^>]*w:val="(\d+)"/.exec(match[2])
    const format = abstract ? abstractFormat.get(abstract[1]) : undefined
    if (format) info.set(match[1], format === "bullet" ? "bullet" : "ordered")
  }
  return info
}

// ---------------------------------------------------------------------------
// Import — comments
// ---------------------------------------------------------------------------

async function readComments(zip: ZipLike): Promise<Map<number, ImportedCommentInfo>> {
  const file = zip.file("word/comments.xml")
  const comments = new Map<number, ImportedCommentInfo>()
  if (!file) return comments
  const xml = await file.async("string")
  for (const match of xml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const id = Number.parseInt(attr(match[1], "w:id") ?? "", 10)
    if (!Number.isFinite(id)) continue
    comments.set(id, {
      author: attr(match[1], "w:author") ?? "Unknown",
      text: extractParagraphText(match[2]).join("\n"),
      paraId: attr(match[1], "w14:paraId"),
    })
  }
  return comments
}

async function readResolvedCommentParaIds(zip: ZipLike): Promise<Set<string>> {
  const file = zip.file("word/commentsExtended.xml")
  const resolved = new Set<string>()
  if (!file) return resolved
  const xml = await file.async("string")
  for (const match of xml.matchAll(/<w15:commentEx\b([^>]*)\/?>/g)) {
    if (attr(match[1], "w15:done") === "1") {
      const paraId = attr(match[1], "w15:paraId")
      if (paraId) resolved.add(paraId)
    }
  }
  return resolved
}

async function readCoreTitle(zip: ZipLike): Promise<string> {
  const file = zip.file("docProps/core.xml")
  if (!file) return ""
  const xml = await file.async("string")
  const match = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(xml)
  return match ? decodeXml(match[1]).trim() : ""
}

// ---------------------------------------------------------------------------
// Import — body walk
// ---------------------------------------------------------------------------

const TOP_LEVEL_ELEMENT = /<w:(\w+)((?:\s[^>]*?)?)(\/?)>/g

/**
 * Iterate the body's top-level block elements in document order. `w:p` inside
 * tables/comments/textboxes stays unreachable because we jump whole elements;
 * `w:sdt` wrappers are transparent (their `w:sdtContent` children recurse).
 */
function scanBody(
  documentXml: string,
  numbering: NumberingInfo,
  commentIdsByBlock: Map<number, number[]>
): DocumentBlock[] {
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? documentXml
  const blocks: DocumentBlock[] = []
  const scanRegion = (region: string): void => {
    TOP_LEVEL_ELEMENT.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = TOP_LEVEL_ELEMENT.exec(region))) {
      const tag = match[1]
      if (match[3] === "/") continue
      const end = findElementEnd(region, match.index, match[0].length, tag)
      const slice = region.slice(match.index, end)
      if (tag === "p") {
        const block = parseParagraph(slice, numbering, blocks.length)
        if (block) {
          const anchors = commentAnchors(slice)
          if (anchors.length) commentIdsByBlock.set(blocks.length, anchors)
          blocks.push(block)
        }
      } else if (tag === "tbl") {
        const block = parseTable(slice, blocks.length)
        if (block) blocks.push(block)
      } else if (tag === "sdt") {
        const content = /<w:sdtContent\b[^>]*>([\s\S]*?)<\/w:sdtContent>/.exec(slice)?.[1]
        if (content) scanRegion(content)
      }
      TOP_LEVEL_ELEMENT.lastIndex = end
    }
  }
  scanRegion(body)
  return blocks
}

/** End offset (exclusive) of the element whose open tag starts at `from`. */
function findElementEnd(region: string, from: number, openLength: number, tag: string): number {
  const pattern = new RegExp(`<w:${tag}\\b[^>]*>|</w:${tag}>`, "g")
  pattern.lastIndex = from + openLength
  let depth = 1
  let match: RegExpExecArray | null
  while ((match = pattern.exec(region))) {
    if (match[0].startsWith("</")) depth -= 1
    else if (!match[0].endsWith("/>")) depth += 1
    if (depth === 0) return match.index + match[0].length
  }
  return region.length
}

function parseParagraph(
  xml: string,
  numbering: NumberingInfo,
  index: number
): DocumentBlock | null {
  const pPr = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/.exec(xml)?.[1] ?? ""
  const text = paragraphText(xml.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/, ""))
  if (!text.trim() && !/<w:commentRangeStart\b/.test(xml)) return null
  const id = `b${index + 1}`
  const style = /<w:pStyle\b[^>]*?w:val="([^"]+)"/.exec(pPr)?.[1]
  const headingMatch = /^(?:heading|title|subtitle)\s*([1-3])?$/i.exec(style ?? "")
  const outline = /<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(pPr)?.[1]
  const numId = /<w:numId\b[^>]*w:val="(\d+)"/.exec(pPr)?.[1]
  if (/<w:numPr\b/.test(pPr))
    return {
      id,
      type: "list-item",
      ordered: numId ? numbering.get(numId) !== "bullet" : true,
      text,
    }
  if (headingMatch && /^heading/i.test(style ?? ""))
    return { id, type: "heading", level: Number(headingMatch[1] ?? "1") as 1 | 2 | 3, text }
  if (headingMatch && /^(title|subtitle)$/i.test(style ?? ""))
    return { id, type: "heading", level: 1, text }
  if (outline !== undefined && Number(outline) <= 2)
    return { id, type: "heading", level: (Number(outline) + 1) as 1 | 2 | 3, text }
  return { id, type: "paragraph", text }
}

function parseTable(xml: string, index: number): DocumentBlock | null {
  const rows: string[][] = []
  for (const rowMatch of xml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
    const cells: string[] = []
    for (const cellMatch of rowMatch[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
      const paragraphs = extractParagraphText(cellMatch[1])
      cells.push(paragraphs.join("\n"))
    }
    if (cells.length) rows.push(cells)
  }
  if (!rows.length) return null
  return { id: `b${index + 1}`, type: "table", rows }
}

/** Ids of comments whose `commentRangeStart` lands inside this element. */
function commentAnchors(xml: string): number[] {
  return [...xml.matchAll(/<w:commentRangeStart\b[^>]*w:id="(\d+)"/g)].map((match) =>
    Number.parseInt(match[1], 10)
  )
}

/**
 * Ordered run-level text extraction: text, tabs, soft line breaks. Field
 * instructions and deleted text never surface as content.
 */
function paragraphText(xml: string): string {
  const out: string[] = []
  const re =
    /<w:(t|tab|br|noBreakHyphen|softHyphen|delText|instrText)\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:\1>)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    const tag = match[1]
    if (tag === "delText" || tag === "instrText" || tag === "softHyphen") continue
    if (tag === "tab") out.push("\t")
    else if (tag === "br") out.push("\n")
    else if (tag === "noBreakHyphen") out.push("-")
    else out.push(decodeXml(match[2] ?? ""))
  }
  return out.join("")
}

function extractParagraphText(xml: string): string[] {
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((match) => paragraphText(match[1]).trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Shared XML helpers
// ---------------------------------------------------------------------------

function attr(xml: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(xml)
  return match ? decodeXml(match[1]) : undefined
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

export { DOCX_MIME }

// ---------------------------------------------------------------------------
// Session transcript → DOCX (custom exporter backend)
// ---------------------------------------------------------------------------

export interface TranscriptLabels {
  /** Fallback document title when the session has none. */
  title: string
  /** Role captions used as level-2 headings. */
  user: string
  assistant: string
  system: string
}

interface TranscriptLikeMessage {
  role?: string
  content?: string
  parts?: ReadonlyArray<{ type?: string; text?: string }>
}

export interface TranscriptLikeData {
  session?: { title?: string }
  messages?: TranscriptLikeMessage[]
}

export async function exportTranscriptDocx(
  data: TranscriptLikeData,
  labels: TranscriptLabels
): Promise<Blob> {
  const model = createDocument(data.session?.title?.trim() || labels.title)
  let sequence = 1
  for (const message of data.messages ?? []) {
    const text = transcriptMessageText(message)
    if (!text.trim()) continue
    const role = message.role ?? "assistant"
    model.blocks.push({
      id: `b${sequence++}`,
      type: "heading",
      level: 2,
      text: role === "user" ? labels.user : role === "system" ? labels.system : labels.assistant,
    })
    for (const paragraph of text.split(/\n{2,}/)) {
      const clean = paragraph.trim()
      if (clean) model.blocks.push({ id: `b${sequence++}`, type: "paragraph", text: clean })
    }
  }
  const bytes = await exportDocx(model)
  return new Blob([new Uint8Array(bytes)], { type: DOCX_MIME })
}

function transcriptMessageText(message: TranscriptLikeMessage): string {
  if (typeof message.content === "string" && message.content.trim()) return message.content
  return (message.parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("\n\n")
}
