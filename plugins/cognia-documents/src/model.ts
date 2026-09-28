import { MAX_LIST_LEVEL, parseMarkdownBlocks } from "./markdown"

export const DOCUMENT_SCHEMA_VERSION = 1 as const
export const DOCUMENT_ARTIFACT_KIND = "cognia-documents/document"
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** Word's Heading 1–6; the document title is separate (Word's "Title" style). */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
export const MAX_HEADING_LEVEL = 6

export type DocumentBlock =
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "heading"; level: HeadingLevel; text: string }
  /** `level` is the nesting depth, 0 (outermost, the default) to 8. */
  | { id: string; type: "list-item"; ordered: boolean; level?: number; text: string }
  | { id: string; type: "table"; rows: string[][] }
  | { id: string; type: "quote"; text: string }
  /** Verbatim text (indentation kept); `language` is a hint such as `ts`. */
  | { id: string; type: "code"; text: string; language?: string }

export type DocumentBlockType = DocumentBlock["type"]
export type TextBlock = Exclude<DocumentBlock, { type: "table" }>

/** Block payload accepted by `insertBlock` / `replaceBlock` — the id is host-assigned. */
export type DocumentBlockInput =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: HeadingLevel; text: string }
  | { type: "list-item"; ordered?: boolean; level?: number; text: string }
  | { type: "table"; rows: string[][] }
  | { type: "quote"; text: string }
  | { type: "code"; text: string; language?: string }

export interface DocumentComment {
  id: string
  blockId: string
  text: string
  author: string
  resolved: boolean
}
export interface DocumentChange {
  id: string
  blockId: string
  before: string
  after: string
  accepted: boolean
}
export interface DocumentModel {
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION
  title: string
  blocks: DocumentBlock[]
  comments: DocumentComment[]
  changes: DocumentChange[]
  sourceFilename?: string
  importedFeatures: string[]
}

export type DocumentOperation =
  | { op: "setTitle"; title: string }
  | { op: "appendParagraph"; text: string }
  | { op: "appendHeading"; text: string; level: HeadingLevel }
  | { op: "appendListItem"; text: string; ordered?: boolean; level?: number }
  | { op: "appendTable"; rows: string[][] }
  | { op: "appendMarkdown"; markdown: string }
  | { op: "insertMarkdown"; markdown: string; afterBlockId?: string }
  | { op: "insertBlock"; afterBlockId?: string; block: DocumentBlockInput }
  | { op: "replaceBlock"; blockId: string; block: DocumentBlockInput }
  | { op: "deleteBlock"; blockId: string }
  | { op: "moveBlock"; blockId: string; toIndex: number }
  | { op: "replaceText"; blockId: string; text: string; trackChange?: boolean }
  | {
      op: "findReplace"
      find: string
      replace: string
      matchCase?: boolean
      wholeWord?: boolean
      trackChanges?: boolean
    }
  | { op: "updateTableCell"; blockId: string; row: number; column: number; text: string }
  | { op: "insertTableRow"; blockId: string; index: number; cells?: string[] }
  | { op: "deleteTableRow"; blockId: string; index: number }
  | { op: "insertTableColumn"; blockId: string; index: number; cells?: string[] }
  | { op: "deleteTableColumn"; blockId: string; index: number }
  | { op: "addComment"; blockId: string; text: string; author?: string }
  | { op: "resolveComment"; commentId: string }
  | { op: "reopenComment"; commentId: string }
  | { op: "acceptChange"; changeId: string }
  | { op: "rejectChange"; changeId: string }
  | { op: "acceptAllChanges" }
  | { op: "rejectAllChanges" }
  | { op: "stripComments" }

