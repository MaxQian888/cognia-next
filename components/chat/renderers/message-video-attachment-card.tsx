"use client"

/**
 * A sent video or animated GIF, as the transcript keeps it (decision D7).
 *
 * The original file is never stored. What a message row holds is what the
 * model received — a storyboard, separate frames, or, for an original video,
 * the poster that stands in for it — plus the one-line description, every part
 * tagged with the same {@link VideoAttachmentInfo}. This card folds those parts
 * back into the one attachment the user sent, and says plainly that the file
 * itself is gone, so nobody goes looking for a play button.
 */

import { useTranslations } from "next-intl"
import { FileVideoIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  videoAttachmentInfoOfPart,
  type VideoAttachmentInfo,
} from "@/lib/chat/attachments/video/attachment-info"
import {
  FRACTIONAL_TIMESTAMP_BELOW_SEC,
  formatVideoTimestamp,
} from "@/lib/chat/attachments/video/timeline"
import { MessageImageGallery } from "./message-image-gallery"
import type { ImageLightboxItem } from "./image-lightbox"

export interface MessageVideoAttachment {
  info: VideoAttachmentInfo
  /** Index of the attachment's first part: where the card renders. */
  firstPartIndex: number
  /** The storyboard, frames or poster, in part order. */
  images: Array<{ partIndex: number; url: string; mediaType: string }>
}

export interface MessageVideoAttachments {
  attachments: MessageVideoAttachment[]
  /** Every part index a card covers, so the renderer can skip them. */
  partIndexes: ReadonlySet<number>
  /** The card that renders at a part index, if any renders there. */
  byFirstPartIndex: ReadonlyMap<number, MessageVideoAttachment>
}

/**
 * Group a message's parts into video attachments by their descriptor's
 * `groupId`. The first descriptor seen for a group wins; a part whose
 * descriptor does not parse is left to render as the ordinary part it is.
 */
export function collectMessageVideoAttachments(parts: readonly unknown[]): MessageVideoAttachments {
  const byGroup = new Map<string, MessageVideoAttachment>()
  const partIndexes = new Set<number>()
  parts.forEach((part, index) => {
    const info = videoAttachmentInfoOfPart(part)
    if (!info) return
    partIndexes.add(index)
    let attachment = byGroup.get(info.groupId)
    if (!attachment) {
      attachment = { info, firstPartIndex: index, images: [] }
      byGroup.set(info.groupId, attachment)
    }
    const file = part as { type?: unknown; url?: unknown; mediaType?: unknown }
    if (
      file.type === "file" &&
      typeof file.url === "string" &&
      file.url &&
      typeof file.mediaType === "string" &&
      file.mediaType.startsWith("image/")
    ) {
      attachment.images.push({ partIndex: index, url: file.url, mediaType: file.mediaType })
    }
  })
  const attachments = [...byGroup.values()]
  return {
    attachments,
    partIndexes,
    byFirstPartIndex: new Map(attachments.map((a) => [a.firstPartIndex, a])),
  }
}

export interface MessageVideoAttachmentCardProps {
  attachment: MessageVideoAttachment
  /** Prefix for the gallery item ids; the message id keeps them unique. */
  idPrefix: string
}

export function MessageVideoAttachmentCard({
  attachment,
  idPrefix,
}: MessageVideoAttachmentCardProps) {
  const t = useTranslations("chat.message.videoCard")
  const { info, images } = attachment
  const fractional = info.durationSec < FRACTIONAL_TIMESTAMP_BELOW_SEC
  const at = (seconds: number) => formatVideoTimestamp(seconds, fractional)
  const strategy = info.strategy === "scene" ? t("strategyScene") : t("strategyUniform")
  const count = info.frameTimes.length

  const summary =
    info.delivery === "native"
      ? t("summaryNative")
      : info.delivery === "storyboard"
        ? t("summaryStoryboard", { count, strategy })
        : t("summaryFrames", { count, strategy })

  const items: ImageLightboxItem[] = images.map((image, i) => ({
    id: `${idPrefix}-video-${image.partIndex}`,
    src: image.url,
    // Frames carry their own time; a storyboard or poster is the clip itself.
    alt:
      info.delivery === "frames" && info.frameTimes[i] !== undefined
        ? `${info.filename} · ${at(info.frameTimes[i]!)}`
        : info.filename,
    filename: info.filename,
  }))

  return (
    <figure
      className="w-full max-w-md space-y-2 rounded-lg border bg-card p-2.5"
      data-testid="message-video-attachment"
    >
      <figcaption className="space-y-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <FileVideoIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate text-sm font-medium" title={info.filename}>
            {info.filename}
          </span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {info.kind === "gif" ? t("gif") : t("video")}
          </Badge>
        </div>
        <p className="text-xs tabular-nums text-muted-foreground">
          {[
            at(info.durationSec),
            `${info.width}×${info.height}`,
            summary,
            info.range
              ? t("range", { start: at(info.range.startSec), end: at(info.range.endSec) })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </figcaption>
      {items.length > 0 ? (
        // Frames are a contact sheet, not photos: three to a row keeps a
        // nine-frame message from standing taller than the conversation.
        <MessageImageGallery
          items={items}
          className={items.length > 2 ? "grid-cols-3 gap-1" : undefined}
        />
      ) : null}
      <p className="text-[11px] text-muted-foreground">{t("notStored")}</p>
    </figure>
  )
}
