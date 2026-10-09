"use client"

/**
 * Staged-attachment tiles, inside the composer card's first row.
 *
 * Uniform 112×80 landscape tiles on the vendored `ai-elements/attachments`
 * `grid` variant: media shows a real cover thumbnail (`AttachmentPreview` fills the
 * tile; a video shows its sampled poster, not the source `<video>` — a 500 MB
 * file does not need a second decoder for a thumbnail), and documents get a
 * same-footprint icon tile with a middle-truncated filename so the extension
 * always survives (Finder convention).
 *
 * Click routing follows the attachment type:
 *   - image           → `ImageLightbox` over every staged image (the model
 *                       audit stays reachable from its "Model view" action,
 *                       which swaps into the preview dialog's model tab)
 *   - video / document / rejected → `AttachmentPreviewDialog` (file tab),
 *                       which also carries OCR, redaction and video-sampling
 *                       controls on the model tab
 *
 * While a tile is in flight (`extracting`, or before its staged entry exists)
 * its content dims and a type-specific cue rides on top: a scan sweep for
 * images, a real progress bar + hidden play badge for videos, a spinner badge
 * for documents. Rejection flips the border to destructive.
 *
 * `<AnimatePresence>` is mounted UNCONDITIONALLY — above any "no attachments"
 * early return. Returning null first would unmount the presence boundary along
 * with the tile that is trying to leave, so removing the LAST attachment popped
 * instead of animating out while removing any other one animated correctly.
 */

import { useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  AlertTriangleIcon,
  FileTextIcon,
  FileVideoIcon,
  GlobeIcon,
  Loader2Icon,
  Music2Icon,
  PaperclipIcon,
  PlayIcon,
  ScanTextIcon,
} from "lucide-react"
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
  AttachmentPreview as AttachmentMediaPreview,
  AttachmentRemove,
  Attachments,
  getMediaCategory,
  type AttachmentData,
  type AttachmentMediaCategory,
} from "@/components/ai-elements/attachments"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { AnalyzingImage } from "@/components/loading-ui/analyzing-image"
import { ImageLightbox, type ImageLightboxItem } from "@/components/chat/renderers/image-lightbox"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { applyOrder, resolveDragEnd } from "@/lib/chat/attachments/reorder"
import type { RejectReason } from "@/lib/chat/attachments/dispatch"
import { isVideoDescriptor } from "@/lib/chat/attachments/video/classify"
import type { NativeVideoVerdict } from "@/lib/chat/attachments/video/delivery-gate"
import { formatBytesCompact } from "@/lib/observability/format-utils"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import { cn } from "@/lib/utils"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { useStagedAttachments, type StagedAttachmentState } from "./staged-attachment-store"
import { AttachmentPreviewDialog, type PreviewTarget } from "./attachment-preview-dialog"
import type { ComposerImageInput } from "./hooks/use-composer-image-input"
import { ImageInputNotice } from "./image-input-notice"

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
   * When true, render only the tiles (no padded container) so a parent bar can
   * lay attachments and references out in a single flex flow.
   */
  bare?: boolean
  /**
   * Whether this conversation could take an original video file, as the
   * composer predicts it (`useComposerVideoRoute`). Drives the preview panel's
   * delivery options; the send path re-checks the resolved route.
   */
  videoRoute: NativeVideoVerdict
  /**
   * Whether staged images and video will reach the model
   * (`useComposerImageInput`). When they will not, the row says so beside the
   * tiles, before the send. Absent means "they will", as before.
   */
  imageInput?: ComposerImageInput
  /**
   * Includes the text of these image attachments with the message: the
   * notice's remedy when the recipient cannot see them.
   */
  onExtractImageText?: (attachmentIds: readonly string[]) => Promise<void>
}

/** i18n key suffix for a machine-readable rejection reason. */
const REJECT_KEY: Record<RejectReason, string> = {
  "not-data-url": "notDataUrl",
  "unsupported-type": "unsupportedType",
  empty: "empty",
  "parse-failed": "parseFailed",
  "video-undecodable": "videoUndecodable",
  "video-too-large": "videoTooLarge",
  "video-unprocessed": "videoUnprocessed",
  "audio-unprocessed": "audioUnprocessed",
}

const FILE_TILE_ICONS: Partial<Record<AttachmentMediaCategory, typeof FileTextIcon>> = {
  audio: Music2Icon,
  document: FileTextIcon,
  source: GlobeIcon,
  unknown: PaperclipIcon,
}