/** Every operation name, in schema order — the tool schema and tests key off this. */
export const DOCUMENT_OPERATION_NAMES = [
  "setTitle",
  "appendParagraph",
  "appendHeading",
  "appendListItem",
  "appendTable",
  "appendMarkdown",
  "insertMarkdown",
  "insertBlock",
  "replaceBlock",
  "deleteBlock",
  "moveBlock",
  "replaceText",
  "findReplace",
  "updateTableCell",
  "insertTableRow",
  "deleteTableRow",
  "insertTableColumn",
  "deleteTableColumn",
  "addComment",
  "resolveComment",
  "reopenComment",
  "acceptChange",
  "rejectChange",
  "acceptAllChanges",
  "rejectAllChanges",
  "stripComments",
] as const satisfies ReadonlyArray<DocumentOperation["op"]>

export function createDocument(title: string, text = ""): DocumentModel {
  const clean = requireText(title, "title")
  return {
    schemaVersion: 1,
    title: clean,
    blocks: text ? [{ id: "b1", type: "paragraph", text }] : [],
    comments: [],
    changes: [],
    importedFeatures: [],
  }
}

const BLOCK_TYPES = new Set<string>(["paragraph", "heading", "list-item", "table", "quote", "code"])

function isHeadingLevel(value: unknown): value is HeadingLevel {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_HEADING_LEVEL
}

function isListLevel(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_LIST_LEVEL)
  )
}

function assertBlockShape(block: DocumentBlock, index: number): void {
  const where = `blocks[${index}]`
  if (!block || typeof block !== "object")
    throw new Error(`Invalid document: ${where} is not an object.`)
  if (typeof block.id !== "string" || !block.id)
    throw new Error(`Invalid document: ${where}.id must be a non-empty string.`)
  if (!BLOCK_TYPES.has(block.type))
    throw new Error(`Invalid document: ${where}.type "${String(block.type)}" is unsupported.`)
  if (block.type === "table") {
    if (!Array.isArray(block.rows) || block.rows.some((row) => !Array.isArray(row)))
      throw new Error(`Invalid document: ${where}.rows must be an array of arrays.`)
    return
  }
  if (typeof block.text !== "string")
    throw new Error(`Invalid document: ${where}.text must be a string.`)
  if (block.type === "heading" && !isHeadingLevel(block.level))
    throw new Error(`Invalid document: ${where}.level must be an integer from 1 to 6.`)
  if (block.type === "list-item" && !isListLevel(block.level))
    throw new Error(`Invalid document: ${where}.level must be an integer from 0 to 8.`)
  if (block.type === "code" && block.language !== undefined && typeof block.language !== "string")
    throw new Error(`Invalid document: ${where}.language must be a string.`)
}

export function parseDocument(content: string): DocumentModel {
  const parsed = JSON.parse(content) as DocumentModel
  if (parsed?.schemaVersion !== DOCUMENT_SCHEMA_VERSION || !Array.isArray(parsed.blocks))
    throw new Error("Unsupported Cognia document schema.")
  if (typeof parsed.title !== "string") throw new Error("Invalid document: title must be a string.")
  parsed.blocks.forEach(assertBlockShape)
  for (const list of [parsed.comments, parsed.changes, parsed.importedFeatures]) {
    if (!Array.isArray(list))
      throw new Error("Invalid document: comments/changes/importedFeatures must be arrays.")
  }
  for (const comment of parsed.comments) {
    if (typeof comment?.id !== "string" || typeof comment?.blockId !== "string")
      throw new Error("Invalid document: comment entries require id and blockId.")
  }
  for (const change of parsed.changes) {
    if (typeof change?.id !== "string" || typeof change?.blockId !== "string")
      throw new Error("Invalid document: change entries require id and blockId.")
  }
  return parsed
}

/** Highest numeric id suffix across blocks/comments/changes, +1. Delete-safe. */
function nextSequence(model: DocumentModel): number {
  let max = 0
  for (const id of [
    ...model.blocks.map((block) => block.id),
    ...model.comments.map((comment) => comment.id),
    ...model.changes.map((change) => change.id),
  ]) {
    const match = /(\d+)$/.exec(id)
    if (match) max = Math.max(max, Number.parseInt(match[1], 10))
  }
  return max + 1
}

/**
 * The text a block stores: trimmed and non-empty, except code, which keeps
 * its indentation and only loses trailing blank lines.
 */
