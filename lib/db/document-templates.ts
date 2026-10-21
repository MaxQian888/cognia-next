// Document templates the person saved (ADR-0223): a canvas document's content
// kept under a name, so "New → From template" in Files can start another
// document from it. The built-in templates (guide, to-do list, …) are code in
// `lib/document-templates/builtin.ts`, not rows here.
//
// Account-wide, not workspace-scoped: a template is a way of writing, not a
// piece of one repository's work. It rides the portable backup and its own
// Domain transfer row (`PORTABLE_BACKUP_BINDINGS`, `lib/data/domain/index.ts`).
// It is not a companion sync table: a paired phone lists and uses templates
// through the host's Files commands instead, which is also how it saves one.

import type { ArtifactLanguage } from "@/types/artifact/artifact"
import { getDb } from "./schema"
import type { DocumentTemplateRow } from "@cognia/plugin-contract/lib/db/document-templates"
export type { DocumentTemplateRow } from "@cognia/plugin-contract/lib/db/document-templates"

export interface DocumentTemplateDraft {
  /** Already trimmed and non-empty. */
  name: string
  description?: string
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
}

export class DocumentTemplateError extends Error {
  constructor(readonly code: "document_template_name_required" | "document_template_not_found") {
    super(code)
    this.name = "DocumentTemplateError"
  }
}

/**
 * Called after a write that changed what this table contains. The template
 * platform projects the table into its catalog
 * (`lib/templates/catalog-only-adapters.ts`), which imports this module — so a
 * callback registry rather than an import keeps `lib/db` the lower layer.
 */
type DocumentTemplatesListener = () => void

const listeners = new Set<DocumentTemplatesListener>()

export function subscribeDocumentTemplates(listener: DocumentTemplatesListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notifyDocumentTemplatesChanged(): void {
  for (const listener of [...listeners]) {
    // A subscriber that throws must not undo the save that just succeeded.
    try {
      listener()
    } catch {
      // Deliberately swallowed, see above.
    }
  }
}

function newId(): string {
  // The random tail keeps two templates saved in the same millisecond apart.
  return `dtpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Newest-edited first, which is the order the picker offers them in. */
export async function listDocumentTemplates(): Promise<DocumentTemplateRow[]> {
  const rows = await getDb().documentTemplates.toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}

export async function getDocumentTemplate(id: string): Promise<DocumentTemplateRow | undefined> {
  return getDb().documentTemplates.get(id)
}

export async function createDocumentTemplate(
  draft: DocumentTemplateDraft,
  now = Date.now()
): Promise<DocumentTemplateRow> {
  const name = draft.name.trim()
  if (!name) throw new DocumentTemplateError("document_template_name_required")
  const description = draft.description?.trim()
  const row: DocumentTemplateRow = {
    id: newId(),
    name,
    ...(description ? { description } : {}),
    content: draft.content,
    language: draft.language,
    type: draft.type,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().documentTemplates.put(row)
  notifyDocumentTemplatesChanged()
  return row
}

/**
 * Edit a template. `revision` moves only when the content does: a rename is
 * the same template under another name.
 */
export async function updateDocumentTemplate(
  id: string,
  patch: Partial<Pick<DocumentTemplateRow, "name" | "description" | "content">>,
  now = Date.now()
): Promise<DocumentTemplateRow> {
  const db = getDb()
  const next = await db.transaction("rw", db.documentTemplates, async () => {
    const current = await db.documentTemplates.get(id)
    if (!current) throw new DocumentTemplateError("document_template_not_found")
    const name = patch.name !== undefined ? patch.name.trim() : current.name
    if (!name) throw new DocumentTemplateError("document_template_name_required")
    const content = patch.content ?? current.content
    const description =
      patch.description !== undefined ? patch.description.trim() : current.description
    const row: DocumentTemplateRow = {
      ...current,
      name,
      content,
      revision: content !== current.content ? current.revision + 1 : current.revision,
      updatedAt: now,
    }
    if (description) row.description = description
    else delete row.description
    await db.documentTemplates.put(row)
    return row
  })
  notifyDocumentTemplatesChanged()
  return next
}

export async function deleteDocumentTemplate(id: string): Promise<void> {
  await getDb().documentTemplates.delete(id)
  notifyDocumentTemplatesChanged()
}
