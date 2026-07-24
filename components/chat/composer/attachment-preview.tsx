"use client"

/**
 * Staged-attachment chips above the textarea.
 *
 * Built ON the vendored `ai-elements/attachments` primitives rather than
 * re-implementing them. That is not just reuse — the vendored `inline` variant
 * is a fixed `h-8` flex row whose remove button sits IN the flex flow, which
 * structurally fixes two long-standing defects of the old hand-rolled markup:
 * an 80px image square next to 28px text chips blew the bar's height up, and an
 * absolutely-positioned remove button permanently covered the tail of the
 * filename on touch (where there is no hover to reveal it).
 *
 * `<AnimatePresence>` is mounted UNCONDITIONALLY — above any "no attachments"
 * early return. Returning null first would unmount the presence boundary along
 * with the chip that is trying to leave, so removing the LAST attachment popped
 * instead of animating out while removing any other one animated correctly.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import { AlertTriangleIcon, Loader2Icon } from "lucide-react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview as AttachmentMediaPreview,
  AttachmentRemove,
  Attachments,
  type AttachmentData,
} from "@/components/ai-elements/attachments"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { applyOrder, resolveDragEnd } from "@/lib/chat/attachments/reorder"
import type { RejectReason } from "@/lib/chat/attachments/dispatch"
import { cn } from "@/lib/utils"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { useStagedAttachments, type StagedAttachmentState } from "./staged-attachment-store"
import { AttachmentPreviewSheet, type PreviewTarget } from "./attachment-preview-sheet"

export interface AttachmentPreviewProps {
  /** Runs OCR for an image attachment (invoked from the preview panel). */
  onRunOcr?: (attachmentId: string) => void | Promise<void>
  /** Disable the OCR trigger while a call is in flight. */
  ocrBusy?: boolean
  /** Opens the richer per-page OCR sheet. Absent until a result exists. */
  onViewOcrDetail?: () => void
  /** Appends the OCR text to the draft instead of attaching it to the payload. */
  onExtractOcrToInput?: (attachmentId: string) => void | Promise<void>
  /**
   * When true, render only the chips (no padded container) so a parent bar can
   * lay attachments and references out in a single flex flow.
   */
  bare?: boolean
}

/** i18n key suffix for a machine-readable rejection reason. */
const REJECT_KEY: Record<RejectReason, string> = {
  "not-data-url": "notDataUrl",
  "unsupported-type": "unsupportedType",
  empty: "empty",
  "parse-failed": "parseFailed",
}

export function AttachmentPreview(props: AttachmentPreviewProps = {}) {
  const t = useTranslations("chat.composer.attachments")
  const attachments = usePromptInputAttachments()
  const staged = useStagedAttachments()
  const transition = useReducedMotionTransition(mobileTransition("fast"))
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)

  // Chips follow the user's drag order, not insertion order — and so does the
  // outbound payload (see `buildAttachmentBlocks`).
  const ordered = useMemo(
    () => applyOrder(attachments.files, staged.order),
    [attachments.files, staged.order]
  )

  const target: PreviewTarget | null = useMemo(() => {
    const file = ordered.find((f) => f.id === previewId)
    return file
      ? { id: file.id, url: file.url, filename: file.filename, mediaType: file.mediaType }
      : null
  }, [ordered, previewId])

  // `distance: 4` is what lets a chip be both draggable and clickable: a press
  // with no movement never starts a drag, so the preview button and the remove
  // button still receive their click.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const onDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null)
    const activeId = String(event.active.id)
    const target = resolveDragEnd(activeId, event.over ? String(event.over.id) : null)
    if (target) staged.reorder(activeId, target)
  }

  const chips = (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(e) => setActiveDragId(String(e.active.id))}
      onDragCancel={() => setActiveDragId(null)}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={ordered.map((f) => f.id)} strategy={rectSortingStrategy}>
        <AnimatePresence initial={false}>
          {ordered.map((f) => (
            <SortableChip
              key={f.id}
              file={f}
              state={staged.byId.get(f.id)}
              // Framer's `layout` and dnd-kit both write `transform`. Hand the
              // reflow to dnd-kit for the duration of a drag so they don't
              // fight over the settle; framer keeps enter/exit either way.
              animateLayout={activeDragId === null}
              transition={transition}
              onOpenPreview={() => setPreviewId(f.id)}
              onRemove={() => attachments.remove(f.id)}
              t={t}
            />
          ))}
        </AnimatePresence>
      </SortableContext>
    </DndContext>
  )

  const sheet = (
    <AttachmentPreviewSheet
      open={previewId !== null}
      onOpenChange={(next) => {
        if (!next) setPreviewId(null)
      }}
      target={target}
      state={previewId ? staged.byId.get(previewId) : undefined}
      onRunOcr={props.onRunOcr}
      ocrBusy={props.ocrBusy}
      onViewOcrDetail={props.onViewOcrDetail}
      onExtractOcrToInput={props.onExtractOcrToInput}
      onToggleIncludeOcr={staged.toggleIncludeOcr}
    />
  )

  // `<Attachments>` is required in BOTH modes: it is what publishes
  // `variant: "inline"` to the primitives below it. Without it they fall back to
  // the context default of `"grid"`, which renders 96px squares and drops the
  // filename entirely (`AttachmentInfo` returns null for grid). In bare mode it
  // is `display: contents` so the chips still participate in the parent bar's
  // flex flow rather than forming a nested row.
  //
  // `has-[>*]:pt-2` rather than a conditional return: the padding only applies
  // while a chip is actually mounted, so an empty (or fully exited) row
  // collapses to a true zero height without unmounting the presence boundary
  // that the exit animation needs.
  return (
    <>
      <Attachments variant="inline" className={props.bare ? "contents" : "px-2 has-[>*]:pt-2"}>
        {chips}
      </Attachments>
      {sheet}
    </>
  )
}