function blockText(type: TextBlock["type"], value: string, name = "text"): string {
  if (typeof value !== "string") throw new Error(`${name} is required.`)
  if (type !== "code") return requireText(value, name)
  const text = value.replace(/\s+$/, "")
  if (!text.trim()) throw new Error(`${name} is required.`)
  return text
}

export function materializeBlock(input: DocumentBlockInput, id: string): DocumentBlock {
  if (!input || typeof input !== "object") throw new Error("Block must be an object.")
  switch (input.type) {
    case "table":
      if (!Array.isArray(input.rows) || !input.rows.length || input.rows.some((row) => !row.length))
        throw new Error("Table rows cannot be empty.")
      return { id, type: "table", rows: input.rows.map((row) => row.map(String)) }
    case "heading":
      if (!isHeadingLevel(input.level))
        throw new Error(`Heading level must be an integer from 1 to ${MAX_HEADING_LEVEL}.`)
      return { id, type: "heading", level: input.level, text: blockText("heading", input.text) }
    case "list-item": {
      if (!isListLevel(input.level))
        throw new Error(`List level must be an integer from 0 to ${MAX_LIST_LEVEL}.`)
      return {
        id,
        type: "list-item",
        ordered: Boolean(input.ordered),
        ...(input.level ? { level: input.level } : {}),
        text: blockText("list-item", input.text),
      }
    }
    case "quote":
      return { id, type: "quote", text: blockText("quote", input.text) }
    case "code": {
      const language = input.language?.trim()
      return {
        id,
        type: "code",
        text: blockText("code", input.text),
        ...(language ? { language } : {}),
      }
    }
    case "paragraph":
      return { id, type: "paragraph", text: blockText("paragraph", input.text) }
    default:
      throw new Error(`Unsupported block type: ${String((input as { type?: unknown }).type)}`)
  }
}

