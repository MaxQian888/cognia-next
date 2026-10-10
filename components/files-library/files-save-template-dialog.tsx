"use client"

/**
 * "Save as template" from a Files item (ADR-0223): reads the target the item
 * menu set, takes the item's current text (`documentDraftOf`) and hands it to
 * the shared save dialog. An item whose text is gone says so instead.
 */

import { useEffect, useMemo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  SaveDocumentTemplateDialog,
  type SaveDocumentTemplateRequest,
} from "@/components/document-templates/save-document-template-dialog"
import { displayTitle } from "@/hooks/files-library/use-files-actions"
import { documentDraftOf } from "@/lib/files-library/document-draft"
import type { FilesEntry } from "@/lib/files-library/types"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useFilesLibraryStore } from "@/stores/files-library"

export function FilesSaveTemplateDialog({ entries }: { entries: readonly FilesEntry[] }) {
  const t = useTranslations("files")
  const target = useFilesLibraryStore((s) => s.saveTemplateTarget)
  const close = useFilesLibraryStore((s) => s.closeSaveTemplate)
  const entry = target ? entries.find((candidate) => candidate.key === target) : undefined
  const canvasDocuments = useArtifactStore((s) => s.canvasDocuments)
  const artifacts = useArtifactStore((s) => s.artifacts)

  const request = useMemo<SaveDocumentTemplateRequest | null>(() => {
    if (!entry) return null
    const draft = documentDraftOf(entry, { canvasDocuments, artifacts })
    return draft ? { mode: "create", draft, name: displayTitle(entry, t) } : null
  }, [entry, canvasDocuments, artifacts, t])

  // A target with nothing to save (its source went away) closes with a reason.
  const missing = target !== null && entries.length > 0 && request === null
  useEffect(() => {
    if (!missing) return
    toast.error(t("errors.files_source_missing"))
    close()
  }, [missing, close, t])

  return <SaveDocumentTemplateDialog request={request} onClose={close} />
}
