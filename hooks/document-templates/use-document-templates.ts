"use client"

/**
 * Every document template the person can start from (ADR-0223): the built-ins
 * in this locale, then the ones they saved, newest first — live, so a template
 * saved from the canvas shows up in Files without a reload.
 *
 * `enabled` follows the unified template platform flag; surfaces that offer
 * templates render nothing while it is off.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { listDocumentTemplates, type DocumentTemplateRow } from "@/lib/db/document-templates"
import type { BuiltinDocumentTemplateId } from "@/lib/document-templates/builtin"
import {
  builtinDocumentTemplateOptions,
  documentTemplateOptions,
  type DocumentTemplateOption,
} from "@/lib/document-templates/service"
import { isUnifiedTemplatePlatformEnabled } from "@/lib/templates/feature-flags"

const NO_ROWS: DocumentTemplateRow[] = []

export interface DocumentTemplates {
  enabled: boolean
  /** Undefined until the saved templates have loaded. */
  options: DocumentTemplateOption[] | undefined
}

export function useDocumentTemplates(): DocumentTemplates {
  const t = useTranslations("documentTemplates")
  const enabled = isUnifiedTemplatePlatformEnabled()
  const rows = useClientLiveQuery(
    () => (enabled ? listDocumentTemplates() : Promise.resolve(NO_ROWS)),
    [enabled],
    undefined
  )

  const builtins = useMemo(
    () =>
      builtinDocumentTemplateOptions((id: BuiltinDocumentTemplateId) => ({
        name: t(`builtin.${id}.name`),
        description: t(`builtin.${id}.description`),
        // The body is Markdown, not a message: read it raw so nothing in it is
        // taken for an ICU argument.
        content: String(t.raw(`builtin.${id}.content`)),
      })),
    [t]
  )

  const options = useMemo(
    () => (rows === undefined ? undefined : documentTemplateOptions(builtins, rows)),
    [builtins, rows]
  )

  return { enabled, options: enabled ? options : [] }
}
