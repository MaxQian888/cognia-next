/**
 * The document templates every account starts with (ADR-0223): a guide, a
 * to-do list, a project tracker, a weekly update and meeting notes. They are
 * code, not rows — the `documentTemplates` table holds only what people save —
 * and their names, descriptions and bodies are localized messages in the
 * `documentTemplates.builtin.*` namespace.
 *
 * The UI reads that copy through next-intl like any other string. The
 * template catalog projects outside React, so it reads the same split message
 * sources directly to fill each definition's localized metadata.
 */

import enMessages from "@/i18n/messages/en/documentTemplates.json"
import zhMessages from "@/i18n/messages/zh-CN/documentTemplates.json"
import type { ArtifactLanguage } from "@/types/artifact/artifact"

export const BUILTIN_DOCUMENT_TEMPLATE_IDS = [
  "guide",
  "todo",
  "project-tracker",
  "weekly-update",
  "meeting-notes",
] as const

export type BuiltinDocumentTemplateId = (typeof BUILTIN_DOCUMENT_TEMPLATE_IDS)[number]

/** Glyph keys the UI maps to icons; "blank" is the empty-page card. */
export type DocumentTemplateIcon =
  "blank" | "guide" | "todo" | "tracker" | "update" | "meeting" | "saved"

export const BUILTIN_DOCUMENT_TEMPLATE_ICONS: Record<
  BuiltinDocumentTemplateId,
  DocumentTemplateIcon
> = {
  guide: "guide",
  todo: "todo",
  "project-tracker": "tracker",
  "weekly-update": "update",
  "meeting-notes": "meeting",
}

/** Every built-in is a Markdown text document. */
export const BUILTIN_DOCUMENT_TEMPLATE_FORMAT: { language: ArtifactLanguage; type: "text" } = {
  language: "markdown",
  type: "text",
}

export function isBuiltinDocumentTemplateId(value: string): value is BuiltinDocumentTemplateId {
  return (BUILTIN_DOCUMENT_TEMPLATE_IDS as readonly string[]).includes(value)
}

export interface BuiltinDocumentTemplateCopy {
  name: string
  description: string
  content: string
}

type BuiltinMessages = { builtin: Record<BuiltinDocumentTemplateId, BuiltinDocumentTemplateCopy> }

/** The catalog's locales; the first is the fallback. */
export const BUILTIN_DOCUMENT_TEMPLATE_LOCALES = {
  en: enMessages as BuiltinMessages,
  "zh-CN": zhMessages as BuiltinMessages,
} as const

export type BuiltinDocumentTemplateLocale = keyof typeof BUILTIN_DOCUMENT_TEMPLATE_LOCALES

/** A built-in's copy in one locale (English when the locale is unknown). */
export function builtinDocumentTemplateCopy(
  id: BuiltinDocumentTemplateId,
  locale: string
): BuiltinDocumentTemplateCopy {
  const messages =
    BUILTIN_DOCUMENT_TEMPLATE_LOCALES[locale as BuiltinDocumentTemplateLocale] ??
    BUILTIN_DOCUMENT_TEMPLATE_LOCALES.en
  return messages.builtin[id]
}