export function applyDocumentOperations(
  model: DocumentModel,
  operations: DocumentOperation[]
): DocumentModel {
  const next = structuredClone(model)
  let sequence = nextSequence(next)
  const newId = () => `b${sequence++}`
  const blockIndex = (blockId: string) => next.blocks.findIndex((block) => block.id === blockId)
  const anchorIndex = (afterBlockId: string | undefined) => {
    if (afterBlockId === undefined) return -1
    const at = blockIndex(afterBlockId)
    if (at < 0) throw new Error(`Insert anchor block not found: ${afterBlockId}`)
    return at
  }
  const markdownBlocks = (markdown: string) => {
    const parsed = parseMarkdownBlocks(requireText(markdown, "markdown"))
    if (!parsed.blocks.length) throw new Error("Markdown produced no document blocks.")
    return parsed.blocks.map((input) => materializeBlock(input, newId()))
  }
  const table = (blockId: string) => {
    const block = next.blocks.find((candidate) => candidate.id === blockId)
    if (!block || block.type !== "table") throw new Error(`Table block not found: ${blockId}`)
    return block
  }
  const recordChange = (block: TextBlock, text: string) =>
    next.changes.push({
      id: `c${sequence++}`,
      blockId: block.id,
      before: block.text,
      after: text,
      accepted: false,
    })

  for (const operation of operations) {
    switch (operation.op) {
      case "setTitle":
        next.title = requireText(operation.title, "title")
        break
      case "appendParagraph":
        next.blocks.push(materializeBlock({ type: "paragraph", text: operation.text }, newId()))
        break
      case "appendHeading":
        next.blocks.push(
          materializeBlock(
            { type: "heading", level: operation.level, text: operation.text },
            newId()
          )
        )
        break
      case "appendListItem":
        next.blocks.push(
          materializeBlock(
            {
              type: "list-item",
              ordered: operation.ordered,
              level: operation.level,
              text: operation.text,
            },
            newId()
          )
        )
        break
      case "appendTable":
        next.blocks.push(materializeBlock({ type: "table", rows: operation.rows }, newId()))
        break
      case "appendMarkdown":
        next.blocks.push(...markdownBlocks(operation.markdown))
        break
      case "insertMarkdown": {
        const at = anchorIndex(operation.afterBlockId)
        next.blocks.splice(at + 1, 0, ...markdownBlocks(operation.markdown))
        break
      }
      case "insertBlock": {
        const at = anchorIndex(operation.afterBlockId)
        next.blocks.splice(at + 1, 0, materializeBlock(operation.block, newId()))
        break
      }
      case "replaceBlock": {
        const at = blockIndex(operation.blockId)
        if (at < 0) throw new Error(`Block not found: ${operation.blockId}`)
        // A pending change describes this block's text; replacing the block
        // underneath it would leave the review pointing at text that is gone.
        if (next.changes.some((change) => change.blockId === operation.blockId && !change.accepted))
          throw new Error(
            `Block ${operation.blockId} has pending tracked changes; accept or reject them first.`
          )
        // The id survives, so comments anchored to the block stay with it.
        next.blocks[at] = materializeBlock(operation.block, operation.blockId)
        break
      }
      case "deleteBlock": {
        const at = blockIndex(operation.blockId)
        if (at < 0) throw new Error(`Block not found: ${operation.blockId}`)
        next.blocks.splice(at, 1)
        next.comments = next.comments.filter((comment) => comment.blockId !== operation.blockId)
        next.changes = next.changes.filter((change) => change.blockId !== operation.blockId)
        break
      }
      case "moveBlock": {
        const from = blockIndex(operation.blockId)
        if (from < 0) throw new Error(`Block not found: ${operation.blockId}`)
        const [block] = next.blocks.splice(from, 1)
        const to = Math.max(0, Math.min(next.blocks.length, Math.trunc(operation.toIndex)))
        next.blocks.splice(to, 0, block)
        break
      }
      case "replaceText": {
        const block = next.blocks.find((candidate) => candidate.id === operation.blockId)
        if (!block || block.type === "table")
          throw new Error(`Editable text block not found: ${operation.blockId}`)
        const text = blockText(block.type, operation.text)
        if (operation.trackChange) recordChange(block, text)
        block.text = text
        break
      }
      case "findReplace":
        findReplace(next, operation, recordChange)
        break
      case "updateTableCell": {
        const block = table(operation.blockId)
        const row = block.rows[operation.row]
        if (!row || operation.column < 0 || operation.column >= row.length)
          throw new Error(
            `Table cell out of range: ${operation.blockId} [${operation.row}, ${operation.column}]`
          )
        row[operation.column] = operation.text
        break
      }
      case "insertTableRow": {
        const block = table(operation.blockId)
        const width = tableWidth(block.rows)
        if (
          !Number.isInteger(operation.index) ||
          operation.index < 0 ||
          operation.index > block.rows.length
        )
          throw new Error(`Table row index out of range: ${operation.index}`)
        const cells = operation.cells ?? Array<string>(width).fill("")
        if (cells.length !== width)
          throw new Error(`A new row of ${operation.blockId} needs ${width} cells.`)
        padRows(block.rows, width)
        block.rows.splice(operation.index, 0, cells.map(String))
        break
      }
      case "deleteTableRow": {
        const block = table(operation.blockId)
        if (!Number.isInteger(operation.index) || !block.rows[operation.index])
          throw new Error(`Table row index out of range: ${operation.index}`)
        if (block.rows.length === 1)
          throw new Error(`Cannot delete the only row of ${operation.blockId}; delete the block.`)
        block.rows.splice(operation.index, 1)
        break
      }
      case "insertTableColumn": {
        const block = table(operation.blockId)
        const width = tableWidth(block.rows)
        if (!Number.isInteger(operation.index) || operation.index < 0 || operation.index > width)
          throw new Error(`Table column index out of range: ${operation.index}`)
        const cells = operation.cells ?? Array<string>(block.rows.length).fill("")
        if (cells.length !== block.rows.length)
          throw new Error(`A new column of ${operation.blockId} needs ${block.rows.length} cells.`)
        // Ragged rows are padded first so the column lands in one place.
        padRows(block.rows, width)
        block.rows.forEach((row, index) => row.splice(operation.index, 0, String(cells[index])))
        break
      }
      case "deleteTableColumn": {
        const block = table(operation.blockId)
        const width = tableWidth(block.rows)
        if (!Number.isInteger(operation.index) || operation.index < 0 || operation.index >= width)
          throw new Error(`Table column index out of range: ${operation.index}`)
        if (width === 1)
          throw new Error(
            `Cannot delete the only column of ${operation.blockId}; delete the block.`
          )
        padRows(block.rows, width)
        block.rows.forEach((row) => row.splice(operation.index, 1))
        break
      }
      case "addComment":
        if (!next.blocks.some((block) => block.id === operation.blockId))
          throw new Error(`Comment block not found: ${operation.blockId}`)
        next.comments.push({
          id: `m${sequence++}`,
          blockId: operation.blockId,
          text: requireText(operation.text, "comment"),
          author: operation.author?.trim() || "Cognia",
          resolved: false,
        })
        break
      case "resolveComment":
        findComment(next, operation.commentId).resolved = true
        break
      case "reopenComment":
        findComment(next, operation.commentId).resolved = false
        break
      case "acceptChange":
        findChange(next, operation.changeId).accepted = true
        break
      case "rejectChange":
        rejectChange(next, operation.changeId)
        break
      case "acceptAllChanges":
        next.changes.forEach((change) => {
          change.accepted = true
        })
        break
      case "rejectAllChanges": {
        // Restore each block to its earliest pending `before`; later pending
        // changes on the same block describe text that never survives the
        // rejection, so their records drop together with the earliest one.
        const pendingByBlock = new Map<string, DocumentChange[]>()
        for (const change of next.changes.filter((entry) => !entry.accepted)) {
          const bucket = pendingByBlock.get(change.blockId) ?? []
          bucket.push(change)
          pendingByBlock.set(change.blockId, bucket)
        }
        for (const [blockId, pending] of pendingByBlock) {
          const block = next.blocks.find((candidate) => candidate.id === blockId)
          if (block && block.type !== "table") block.text = pending[0].before
        }
        next.changes = next.changes.filter((change) => change.accepted)
        break
      }
      case "stripComments":
        next.comments = []
        break
      default:
        throw new Error(
          `Unsupported document operation: ${String((operation as { op?: unknown }).op)}`
        )
    }
  }
  return next
}

