"use client"

// The ONE row above the textarea, and only for what has NO form in the text.
//
// Attachments, @-referenced files and folders, workflow refs and selected
// artifacts have no textual representation — take their chip away and the user
// cannot see or remove them at all. Everything that IS in the text is shown in
// the text: a `/command` is a pill on its own token, a link is blue underlined
// label. Chipping those a second time above the box was pure duplication, and
// four stacked bands of it pushed the input down the screen.
//
// What remains shares one wrapping flow, composed from each chip set's existing
// component in `bare` mode (same markup, same remove buttons, same preview
// panel — nothing is reimplemented). A failed command from the last submit is
// the one exception that still earns a pill here: it has no other surface, and
// a silent failure is worse than a chip.
//
// When that flow needs more than one line it folds: the first row stays, the
// rest hide behind a "+N" toggle (`use-overflow-fold.ts`). Folding is a
// measurement, not a count — how much fits depends on the labels and the pane.
//
// The row is ALWAYS mounted and wrapped in `<Collapse>`, matching the other
// bands stacked above the textarea. It used to early-return `null` when empty,
// which (a) made the whole row pop in and out while its neighbours slid, and
// (b) tore down the chips' `<AnimatePresence>` boundary, so removing the last
// attachment skipped its exit animation. Height now comes from the content:
// `has-[>*]:pt-2` keeps the padding off an empty row so it measures a true 0.

import { useRef } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { formatBytesCompact } from "@/lib/observability/format-utils"
import { cn } from "@/lib/utils"
import { ReferenceChips } from "../reference-chips"
import { ArtifactSelectionChips } from "./artifact-selection-chips"
import { WorkflowRefChips } from "./workflow-ref-chips"
import { AttachmentPreview, type AttachmentPreviewProps } from "./attachment-preview"
import { PreparingImagesChip } from "./preparing-images-chip"
import { FailedCommandChips } from "./failed-command-chips"
import { Collapse } from "./collapse"
import { useOverflowFold } from "./use-overflow-fold"
import { useStagedAttachments } from "./staged-attachment-store"
import type { InputSegment } from "@/lib/slash-commands/parse-segments"
import type { CommandError } from "@/lib/slash-commands/run-segments"
import { Surface } from "@/components/surface/surface"

export type ContextChipBarProps = AttachmentPreviewProps & {
  /**
   * Images being decoded/downscaled before they can be staged. They have no
   * attachment chip yet, so the bar shows a placeholder for them.
   */
  preparingImageCount?: number
  /** Parsed segments — read only to name the commands that FAILED. */
  segments?: readonly InputSegment[]
  /** Per-command failures from the last submit. */
  commandErrors?: readonly CommandError[]
  /** Splice one command out of the raw input (absolute range). */
  onRemoveCommand?: (start: number, end: number) => void
}

export function ContextChipBar(props: ContextChipBarProps = {}) {
  const t = useTranslations("chat.composer.context")
  const staged = useStagedAttachments()
  const flowRef = useRef<HTMLDivElement>(null)
  const fold = useOverflowFold(flowRef)

  // Real staged-blob bytes. The previous implementation summed
  // `estimateDataUrlBytes(f.url)`, which only understands `data:` URLs — staged
  // attachments carry `blob:` URLs, so the total was permanently 0 and this
  // hint never rendered at all.
  const totalBytes = staged.totalBytes
  const folded = fold.hiddenCount > 0 && !fold.expanded

  return (
    <Collapse>
      <div className="relative px-2">
        <div
          ref={flowRef}
          role="group"
          aria-label={t("ariaLabel")}
          data-folded={folded || undefined}
          className={cn(
            "flex flex-wrap items-center gap-2 has-[>*]:pt-2",
            // Reserve the toggle's corner as soon as one exists, and keep it
            // reserved while expanded: a reservation that came and went would
            // change the wrap and could re-hide the chip that made it appear.
            fold.hiddenCount > 0 && "pe-14",
            folded && "overflow-hidden"
          )}
          style={folded && fold.firstRowHeight > 0 ? { maxHeight: fold.firstRowHeight } : undefined}
        >
          {props.segments && props.onRemoveCommand ? (
            <FailedCommandChips
              segments={props.segments}
              errors={props.commandErrors}
              onRemove={props.onRemoveCommand}
            />
          ) : null}
          <ReferenceChips bare />
          <WorkflowRefChips bare />
          <ArtifactSelectionChips bare />
          <AttachmentPreview bare {...props} />
          <PreparingImagesChip count={props.preparingImageCount ?? 0} />
          {totalBytes > 0 ? (
            <span className="text-[11px] tabular-nums text-muted-foreground" aria-hidden>
              {formatBytesCompact(totalBytes)}
            </span>
          ) : null}
        </div>
        {fold.hiddenCount > 0 ? (
          <Surface asChild layer="raised">
            <button
              type="button"
              data-testid="composer-context-fold"
              onClick={fold.toggle}
              aria-expanded={fold.expanded}
              aria-label={
                fold.expanded ? t("foldCollapse") : t("foldExpand", { count: fold.hiddenCount })
              }
              className="absolute end-2 top-2 inline-flex h-7 items-center gap-0.5 rounded-md border px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {fold.expanded ? (
                <ChevronUpIcon className="size-3" aria-hidden />
              ) : (
                <ChevronDownIcon className="size-3" aria-hidden />
              )}
              {fold.expanded ? t("foldCollapseShort") : `+${fold.hiddenCount}`}
            </button>
          </Surface>
        ) : null}
      </div>
    </Collapse>
  )
}
