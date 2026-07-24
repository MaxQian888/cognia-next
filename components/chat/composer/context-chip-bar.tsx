"use client"

// Unified context bar above the textarea. Merges the previously-separate rows —
// @-referenced files/folders (reference model) and staged attachments (inline
// model) — into one flex flow, with a compact total-size hint. Every chip set is
// composed from its existing component in `bare` mode so we reuse their markup,
// remove buttons, and preview panel rather than reimplementing them.
//
// The bar is ALWAYS mounted and wrapped in `<Collapse>`, matching the six other
// bands stacked above the textarea. It used to early-return `null` when empty,
// which (a) made the whole row pop in and out while its neighbours slid, and
// (b) tore down the chips' `<AnimatePresence>` boundary, so removing the last
// attachment skipped its exit animation. Height now comes from the content:
// `has-[>*]:pt-2` keeps the padding off an empty row so it measures a true 0.

import { useTranslations } from "next-intl"
import { formatBytesCompact } from "@/lib/observability/format-utils"
import { ReferenceChips } from "../reference-chips"
import { ArtifactSelectionChips } from "./artifact-selection-chips"
import { WorkflowRefChips } from "./workflow-ref-chips"
import { AttachmentPreview, type AttachmentPreviewProps } from "./attachment-preview"
import { ComposerLinkChips } from "./link-context"
import { Collapse } from "./collapse"
import { useStagedAttachments } from "./staged-attachment-store"
import { extractHttpUrls } from "@/lib/chat/link-context"

export type ContextChipBarProps = AttachmentPreviewProps & {
  text?: string
  onRemoveLink?: (url: string) => void
}

export function ContextChipBar(props: ContextChipBarProps = {}) {
  const t = useTranslations("chat.composer.context")
  const staged = useStagedAttachments()
  const hasLinks = !!props.text && !!props.onRemoveLink && extractHttpUrls(props.text).length > 0

  // Real staged-blob bytes. The previous implementation summed
  // `estimateDataUrlBytes(f.url)`, which only understands `data:` URLs — staged
  // attachments carry `blob:` URLs, so the total was permanently 0 and this
  // hint never rendered at all.
  const totalBytes = staged.totalBytes

  return (
    <Collapse>
      <div
        role="group"
        aria-label={t("ariaLabel")}
        className="flex flex-wrap items-center gap-2 px-2 has-[>*]:pt-2"
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
    </Collapse>
  )
}