function tableWidth(rows: string[][]): number {
  return Math.max(0, ...rows.map((row) => row.length))
}

function padRows(rows: string[][], width: number): void {
  for (const row of rows) while (row.length < width) row.push("")
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && WORD_CHARACTER.test(char)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Replace `find` in every text block and table cell. Text-block edits can be
 * recorded as tracked changes (one per block); table cells have no change
 * model and are edited in place. Finding nothing, or emptying a block, is an
 * error rather than a silent no-op.
 */
function findReplace(
  model: DocumentModel,
  operation: Extract<DocumentOperation, { op: "findReplace" }>,
  recordChange: (block: TextBlock, text: string) => void
): void {
  if (typeof operation.find !== "string" || !operation.find)
    throw new Error("findReplace needs non-empty find text.")
  if (typeof operation.replace !== "string") throw new Error("findReplace needs replace text.")
  const pattern = new RegExp(escapeRegExp(operation.find), `gu${operation.matchCase ? "" : "i"}`)
  // Whole-word matching checks the neighbouring code points in the callback
  // rather than with a lookbehind, which iOS WebViews before 16.4 reject.
  const standalone = (match: string, offset: number, source: string) =>
    !isWordCharacter(Array.from(source.slice(Math.max(0, offset - 2), offset)).at(-1)) &&
    !isWordCharacter(Array.from(source.slice(offset + match.length, offset + match.length + 2))[0])
  const replace = (value: string) => {
    let count = 0
    const result = value.replace(pattern, (match: string, offset: number, source: string) => {
      if (operation.wholeWord && !standalone(match, offset, source)) return match
      count += 1
      return operation.replace
    })
    return { result, count }
  }
  let total = 0
  for (const block of model.blocks) {
    if (block.type === "table") {
      for (const row of block.rows)
        row.forEach((cell, index) => {
          const { result, count } = replace(cell)
          if (count) {
            row[index] = result
            total += count
          }
        })
      continue
    }
    const { result, count } = replace(block.text)
    if (!count) continue
    total += count
    let text: string
    try {
      text = blockText(block.type, result)
    } catch {
      throw new Error(`findReplace would empty block ${block.id}; delete the block instead.`)
    }
    if (operation.trackChanges) recordChange(block, text)
    block.text = text
  }
  if (!total) throw new Error(`findReplace found no match for "${operation.find}".`)
}

function findComment(model: DocumentModel, commentId: string): DocumentComment {
  const comment = model.comments.find((candidate) => candidate.id === commentId)
  if (!comment) throw new Error(`Comment not found: ${commentId}`)
  return comment
}

function findChange(model: DocumentModel, changeId: string): DocumentChange {
  const change = model.changes.find((candidate) => candidate.id === changeId)
  if (!change) throw new Error(`Change not found: ${changeId}`)
  return change
}

/**
 * Rejecting restores `before` only when this change still describes the block's
 * current text — i.e. it is the latest pending change on that block. An earlier
 * pending change in a chain simply drops its record: its `before` is history the
 * surviving later change already supersedes.
 */
function rejectChange(model: DocumentModel, changeId: string): void {
  const change = findChange(model, changeId)
  if (change.accepted) throw new Error(`Change already accepted: ${changeId}`)
  const block = model.blocks.find((candidate) => candidate.id === change.blockId)
  const laterPending = model.changes.some(
    (candidate) =>
      candidate.blockId === change.blockId &&
      !candidate.accepted &&
      candidate.id !== change.id &&
      candidate.before === change.after
  )
  if (block && block.type !== "table" && !laterPending && block.text === change.after)
    block.text = change.before
  model.changes = model.changes.filter((candidate) => candidate.id !== changeId)
}

/** Longest outline entry text in a summary. */
const OUTLINE_TEXT_CHARS = 80
export const DEFAULT_OUTLINE_LIMIT = 200

/** Compact, model-facing description of a document — never its full text. */
export interface DocumentSummary {
  title: string
  blockCount: number
  blockTypes: Partial<Record<DocumentBlockType, number>>
  comments: { open: number; resolved: number }
  changes: { pending: number; accepted: number }
  /** Block ids in order with a short text preview, for targeting edits. */
  outline: Array<{ id: string; type: DocumentBlockType; level?: number; text: string }>
  outlineTruncated: boolean
  importedFeatures: string[]
  sourceFilename?: string
}

export function summarizeDocument(
  model: DocumentModel,
  outlineLimit = DEFAULT_OUTLINE_LIMIT
): DocumentSummary {
  const blockTypes: Partial<Record<DocumentBlockType, number>> = {}
  for (const block of model.blocks) blockTypes[block.type] = (blockTypes[block.type] ?? 0) + 1
  const preview = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim()
    return flat.length > OUTLINE_TEXT_CHARS ? `${flat.slice(0, OUTLINE_TEXT_CHARS - 1)}…` : flat
  }
  return {
    title: model.title,
    blockCount: model.blocks.length,
    blockTypes,
    comments: {
      open: model.comments.filter((comment) => !comment.resolved).length,
      resolved: model.comments.filter((comment) => comment.resolved).length,
    },
    changes: {
      pending: model.changes.filter((change) => !change.accepted).length,
      accepted: model.changes.filter((change) => change.accepted).length,
    },
    outline: model.blocks.slice(0, outlineLimit).map((block) => ({
      id: block.id,
      type: block.type,
      ...(block.type === "heading" ? { level: block.level } : {}),
      ...(block.type === "list-item" && block.level ? { level: block.level } : {}),
      text: preview(
        block.type === "table" ? block.rows.map((row) => row.join(" | ")).join(" / ") : block.text
      ),
    })),
    outlineTruncated: model.blocks.length > outlineLimit,
    importedFeatures: model.importedFeatures,
    ...(model.sourceFilename ? { sourceFilename: model.sourceFilename } : {}),
  }
}

