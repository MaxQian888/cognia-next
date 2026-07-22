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
import { WorkflowRefChips } from "./workflow-ref-chips"
import { AttachmentPreview, type AttachmentPreviewProps } from "./attachment-preview"
import { ComposerLinkChips } from "./link-context"
import { extractHttpUrls } from "@/lib/chat/link-context"

export type ContextChipBarProps = AttachmentPreviewProps & {
  text?: string
  onRemoveLink?: (url: string) => void
}

export function ContextChipBar(props: ContextChipBarProps = {}) {
  const t = useTranslations("chat.composer.context")
  const refs = useChatStore((s) => s.referencedPaths)
  const selections = useChatStore((s) => s.artifactSelections)
  const workflowRefs = useChatStore((s) => s.referencedWorkflowElements)
  const attachments = usePromptInputAttachments()

  const refCount = refs.length
  const selCount = selections.length
  const wfRefCount = workflowRefs.length
  const fileCount = attachments.files.length
  const hasLinks = !!props.text && !!props.onRemoveLink && extractHttpUrls(props.text).length > 0
  if (refCount === 0 && selCount === 0 && wfRefCount === 0 && fileCount === 0 && !hasLinks) {
    return null
  }

  // Only data: URLs carry a recoverable size; blob: previews contribute 0.
  const totalBytes = attachments.files.reduce((sum, f) => sum + estimateDataUrlBytes(f.url), 0)

  return (
    <div
      role="group"
      aria-label={t("ariaLabel")}
      className="flex flex-wrap items-center gap-2 px-2 pt-2"
    >
      <ReferenceChips bare />
      <WorkflowRefChips bare />
      <ArtifactSelectionChips bare />
      <AttachmentPreview bare {...props} />
      {hasLinks && props.text && props.onRemoveLink ? (
        <ComposerLinkChips text={props.text} onRemove={props.onRemoveLink} />
      ) : null}
      {totalBytes > 0 ? (
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground" aria-hidden>
          {formatBytesCompact(totalBytes)}
        </span>
      ) : null}
    </div>
  )
}