export function AttachmentPreview(props: AttachmentPreviewProps) {
  const t = useTranslations("chat.composer.attachments")
  const attachments = usePromptInputAttachments()
  const staged = useStagedAttachments()
  const transition = useReducedMotionTransition(mobileTransition("fast"))
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewTab, setPreviewTab] = useState<"file" | "model">("file")
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const tileTriggerRef = useRef<HTMLElement | null>(null)

  // Tiles follow the user's drag order, not insertion order — and so does the
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

  // The lightbox only walks images — a video blob can't render in an <img>,
  // and documents have nothing to zoom. Videos and files keep the dialog.
  const imageItems: ImageLightboxItem[] = useMemo(
    () =>
      ordered
        .filter(
          (f) =>
            f.url &&
            (f.mediaType ?? "").startsWith("image/") &&
            !isVideoDescriptor({
              name: ("filename" in f ? f.filename : undefined) ?? "",
              mediaType: f.mediaType ?? "",
            })
        )
        .map((f) => ({
          id: f.id,
          src: f.url!,
          filename: "filename" in f ? f.filename : undefined,
          alt: ("filename" in f ? f.filename : undefined) ?? t("fallbackName"),
        })),
    [ordered, t]
  )

  const openModelView = (attachmentId: string) => {
    setPreviewTab("model")
    setPreviewId(attachmentId)
    setLightboxIndex(null)
  }

  // `distance: 4` is what lets a tile be both draggable and clickable: a press
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
      // dnd-kit's screen-reader nodes (`DndDescribedBy`, `DndLiveRegion`) are
      // the one part of `DndContext` that is NOT DOM-free: rendered inline they
      // land in the bare chip flow, so its `:empty` never matched and every
      // composer carried a dead padded row above the input. Portaling them to
      // `body` keeps the flow honest; they mount only after hydration anyway.
      accessibility={{
        container: typeof document === "undefined" ? undefined : document.body,
      }}
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
              triggerRef={tileTriggerRef}
              onOpenPreview={() => {
                // Rejected attachments always go to the dialog — that's where
                // the reason lives. Healthy images go fullscreen.
                const rejected = staged.byId.get(f.id)?.status === "rejected"
                const imageIndex = rejected ? -1 : imageItems.findIndex((i) => i.id === f.id)
                if (imageIndex >= 0) {
                  setLightboxIndex(imageIndex)
                } else {
                  setPreviewTab("file")
                  setPreviewId(f.id)
                }
              }}
              onRemove={() => attachments.remove(f.id)}
              t={t}
            />
          ))}
        </AnimatePresence>
      </SortableContext>
    </DndContext>
  )

  const activeImage = lightboxIndex !== null ? imageItems[lightboxIndex] : undefined

  // Images and video are what a recipient that cannot see images misses;
  // documents still reach it as text. On an external agent's lane a video
  // travels as sampled frames, which are images, so it counts there; on the
  // built-in lane a model without vision still takes a video through its own
  // route (see `videoRoute`), so only images count.
  const imageInput = props.imageInput
  const agentLane =
    imageInput?.accepted === false &&
    (imageInput.reason !== "model-no-vision" || imageInput.agentName !== null)
  const visualItems = ordered.filter((f) => {
    const mediaType = f.mediaType ?? ""
    const video =
      mediaType.startsWith("video/") ||
      isVideoDescriptor({ name: ("filename" in f ? f.filename : undefined) ?? "", mediaType })
    if (video) return agentLane
    return mediaType.startsWith("image/")
  })
  const imageIds = visualItems
    .filter((f) => (f.mediaType ?? "").startsWith("image/"))
    .map((f) => f.id)
  const imagesWithoutText = imageIds.filter((id) => {
    const state = staged.byId.get(id)
    return !(state?.includeOcr && state.ocrText)
  })
  // A pill in the same flow as the tiles: it describes them, so it sits with
  // them, and it leaves with the last image.
  const notice =
    imageInput && !imageInput.accepted && visualItems.length > 0 ? (
      <ImageInputNotice
        verdict={imageInput}
        count={visualItems.length}
        imageCount={imageIds.length}
        imagesWithoutText={imagesWithoutText}
        onExtractImageText={props.onExtractImageText}
      />
    ) : null

  const overlays = (
    <>
      <ImageLightbox
        items={imageItems}
        open={lightboxIndex !== null}
        activeIndex={lightboxIndex ?? 0}
        returnFocusRef={tileTriggerRef}
        onActiveIndexChange={setLightboxIndex}
        onOpenChange={(open) => {
          if (!open) setLightboxIndex(null)
        }}
        headerActions={
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="size-8 text-white hover:bg-white/15 hover:text-white"
            onClick={() => activeImage && openModelView(activeImage.id)}
            aria-label={t("preview.modelTab")}
            tooltip={t("preview.modelTab")}
          >
            <ScanTextIcon className="size-4" />
          </TooltipIconButton>
        }
      />
      <AttachmentPreviewDialog
        open={previewId !== null}
        onOpenChange={(next) => {
          if (!next) setPreviewId(null)
        }}
        target={target}
        initialTab={previewTab}
        state={previewId ? staged.byId.get(previewId) : undefined}
        onRunOcr={props.onRunOcr}
        ocrBusy={props.ocrBusy}
        onViewOcrDetail={props.onViewOcrDetail}
        onExtractOcrToInput={props.onExtractOcrToInput}
        onToggleIncludeOcr={staged.toggleIncludeOcr}
        videoRoute={props.videoRoute}
        onApplyVideoSettings={staged.applyVideoSettings}
        onProcessMedia={staged.processMedia}
        onCancelProcessing={staged.cancelProcessing}
        onRetry={staged.retry}
      />
    </>
  )

  // Bare mode renders NO container at all: `DndContext`, `SortableContext` and
  // `AnimatePresence` are all DOM-free, so the tiles land as direct children of
  // the context row's flow — which keeps that flow's `:empty` / `:has(>*)`
  // checks honest (a `display: contents` wrapper still counts as an element
  // child and would defeat them). `Attachment` still resolves `variant: "grid"`
  // — that is the context default, the wrapper only re-published it. The
  // non-bare path keeps `<Attachments>` for its own padded row.
  return (
    <>
      {props.bare ? (
        <>
          {chips}
          {notice}
        </>
      ) : (
        <Attachments variant="grid" className="ml-0 w-full px-2 has-[>*]:pt-2">
          {chips}
          {notice}
        </Attachments>
      )}
      {overlays}
    </>
  )
}