/**
 * One validation finding. `message` is the English text tools hand to the
 * model; `params` carries the values the preview needs to render the same
 * finding through the `finding.<code>` translation key.
 */
export interface DocumentFinding {
  severity: "error" | "warning"
  code: string
  message: string
  params?: Record<string, string | number>
}

/**
 * Imported-feature ids. Documents imported before the ids existed stored the
 * English label ("tracked changes", "headers/footers"); both spellings map to
 * the same id so the preview can localize either.
 */
export function normalizeFeatureId(feature: string): string {
  const clean = feature.trim().toLowerCase()
  if (clean.startsWith("fields")) return "fields"
  return clean.replace(/[\s/]+/g, "-")
}

export function validateDocument(model: DocumentModel): DocumentFinding[] {
  const findings: DocumentFinding[] = []
  if (!model.blocks.length)
    findings.push({
      severity: "warning",
      code: "document.empty",
      message: "Document has no content.",
    })
  const ids = new Set<string>()
  for (const block of model.blocks) {
    if (ids.has(block.id))
      findings.push({
        severity: "error",
        code: "block.duplicate_id",
        message: `Duplicate block id: ${block.id}`,
        params: { id: block.id },
      })
    ids.add(block.id)
    if (block.type === "heading" && !isHeadingLevel(block.level))
      findings.push({
        severity: "error",
        code: "block.heading_level",
        message: `Heading ${block.id} has unsupported level ${String(block.level)}.`,
        params: { id: block.id, level: String(block.level) },
      })
    if (block.type === "list-item" && !isListLevel(block.level))
      findings.push({
        severity: "error",
        code: "block.list_level",
        message: `List item ${block.id} has unsupported nesting level ${String(block.level)}.`,
        params: { id: block.id, level: String(block.level) },
      })
    if (block.type === "table") {
      if (!block.rows.length)
        findings.push({
          severity: "warning",
          code: "table.empty",
          message: `Table ${block.id} has no rows.`,
          params: { id: block.id },
        })
      else if (block.rows.some((row) => row.length !== block.rows[0].length))
        findings.push({
          severity: "warning",
          code: "table.ragged",
          message: `Table ${block.id} rows have inconsistent column counts.`,
          params: { id: block.id },
        })
    }
  }
  const anchorIds = new Set<string>()
  for (const comment of model.comments) {
    if (anchorIds.has(comment.id))
      findings.push({
        severity: "error",
        code: "comment.duplicate_id",
        message: `Duplicate comment id: ${comment.id}`,
        params: { id: comment.id },
      })
    anchorIds.add(comment.id)
    if (!ids.has(comment.blockId))
      findings.push({
        severity: "error",
        code: "comment.orphan",
        message: `Comment ${comment.id} has no target block.`,
        params: { id: comment.id },
      })
  }
  anchorIds.clear()
  for (const change of model.changes) {
    if (anchorIds.has(change.id))
      findings.push({
        severity: "error",
        code: "change.duplicate_id",
        message: `Duplicate change id: ${change.id}`,
        params: { id: change.id },
      })
    anchorIds.add(change.id)
    if (!ids.has(change.blockId))
      findings.push({
        severity: "error",
        code: "change.orphan",
        message: `Change ${change.id} has no target block.`,
        params: { id: change.id },
      })
  }
  for (const feature of model.importedFeatures)
    findings.push({
      severity: "warning",
      code: "import.feature",
      message: `Imported feature requires review: ${feature}`,
      params: { feature: normalizeFeatureId(feature) },
    })
  return findings
}

function requireText(value: string, name: string) {
  const clean = typeof value === "string" ? value.trim() : ""
  if (!clean) throw new Error(`${name} is required.`)
  return clean
}
