export const DOCUMENT_SCHEMA_VERSION = 1 as const
export const DOCUMENT_ARTIFACT_KIND = "cognia-documents/document"
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

export type DocumentBlock =
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "heading"; level: 1 | 2 | 3; text: string }
  | { id: string; type: "list-item"; ordered: boolean; text: string }
  | { id: string; type: "table"; rows: string[][] }

/** Block payload accepted by the `insertBlock` operation — the id is host-assigned. */
export type DocumentBlockInput =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "list-item"; ordered?: boolean; text: string }
  | { type: "table"; rows: string[][] }

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
  | { op: "appendHeading"; text: string; level: 1 | 2 | 3 }
  | { op: "appendListItem"; text: string; ordered?: boolean }
  | { op: "appendTable"; rows: string[][] }
  | { op: "insertBlock"; afterBlockId?: string; block: DocumentBlockInput }
  | { op: "deleteBlock"; blockId: string }
  | { op: "moveBlock"; blockId: string; toIndex: number }
  | { op: "replaceText"; blockId: string; text: string; trackChange?: boolean }
  | { op: "updateTableCell"; blockId: string; row: number; column: number; text: string }
  | { op: "addComment"; blockId: string; text: string; author?: string }
  | { op: "resolveComment"; commentId: string }
  | { op: "reopenComment"; commentId: string }
  | { op: "acceptChange"; changeId: string }
  | { op: "rejectChange"; changeId: string }
  | { op: "acceptAllChanges" }
  | { op: "rejectAllChanges" }
  | { op: "stripComments" }

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

const BLOCK_TYPES = new Set(["paragraph", "heading", "list-item", "table"])

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
  if (block.type === "heading" && ![1, 2, 3].includes(block.level))
    throw new Error(`Invalid document: ${where}.level must be 1, 2, or 3.`)
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

function materializeBlock(input: DocumentBlockInput, id: string): DocumentBlock {
  if (input.type === "table") {
    if (!input.rows.length || input.rows.some((row) => !row.length))
      throw new Error("Table rows cannot be empty.")
    return { id, type: "table", rows: input.rows.map((row) => row.map(String)) }
  }
  const text = requireText(input.text, "text")
  if (input.type === "heading") return { id, type: "heading", level: input.level, text }
  if (input.type === "list-item")
    return { id, type: "list-item", ordered: Boolean(input.ordered), text }
  return { id, type: "paragraph", text }
}

export function applyDocumentOperations(
  model: DocumentModel,
  operations: DocumentOperation[]
): DocumentModel {
  const next = structuredClone(model)
  let sequence = nextSequence(next)
  const blockIndex = (blockId: string) => next.blocks.findIndex((block) => block.id === blockId)
  for (const operation of operations) {
    if (operation.op === "setTitle") next.title = requireText(operation.title, "title")
    else if (operation.op === "appendParagraph")
      next.blocks.push(
        materializeBlock({ type: "paragraph", text: operation.text }, `b${sequence++}`)
      )
    else if (operation.op === "appendHeading")
      next.blocks.push(
        materializeBlock(
          { type: "heading", level: operation.level, text: operation.text },
          `b${sequence++}`
        )
      )
    else if (operation.op === "appendListItem")
      next.blocks.push(
        materializeBlock(
          { type: "list-item", ordered: operation.ordered, text: operation.text },
          `b${sequence++}`
        )
      )
    else if (operation.op === "appendTable")
      next.blocks.push(materializeBlock({ type: "table", rows: operation.rows }, `b${sequence++}`))
    else if (operation.op === "insertBlock") {
      const at = operation.afterBlockId === undefined ? -1 : blockIndex(operation.afterBlockId)
      if (operation.afterBlockId !== undefined && at < 0)
        throw new Error(`Insert anchor block not found: ${operation.afterBlockId}`)
      next.blocks.splice(at + 1, 0, materializeBlock(operation.block, `b${sequence++}`))
    } else if (operation.op === "deleteBlock") {
      const at = blockIndex(operation.blockId)
      if (at < 0) throw new Error(`Block not found: ${operation.blockId}`)
      next.blocks.splice(at, 1)
      next.comments = next.comments.filter((comment) => comment.blockId !== operation.blockId)
      next.changes = next.changes.filter((change) => change.blockId !== operation.blockId)
    } else if (operation.op === "moveBlock") {
      const from = blockIndex(operation.blockId)
      if (from < 0) throw new Error(`Block not found: ${operation.blockId}`)
      const [block] = next.blocks.splice(from, 1)
      const to = Math.max(0, Math.min(next.blocks.length, Math.trunc(operation.toIndex)))
      next.blocks.splice(to, 0, block)
    } else if (operation.op === "replaceText") {
      const block = next.blocks.find((candidate) => candidate.id === operation.blockId)
      if (!block || block.type === "table")
        throw new Error(`Editable text block not found: ${operation.blockId}`)
      const text = requireText(operation.text, "text")
      if (operation.trackChange)
        next.changes.push({
          id: `c${sequence++}`,
          blockId: block.id,
          before: block.text,
          after: text,
          accepted: false,
        })
      block.text = text
    } else if (operation.op === "updateTableCell") {
      const block = next.blocks.find((candidate) => candidate.id === operation.blockId)
      if (!block || block.type !== "table")
        throw new Error(`Table block not found: ${operation.blockId}`)
      const row = block.rows[operation.row]
      if (!row || operation.column < 0 || operation.column >= row.length)
        throw new Error(
          `Table cell out of range: ${operation.blockId} [${operation.row}, ${operation.column}]`
        )
      row[operation.column] = operation.text
    } else if (operation.op === "addComment") {
      if (!next.blocks.some((block) => block.id === operation.blockId))
        throw new Error(`Comment block not found: ${operation.blockId}`)
      next.comments.push({
        id: `m${sequence++}`,
        blockId: operation.blockId,
        text: requireText(operation.text, "comment"),
        author: operation.author?.trim() || "Cognia",
        resolved: false,
      })
    } else if (operation.op === "resolveComment") {
      findComment(next, operation.commentId).resolved = true
    } else if (operation.op === "reopenComment") {
      findComment(next, operation.commentId).resolved = false
    } else if (operation.op === "acceptChange") {
      findChange(next, operation.changeId).accepted = true
    } else if (operation.op === "rejectChange") {
      rejectChange(next, operation.changeId)
    } else if (operation.op === "acceptAllChanges")
      next.changes.forEach((change) => {
        change.accepted = true
      })
    else if (operation.op === "rejectAllChanges") {
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
    } else if (operation.op === "stripComments") next.comments = []
  }
  return next
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
    if (block.type === "heading" && ![1, 2, 3].includes(block.level))
      findings.push({
        severity: "error",
        code: "block.heading_level",
        message: `Heading ${block.id} has unsupported level ${String(block.level)}.`,
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
  const clean = value.trim()
  if (!clean) throw new Error(`${name} is required.`)
  return clean
}