type ChipTranslator = ReturnType<typeof useTranslations<"chat.composer.attachments">>

/**
 * One draggable tile. The dnd-kit transform goes on an inner wrapper so it
 * never collides with the framer `layout` transform on the outer motion
 * element.
 */
function SortableChip({
  file,
  state,
  animateLayout,
  transition,
  triggerRef,
  onOpenPreview,
  onRemove,
  t,
}: {
  file: AttachmentData
  state: StagedAttachmentState | undefined
  animateLayout: boolean
  transition: ReturnType<typeof useReducedMotionTransition>
  triggerRef: React.RefObject<HTMLElement | null>
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
  const isVideo = isVideoDescriptor({
    name: ("filename" in file ? file.filename : undefined) ?? "",
    mediaType: file.mediaType ?? "",
  })
  const isImage = (file.mediaType ?? "").startsWith("image/") && !isVideo
  // Documents read as a file card (type badge, name, size and cost on one
  // line); images and videos keep their thumbnail with an overlaid badge.
  const isDocument = !isImage && !isVideo
  // A tile is "in flight" before its staged entry exists and while it is being
  // extracted — the visuals dim and the type-specific progress cue rides on top.
  const extracting = !state || state.status === "extracting"

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
          className={cn(
            "rounded-xl border transition-colors",
            isDocument ? "bg-card shadow-xs hover:border-foreground/20" : "bg-muted/40",
            state?.status === "rejected" && "border-destructive/60 bg-destructive/5"
          )}
          // One row height for every tile. Media is a landscape thumb (112×80,
          // smaller than the grid's square); a document is a wider card so its
          // name, size and cost read on their own lines instead of being
          // stacked into a thumbnail's footprint. Inline style wins over the
          // variant's `size-24`.
          style={
            isDocument ? { width: "13.5rem", height: "5rem" } : { width: "7rem", height: "5rem" }
          }
          data-testid="composer-attachment-chip"
        >
          <button
            type="button"
            aria-label={t("openPreviewAria", { filename: displayName })}
            onClick={(e) => {
              triggerRef.current = e.currentTarget
              onOpenPreview()
            }}
            className={cn(
              "block size-full cursor-pointer overflow-hidden rounded-[inherit] text-left outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring/70",
              extracting && "opacity-70"
            )}
          >
            {isVideo ? (
              <VideoTile poster={state?.video?.result?.poster} processing={extracting} />
            ) : isImage ? (
              <AttachmentMediaPreview className="size-full" />
            ) : (
              <FileTileContent
                name={displayName}
                category={getMediaCategory(file)}
                sizeLabel={
                  state && state.sizeBytes > 0 ? formatBytesCompact(state.sizeBytes) : undefined
                }
                status={<StatusBadge state={state} isImage={false} t={t} />}
              />
            )}
          </button>
          {/* In-flight cues ride above the dimmed content, below the badges. */}
          {extracting && isImage ? <ScanSweep /> : null}
          {extracting && isVideo ? <VideoProgressBar fraction={state?.video?.progress} /> : null}
          {isDocument ? null : (
            <div className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-12px)] items-center rounded-full bg-background/90 px-1.5 py-0.5 shadow-xs ring-1 ring-border/60 backdrop-blur-sm empty:hidden">
              <StatusBadge state={state} isImage={isImage} t={t} />
            </div>
          )}
          <AttachmentRemove
            label={t("removeAria", { filename: displayName })}
            // Visible without hover, like the old chips: touch devices have no
            // hover to reveal an opacity-0 button with.
            className="top-1.5 right-1.5 size-5 bg-background/90 opacity-80 shadow-xs ring-1 ring-border/60 transition-opacity hover:opacity-100 [&>svg]:size-2.5"
          />
        </Attachment>
      </div>
    </motion.div>
  )
}

