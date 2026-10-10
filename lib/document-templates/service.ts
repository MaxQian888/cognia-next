/**
 * Document templates as one list (ADR-0223): the built-ins in code plus the
 * ones people saved (`documentTemplates` table), and the two things to do with
 * them — start a canvas document from one, or save a document as one.
 *
 * Starting from a template copies its content into a NEW canvas document the
 * person owns; the document never points back at the template, so editing or
 * deleting a template changes nothing already made from it.
 */

import {
  createDocumentTemplate,
  updateDocumentTemplate,
  type DocumentTemplateRow,
} from "@/lib/db/document-templates"
import type { ArtifactLanguage, CanvasDocumentCreator } from "@/types/artifact/artifact"

import {
  BUILTIN_DOCUMENT_TEMPLATE_FORMAT,
  BUILTIN_DOCUMENT_TEMPLATE_ICONS,
  BUILTIN_DOCUMENT_TEMPLATE_IDS,
  type BuiltinDocumentTemplateCopy,
  type BuiltinDocumentTemplateId,
  type DocumentTemplateIcon,
} from "./builtin"

export interface DocumentTemplateOption {
  /** A built-in's id, or a saved template's `dtpl_` id. */
  id: string
  source: "builtin" | "user"
  name: string
  description?: string
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
  icon: DocumentTemplateIcon
  /** Saved templates only. */
  updatedAt?: number
}

/** The built-ins, in their fixed order, with copy from the caller's locale. */
export function builtinDocumentTemplateOptions(
  copyOf: (id: BuiltinDocumentTemplateId) => BuiltinDocumentTemplateCopy
): DocumentTemplateOption[] {
  return BUILTIN_DOCUMENT_TEMPLATE_IDS.map((id) => {
    const copy = copyOf(id)
    return {
      id,
      source: "builtin",
      name: copy.name,
      description: copy.description,
      content: copy.content,
      ...BUILTIN_DOCUMENT_TEMPLATE_FORMAT,
      icon: BUILTIN_DOCUMENT_TEMPLATE_ICONS[id],
    }
  })
}

export function userDocumentTemplateOption(row: DocumentTemplateRow): DocumentTemplateOption {
  return {
    id: row.id,
    source: "user",
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    content: row.content,
    language: row.language,
    type: row.type,
    icon: "saved",
    updatedAt: row.updatedAt,
  }
}

/** Built-ins first, then saved templates newest first. */
export function documentTemplateOptions(
  builtins: readonly DocumentTemplateOption[],
  rows: readonly DocumentTemplateRow[]
): DocumentTemplateOption[] {
  const saved = [...rows]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .map(userDocumentTemplateOption)
  return [...builtins, ...saved]
}

export interface CreateFromTemplateDeps {
  createCanvasDocument: (params: {
    title: string
    content: string
    language: ArtifactLanguage
    type: "code" | "text"
    createdBy: CanvasDocumentCreator
  }) => string
}

/** A new canvas document with the template's content, named after it. */
export function createDocumentFromTemplate(
  option: Pick<DocumentTemplateOption, "name" | "content" | "language" | "type">,
  deps: CreateFromTemplateDeps
): string {
  return deps.createCanvasDocument({
    title: option.name,
    content: option.content,
    language: option.language,
    type: option.type,
    createdBy: "user",
  })
}

export interface SaveDocumentTemplateInput {
  name: string
  description?: string
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
}

/** Save a document's current text as a new template. */
export async function saveDocumentAsTemplate(
  input: SaveDocumentTemplateInput
): Promise<DocumentTemplateRow> {
  const description = input.description?.trim()
  return createDocumentTemplate({
    name: input.name,
    ...(description ? { description } : {}),
    content: input.content,
    language: input.language,
    type: input.type,
  })
}

/** Rename or re-describe a saved template; its content is left as it is. */
export async function editDocumentTemplateDetails(
  id: string,
  details: { name: string; description?: string }
): Promise<DocumentTemplateRow> {
  return updateDocumentTemplate(id, {
    name: details.name,
    description: details.description?.trim() ?? "",
  })
}
