/**
 * A turn's images in the form an external agent's prompt carries them.
 *
 * The turn's `SendContent` already holds every image the agent could be shown:
 * attached images (downscaled at staging) and the frames or storyboard sampled
 * from an attached video. They become `ExternalAgentImageContent` here, in a
 * raster format agents read; a BMP, TIFF or HEIC is re-encoded as PNG, and one
 * this runtime cannot decode is reported rather than sent to be refused.
 *
 * What the agent and its model can actually see is decided after this, by
 * `ExternalAgentManager.resolvePromptAttachments` (on the Host, for a Host
 * lane).
 */

import type { SendContentBlock } from "@cognia/agent-config-types"
import {
  bytesToBase64,
  decodeDataUrl,
  isPortableImageType,
  toPortableImage,
} from "@/lib/ocr/image-prep"
import type {
  ExternalAgentImageContent,
  ExternalAgentImageWithheldReason,
  ExternalAgentPromptAttachmentResolution,
} from "@/types/agent/external-agent"

/** One image block of a turn, with the attachment it came from. */
export interface ExternalTurnImage {
  block: Extract<SendContentBlock, { type: "image" }>
  /** Manifest index of its attachment; `null` for an image no manifest names. */
  attachment: number | null
}

export interface PreparedTurnImage {
  content: ExternalAgentImageContent
  attachment: number | null
}

export interface PreparedTurnImages {
  /** Ready to offer the agent, in turn order. */
  ready: PreparedTurnImage[]
  /** In a format no agent reads that this runtime could not convert. */
  unreadable: ExternalTurnImage[]
}

function imageContent(data: string, mediaType: string): ExternalAgentImageContent {
  return { type: "image", source: { type: "base64", data, mediaType } }
}

export async function prepareExternalTurnImages(
  images: readonly ExternalTurnImage[]
): Promise<PreparedTurnImages> {
  const ready: PreparedTurnImage[] = []
  const unreadable: ExternalTurnImage[] = []
  for (const image of images) {
    const { media_type: mediaType, data } = image.block.source
    if (isPortableImageType(mediaType)) {
      // Already a format agents read: the bytes go as they are, under the
      // type's canonical name.
      const canonical = mediaType.toLowerCase() === "image/jpg" ? "image/jpeg" : mediaType
      ready.push({ content: imageContent(data, canonical), attachment: image.attachment })
      continue
    }
    const decoded = decodeDataUrl(`data:${mediaType};base64,${data}`)
    const portable = decoded ? await toPortableImage(decoded.bytes, mediaType) : null
    if (!portable) {
      unreadable.push(image)
      continue
    }
    ready.push({
      content: imageContent(bytesToBase64(portable.bytes), portable.mimeType),
      attachment: image.attachment,
    })
  }
  return { ready, unreadable }
}

/**
 * Why some of a turn's images did not reach the agent, by attachment.
 *
 * Beside the agent's own two reasons (`agent`, `model`), three belong to the
 * route: `format` (no portable form, see above), `host` (the paired Host
 * predates image delivery) and `upload` (the bytes could not be staged on it).
 */
export type TurnImageWithheldReason =
  ExternalAgentImageWithheldReason | "format" | "host" | "upload"

export interface TurnImagesWithheld {
  reason: TurnImageWithheldReason
  /** The attachments the withheld images came from (`null`: unnamed). */
  attachments: Array<number | null>
  /** The model with no vision, for `model`. */
  model?: string
}

/**
 * Every group of images a turn did not deliver: the unconvertible ones, and
 * whatever the agent's verdict (or the route) held back of the rest. The
 * verdict is all or nothing, so a withheld verdict covers every ready image.
 */
export function withheldTurnImages(
  prepared: PreparedTurnImages,
  verdict:
    | ExternalAgentPromptAttachmentResolution["withheld"]
    | { reason: TurnImageWithheldReason; model?: string }
    | null
): TurnImagesWithheld[] {
  const groups: TurnImagesWithheld[] = []
  if (prepared.unreadable.length > 0) {
    groups.push({
      reason: "format",
      attachments: prepared.unreadable.map((image) => image.attachment),
    })
  }
  if (verdict && prepared.ready.length > 0) {
    groups.push({
      reason: verdict.reason,
      attachments: prepared.ready.map((image) => image.attachment),
      ...(verdict.model ? { model: verdict.model } : {}),
    })
  }
  return groups
}
