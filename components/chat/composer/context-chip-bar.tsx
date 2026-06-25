"use client"

// Unified context bar above the textarea. Merges the two previously-separate
// rows — @-referenced files/folders (reference model) and staged attachments
// (inline model) — into one flex flow, with a compact total-size hint. Both
// chip sets are composed from their existing components in `bare` mode so we
// reuse their markup, remove buttons, and OCR menu rather than reimplementing.

import { useTranslations } from "next-intl"
import { useChatStore } from "@/stores/chat"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { estimateDataUrlBytes } from "@/lib/chat/draft-attachments"
import { formatBytesCompact } from "@/lib/observability/format-utils"
import { ReferenceChips } from "../reference-chips"
import { ArtifactSelectionChips } from "./artifact-selection-chips"
import { AttachmentPreview, type AttachmentPreviewProps } from "./attachment-preview"

export type ContextChipBarProps = AttachmentPreviewProps

export function ContextChipBar(props: ContextChipBarProps = {}) {
  const t = useTranslations("chat.composer.context")
  const refs = useChatStore((s) => s.referencedPaths)
  const selections = useChatStore((s) => s.artifactSelections)
  const attachments = usePromptInputAttachments()

  const refCount = refs.length
  const selCount = selections.length
  const fileCount = attachments.files.length
  if (refCount === 0 && selCount === 0 && fileCount === 0) return null

  // Only data: URLs carry a recoverable size; blob: previews contribute 0.
  const totalBytes = attachments.files.reduce((sum, f) => sum + estimateDataUrlBytes(f.url), 0)

  return (
    <div
      role="group"
      aria-label={t("ariaLabel")}
      className="flex flex-wrap items-center gap-2 px-2 pt-2"
    >
      <ReferenceChips bare />
      <ArtifactSelectionChips bare />
      <AttachmentPreview bare {...props} />
      {totalBytes > 0 ? (
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground" aria-hidden>
          {formatBytesCompact(totalBytes)}
        </span>
      ) : null}
    </div>
  )
}
