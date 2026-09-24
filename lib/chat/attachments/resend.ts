/**
 * A sent user turn, rebuilt from its transcript row so it can be sent again.
 *
 * `makeUserMessage` (`lib/claude/adapter.ts`) turns every attachment block into
 * a `file` part. An extracted document, an audio transcript or an image's OCR
 * keeps its text. An image keeps its bytes: a data URL, or a `cognia-media:`
 * reference once the row is stored. Every part a video produced carries the
 * video's descriptor. That is the payload the model read, so an edit (the same
 * files under a new question) and a regenerate (the same turn again) resend it
 * from the row, as other chat apps keep a message's files when it is edited,
 * instead of dropping the files and sending the text alone.
 *
 * Some files cannot be resent. A natively sent video left only its poster and
 * description in the row, never the file. An image whose stored bytes are gone
 * has nothing to send. Those come back in `unavailable` by filename, for the
 * caller to tell the user, rather than being sent as something they were not.
 */

import type { UIMessage } from "ai"
import type { SendContent, SendContentBlock } from "@cognia/agent-config-types"
import { readAttachmentExtractedContent } from "@cognia/agent-config-types/attachment"
import { isMediaRef } from "@/lib/db/message-media"
import { materializeMessageMedia } from "@/lib/chat/media/normalize-message-media"
import type { AttachmentManifestEntry } from "./dispatch"
import { videoAttachmentInfoOfPart } from "./video/attachment-info"

export interface ResendableAttachments {
  /** The turn's attachment blocks, in the order it sent them. */
  blocks: SendContentBlock[]
  /** Parallel to `blocks`, as `buildSendContent` returns it. */
  manifest: AttachmentManifestEntry[]
  /** Files the row cannot send again, by filename, each once. */
  unavailable: string[]
}

export interface ResendableUserTurn {
  /** The whole turn: its attachments first, then its text parts in order. */
  content: SendContent
  manifest: AttachmentManifestEntry[]
  unavailable: string[]
}

interface RowPart {
  type?: unknown
  text?: unknown
  url?: unknown
  mediaType?: unknown
  filename?: unknown
  extractedContent?: unknown
}

/** One attached file: every block it produced share one manifest entry. */
interface Source {
  entry: AttachmentManifestEntry
  /** `null` marks a block the row cannot rebuild, which leaves the file out. */
  blocks: Array<SendContentBlock | null>
  /** A natively sent video: the file was sent, never stored. */
  native?: boolean
}

const DATA_URL = /^data:([^;,]+);base64,(.+)$/s

/** An image part's bytes as a base64 image source, or null when there are none to send. */
async function imageSource(
  url: string
): Promise<{ type: "base64"; media_type: string; data: string } | null> {
  let dataUrl = url
  if (isMediaRef(url)) {
    // The same read an exported message uses: the canonical bytes, which are
    // what the model was sent, and a refusal when only a thumbnail is left.
    try {
      const probe = { id: "resend", role: "user", parts: [{ type: "file", url }] } as UIMessage
      const [part] = (await materializeMessageMedia(probe)).parts
      dataUrl = String((part as RowPart).url ?? "")
    } catch {
      return null
    }
  }
  const match = DATA_URL.exec(dataUrl)
  if (!match || !match[1].startsWith("image/")) return null
  return { type: "base64", media_type: match[1], data: match[2] }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * The attachments a user row sent, ready to send again.
 *
 * Every `file` part of a user row is an attachment: the composer's own text and
 * fetched link context are `text` parts. They are returned in row order, which
 * is the order `buildSendContent` put them in, ahead of the typed text.
 */
export async function resendableAttachments(
  parts: readonly unknown[]
): Promise<ResendableAttachments> {
  const sources: Source[] = []
  const videos = new Map<string, Source>()

  for (const raw of parts) {
    const part = (raw ?? {}) as RowPart
    const video = videoAttachmentInfoOfPart(part)
    if (video) {
      let source = videos.get(video.groupId)
      if (!source) {
        source = {
          entry: {
            filename: video.filename,
            mediaType: video.sourceMediaType,
            kind: "video",
            video: { info: video },
          },
          blocks: [],
          // Its poster and description are not what the model read.
          native: video.delivery === "native",
        }
        videos.set(video.groupId, source)
        sources.push(source)
      }
      const extraction = readAttachmentExtractedContent(part.extractedContent)
      if (extraction && !source.entry.extractedContent) source.entry.extractedContent = extraction
      const text = stringOf(part.text)
      const url = stringOf(part.url)
      if (text !== undefined && url === undefined) source.blocks.push({ type: "text", text })
      else if (url !== undefined) {
        const image = await imageSource(url)
        source.blocks.push(image ? { type: "image", source: image } : null)
      }
      continue
    }
    if (part.type !== "file") continue

    const filename = stringOf(part.filename) || "attachment"
    const mediaType = stringOf(part.mediaType) ?? ""
    const extraction = readAttachmentExtractedContent(part.extractedContent)
    const url = stringOf(part.url)
    const text = stringOf(part.text)
    if (url !== undefined) {
      const image = await imageSource(url)
      sources.push({
        entry: {
          filename,
          mediaType: image?.media_type ?? mediaType,
          kind: "image",
          ...(extraction ? { extractedContent: extraction } : {}),
        },
        blocks: [image ? { type: "image", source: image } : null],
      })
      continue
    }
    if (text !== undefined) {
      // An image's OCR is a second text block under the image's own entry.
      const previous = sources.at(-1)
      if (
        mediaType.startsWith("image/") &&
        previous?.entry.kind === "image" &&
        previous.entry.filename === filename &&
        previous.blocks.length === 1
      ) {
        previous.blocks.push({ type: "text", text })
        continue
      }
      sources.push({
        entry: {
          filename,
          mediaType: mediaType || "text/plain",
          kind: mediaType.startsWith("audio/") ? "audio" : "document",
          ...(extraction ? { extractedContent: extraction } : {}),
        },
        blocks: [{ type: "text", text }],
      })
      continue
    }
    // A file part with neither bytes nor text has nothing to send.
    sources.push({ entry: { filename, mediaType, kind: "document" }, blocks: [null] })
  }

  const blocks: SendContentBlock[] = []
  const manifest: AttachmentManifestEntry[] = []
  const leftOut = new Set<string>()
  for (const source of sources) {
    if (
      source.native ||
      source.blocks.length === 0 ||
      source.blocks.some((block) => block === null)
    ) {
      leftOut.add(source.entry.filename)
      continue
    }
    for (const block of source.blocks) {
      blocks.push(block!)
      manifest.push(source.entry)
    }
  }
  return { blocks, manifest, unavailable: [...leftOut] }
}

/**
 * A user row's whole turn, as `buildSendContent` and link context laid it out:
 * the attachments, then the typed text, then any fetched link context. A turn
 * that is one text part and nothing else is the plain string it was sent as.
 */
export async function resendableUserTurn(parts: readonly unknown[]): Promise<ResendableUserTurn> {
  const attachments = await resendableAttachments(parts)
  const texts = parts.flatMap((raw) => {
    const part = (raw ?? {}) as RowPart
    return part.type === "text" &&
      typeof part.text === "string" &&
      videoAttachmentInfoOfPart(part) === null
      ? [part.text]
      : []
  })
  const content: SendContent =
    attachments.blocks.length === 0 && texts.length <= 1
      ? (texts[0] ?? "")
      : [...attachments.blocks, ...texts.map((text) => ({ type: "text" as const, text }))]
  return { content, manifest: attachments.manifest, unavailable: attachments.unavailable }
}