type ChipTranslator = ReturnType<typeof useTranslations<"chat.composer.attachments">>

/**
 * One draggable chip. The dnd-kit transform goes on an inner wrapper so it never
 * collides with the framer `layout` transform on the outer motion element.
 */
function SortableChip({
  file,
  state,
  animateLayout,
  transition,
  onOpenPreview,
  onRemove,
  t,
}: {
  file: AttachmentData
  state: StagedAttachmentState | undefined
  animateLayout: boolean
  transition: ReturnType<typeof useReducedMotionTransition>
  onOpenPreview: () => void
  onRemove: () => void
  t: ChipTranslator
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition: dndTransition,
    isDragging,
  } = useSortable({ id: file.id })
  const displayName = ("filename" in file ? file.filename : undefined) ?? t("fallbackName")

  return (
    <motion.div
      layout={animateLayout}
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={transition}
    >
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition: dndTransition }}
        className={cn("touch-none", isDragging && "z-10 opacity-80")}
        aria-label={t("reorderAria", { filename: displayName })}
        {...attributes}
        {...listeners}
      >
        <Attachment
          data={file}
          onRemove={onRemove}
          className={cn(state?.status === "rejected" && "border-destructive/60 bg-destructive/5")}
          data-testid="composer-attachment-chip"
        >
          <button
            type="button"
            aria-label={t("openPreviewAria", { filename: displayName })}
            onClick={onOpenPreview}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <AttachmentMediaPreview />
            <AttachmentInfo />
          </button>
          <StatusBadge state={state} t={t} />
          <AttachmentRemove
            label={t("removeAria", { filename: displayName })}
            // Always visible: these chips have room for it in the flex flow, and
            // touch devices have no hover to reveal an opacity-0 button.
            className="opacity-60 transition-opacity hover:opacity-100"
          />
        </Attachment>
      </div>
    </motion.div>
  )
}

/** Extraction state as a compact trailing badge: spinner → token count → error. */
function StatusBadge({
  state,
  t,
}: {
  state: StagedAttachmentState | undefined
  t: ChipTranslator
}) {
  if (!state || state.status === "extracting") {
    return (
      <span
        className="shrink-0 text-muted-foreground"
        title={t("extracting")}
        data-testid="attachment-extracting"
      >
        <Loader2Icon className="size-3 animate-spin" aria-label={t("extracting")} />
      </span>
    )
  }
  if (state.status === "rejected") {
    const reason = state.extracted?.rejectReason
    const label = reason ? t(`rejectReason.${REJECT_KEY[reason]}` as never) : ""
    return (
      <span
        className="flex shrink-0 items-center text-destructive"
        title={label}
        data-testid="attachment-rejected"
      >
        <AlertTriangleIcon className="size-3" aria-label={label} />
      </span>
    )
  }
  const tokens = state.extracted?.tokens ?? 0
  if (tokens <= 0) return null
  return (
    <span
      className="shrink-0 tabular-nums text-[10px] text-muted-foreground"
      data-testid="attachment-tokens"
    >
      {t("tokenBadge", { tokens })}
    </span>
  )
}
