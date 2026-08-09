export const DOCUMENT_SCHEMA_VERSION = 1 as const
export const DOCUMENT_ARTIFACT_KIND = "cognia-documents/document"
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

export type DocumentBlock =
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "heading"; level: 1 | 2 | 3; text: string }
  | { id: string; type: "list-item"; ordered: boolean; text: string }
  | { id: string; type: "table"; rows: string[][] }

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
  | { op: "appendParagraph"; text: string }
  | { op: "appendHeading"; text: string; level: 1 | 2 | 3 }
  | { op: "appendListItem"; text: string; ordered?: boolean }
  | { op: "appendTable"; rows: string[][] }
  | { op: "replaceText"; blockId: string; text: string; trackChange?: boolean }
  | { op: "addComment"; blockId: string; text: string; author?: string }
  | { op: "resolveComment"; commentId: string }
  | { op: "acceptAllChanges" }
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

export function parseDocument(content: string): DocumentModel {
  const parsed = JSON.parse(content) as DocumentModel
  if (parsed.schemaVersion !== DOCUMENT_SCHEMA_VERSION || !Array.isArray(parsed.blocks))
    throw new Error("Unsupported Cognia document schema.")
  return parsed
}

export function applyDocumentOperations(
  model: DocumentModel,
  operations: DocumentOperation[]
): DocumentModel {
  const next = structuredClone(model)
  let sequence = next.blocks.length + next.comments.length + next.changes.length + 1
  for (const operation of operations) {
    if (operation.op === "appendParagraph")
      next.blocks.push({
        id: `b${sequence++}`,
        type: "paragraph",
        text: requireText(operation.text, "text"),
      })
    else if (operation.op === "appendHeading")
      next.blocks.push({
        id: `b${sequence++}`,
        type: "heading",
        level: operation.level,
        text: requireText(operation.text, "text"),
      })
    else if (operation.op === "appendListItem")
      next.blocks.push({
        id: `b${sequence++}`,
        type: "list-item",
        ordered: Boolean(operation.ordered),
        text: requireText(operation.text, "text"),
      })
    else if (operation.op === "appendTable") {
      if (!operation.rows.length || operation.rows.some((row) => !row.length))
        throw new Error("Table rows cannot be empty.")
      next.blocks.push({
        id: `b${sequence++}`,
        type: "table",
        rows: operation.rows.map((row) => row.map(String)),
      })
    } else if (operation.op === "replaceText") {
      const block = next.blocks.find((candidate) => candidate.id === operation.blockId)
      if (!block || block.type === "table")
        throw new Error(`Editable text block not found: ${operation.blockId}`)
      if (operation.trackChange)
        next.changes.push({
          id: `c${sequence++}`,
          blockId: block.id,
          before: block.text,
          after: operation.text,
          accepted: false,
        })
      block.text = operation.text
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
      const comment = next.comments.find((candidate) => candidate.id === operation.commentId)
      if (!comment) throw new Error(`Comment not found: ${operation.commentId}`)
      comment.resolved = true
    } else if (operation.op === "acceptAllChanges")
      next.changes.forEach((change) => {
        change.accepted = true
      })
    else if (operation.op === "stripComments") next.comments = []
  }
  return next
}

export function validateDocument(model: DocumentModel) {
  const findings: Array<{ severity: "error" | "warning"; code: string; message: string }> = []
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
      })
    ids.add(block.id)
  }
  for (const comment of model.comments)
    if (!ids.has(comment.blockId))
      findings.push({
        severity: "error",
        code: "comment.orphan",
        message: `Comment ${comment.id} has no target block.`,
      })
  for (const feature of model.importedFeatures)
    findings.push({
      severity: "warning",
      code: "import.feature",
      message: `Imported feature requires review: ${feature}`,
    })
  return findings
}

function requireText(value: string, name: string) {
  const clean = value.trim()
  if (!clean) throw new Error(`${name} is required.`)
  return clean
}