/** Poster + play badge — the video tile never mounts the source `<video>`. */
function VideoTile({
  poster,
  processing,
}: {
  poster?: { mediaType: string; base64: string }
  /** While sampling runs there is nothing to play yet — the badge would lie. */
  processing?: boolean
}) {
  return (
    <span className="relative block size-full" data-testid="attachment-video-thumb">
      {poster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`data:${poster.mediaType};base64,${poster.base64}`}
          alt=""
          className="size-full object-cover"
        />
      ) : (
        <span className="flex size-full items-center justify-center bg-muted">
          <FileVideoIcon className="size-5 text-muted-foreground" aria-hidden />
        </span>
      )}
      {!processing ? (
        <span
          className="absolute inset-0 flex items-center justify-center"
          aria-hidden
          data-testid="attachment-play-badge"
        >
          <PlayIcon className="size-7 rounded-full bg-black/55 p-1.5 text-white" />
        </span>
      ) : null}
    </span>
  )
}

/**
 * A shine band sweeping the tile — the "analyzing" idea from the status badge
 * scaled up to tile size. Reduced motion gets the dim alone; the badge still
 * announces the wait to screen readers.
 */
function ScanSweep() {
  const reduce = useReducedMotion()
  if (reduce) return null
  return (
    <span
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden
      data-testid="attachment-scan-sweep"
    >
      <motion.span
        className="absolute inset-x-0 h-9 bg-gradient-to-b from-transparent via-white/25 to-transparent dark:via-white/15"
        animate={{ y: ["-150%", "380%"] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
      />
    </span>
  )
}

/** Real sampling progress as a bottom-edge bar — Telegram-style. */
function VideoProgressBar({ fraction }: { fraction?: number }) {
  return (
    <span
      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground/15"
      aria-hidden
      data-testid="attachment-video-progress-bar"
    >
      <span
        className="block h-full bg-primary transition-[width] duration-300 ease-out"
        style={{ width: `${Math.min(100, Math.max(0, Math.round((fraction ?? 0) * 100)))}%` }}
      />
    </span>
  )
}

/**
 * Document card — the media tiles' height, wider, laid out like a file: a type
 * badge (the app's own file-type glyph and colour, with the extension spelled
 * out under it), the name on one line, and a meta line with its size and what
 * it costs the model (or that it is still being read). The name
 * middle-truncates: the stem ellipsis-collapses but the extension always
 * survives (the ".pd / f" mid-word break is what this replaces).
 */
function FileTileContent({
  name,
  category,
  sizeLabel,
  status,
}: {
  name: string
  category: AttachmentMediaCategory
  sizeLabel?: string
  /** The extraction state: a spinner, the token cost, or a rejection. */
  status?: React.ReactNode
}) {
  const dot = name.lastIndexOf(".")
  // Only a short tail counts as an extension — "archive.2026.notes" has a dot
  // but ".notes" is not the interesting part to pin.
  const hasExt = dot > 0 && name.length - dot <= 6
  const Fallback = FILE_TILE_ICONS[category] ?? PaperclipIcon
  return (
    <span className="flex size-full items-center gap-2.5 pr-8 pl-2.5">
      <span
        className="flex size-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border bg-background"
        aria-hidden
      >
        {category === "source" ? (
          <Fallback className="size-[18px] text-muted-foreground" />
        ) : (
          <FileTypeIcon path={name} className="size-[18px]" />
        )}
        {hasExt ? (
          <span className="max-w-full truncate px-0.5 text-[8.5px] leading-none font-semibold tracking-wide text-muted-foreground uppercase">
            {name.slice(dot + 1)}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-baseline text-xs leading-snug font-medium">
          <span className="truncate">{hasExt ? name.slice(0, dot) : name}</span>
          {hasExt ? (
            <span className="shrink-0 font-normal text-muted-foreground">{name.slice(dot)}</span>
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-[10.5px] leading-none text-muted-foreground tabular-nums">
          {sizeLabel ? <span className="shrink-0">{sizeLabel}</span> : null}
          {sizeLabel && status ? (
            <span aria-hidden className="text-muted-foreground/60 [&:last-child]:hidden">
              ·
            </span>
          ) : null}
          {status}
        </span>
      </span>
    </span>
  )
}

/**
 * What a sampled video will be sent as, e.g. "9 frames", once its run lands.
 * `native` only when the original file was actually prepared: a failed
 * preparation sends the storyboard, so the tile says so.
 */
function videoChipLabel(state: StagedAttachmentState, t: ChipTranslator): string | null {
  const result = state.video?.result
  if (!result) return null
  if (result.settings.delivery === "native" && result.native) return t("video.chipNative")
  const count = result.sampled.frames.length
  return result.sampled.delivery === "frames"
    ? t("video.chipFrames", { count })
    : t("video.chipStoryboard", { count })
}

/** Extraction state as a compact overlay badge: spinner → token count → error. */
function StatusBadge({
  state,
  isImage,
  t,
}: {
  state: StagedAttachmentState | undefined
  isImage: boolean
  t: ChipTranslator
}) {
  if (state?.status === "extracting" && state.video) {
    // A motion run reports how far it got; a spinner would hide a long seek.
    const percent = Math.round((state.video.progress ?? 0) * 100)
    return (
      <span
        className="flex items-center gap-1 tabular-nums text-[10px] text-muted-foreground"
        title={t("video.processing")}
        data-testid="attachment-video-progress"
      >
        <Loader2Icon className="size-3 animate-spin" aria-hidden />
        {t("video.chipProgress", { percent })}
      </span>
    )
  }
  if (!state || state.status === "extracting") {
    // An image's wait is a different wait: the blob is re-read, decoded and
    // downscaled rather than parsed for text, and it is the slowest of the two
    // by far. A generic spinner said nothing about that; the scan animation
    // names the work while it happens. Documents keep the spinner — the photo
    // glyph would be a lie on a PDF.
    if (isImage) {
      return (
        <AnalyzingImage
          label={t("analyzing")}
          title={t("analyzing")}
          className="size-4 text-muted-foreground"
          data-testid="attachment-analyzing-image"
        />
      )
    }
    return (
      <span
        className="text-muted-foreground"
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
        className="flex items-center text-destructive"
        title={label}
        data-testid="attachment-rejected"
      >
        <AlertTriangleIcon className="size-3" aria-label={label} />
      </span>
    )
  }
  // A video's text tokens are its one-line description; the frames' image
  // cost is estimated in the panel. The tile says what goes out instead.
  const videoLabel = videoChipLabel(state, t)
  if (videoLabel) {
    return (
      <span
        className="tabular-nums text-[10px] text-muted-foreground"
        data-testid="attachment-video-summary"
      >
        {videoLabel}
      </span>
    )
  }
  const tokens = state.extracted?.tokens ?? 0
  if (tokens <= 0) return null
  return (
    <span
      className="tabular-nums text-[10px] text-muted-foreground"
      data-testid="attachment-tokens"
    >
      {t("tokenBadge", { tokens })}
    </span>
  )
}
