/**
 * Turn a user message back into what the composer held when it was sent.
 *
 * A follow-up queued behind a running turn lives on as its optimistic bubble
 * (`hooks/chat/steer-runtime.ts`). When it cannot be delivered — the user
 * stopped the run, or the app reloaded and the in-memory queue is gone — the
 * way back is the composer, and "back" has to mean everything the user staged:
 * the typed words, the screenshots and files, the chip citations, the message
 * it answered, and the context envelope (referenced material, web results) the
 * composer put in front of it. Restoring the text alone silently dropped the
 * rest, which is the part that is hard to recreate.
 *
 * The bubble is the source because it is the only copy that survives a reload:
 * attachment originals are owned by the session asset store
 * (`persistMessageSessionAssets`), pasted images ride inline as data URLs, and
 * citations, reply target and envelope summary are on `metadata`.
 */

import type { UIMessage } from "ai"
import type { MessageReplyTo } from "@cognia/agent-config-types"
import { readAttachmentExtractedContent } from "@cognia/agent-config-types/attachment"
import type { ContextRef } from "@/lib/chat/mentions/types"
import { mergeContextRefs } from "@/lib/chat/mentions/merge-refs"
import {
  promptPreambleOfParts,
  readPromptPreambleSummary,
  stripPromptPreambleFromParts,
  type CarriedPromptPreamble,
} from "@/lib/chat/prompt-preamble"
import { readReplyTo } from "@/lib/chat/reply-to"
import { stripSteerPrefix } from "@/lib/claude/steer"
import { decodeDataUrl } from "@/lib/ocr/image-prep"
import { getSessionAsset } from "@/lib/db/session-assets"
import { VIDEO_ATTACHMENT_PART_KEY } from "@/lib/chat/attachments/video/attachment-info"

export type { CarriedPromptPreamble }

export interface ComposerRestorePayload {
  /** The user's own words, without the envelope or the steer framing. */
  text: string
  /** Attachments rebuilt from their stored originals, in message order. */
  files: File[]
  /** Chip-style citations that the restored text does not re-derive by itself. */
  citations: ContextRef[]
  /** The message this one answered. */
  replyTo?: MessageReplyTo
  /** Every envelope the restored messages carried, in order. */
  carried: CarriedPromptPreamble[]
  /** Names of attachments whose original is gone (only extracted text was kept). */
  missing: string[]
}

export interface ComposerRestoreDeps {
  getSessionAsset: typeof getSessionAsset
}

const defaultDeps: ComposerRestoreDeps = { getSessionAsset }

interface FilePartLike {
  type: "file"
  url?: string
  mediaType?: string
  filename?: string
  extractedContent?: unknown
  [VIDEO_ATTACHMENT_PART_KEY]?: unknown
}

function isFilePart(part: unknown): part is FilePartLike {
  return !!part && typeof part === "object" && (part as { type?: unknown }).type === "file"
}

function typedTextOf(message: Pick<UIMessage, "parts">): string {
  return stripPromptPreambleFromParts(message.parts)
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => {
      return part.type === "text"
    })
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function mentionsOf(metadata: unknown): ContextRef[] {
  if (!metadata || typeof metadata !== "object") return []
  const mentions = (metadata as { mentions?: unknown }).mentions
  if (!Array.isArray(mentions)) return []
  return mentions.filter(
    (ref): ref is ContextRef =>
      !!ref &&
      typeof ref === "object" &&
      typeof (ref as { id?: unknown }).id === "string" &&
      typeof (ref as { kind?: unknown }).kind === "string"
  )
}

/**
 * The citations to stage as chips. A ref whose inline token is still in the
 * restored text is parsed out of it again on send; staging it as a chip too
 * would show the same reference twice.
 */
function chipCitations(mentions: readonly ContextRef[], text: string): ContextRef[] {
  return mentions.filter((ref) => !ref.raw || !text.includes(ref.raw))
}

function fileName(part: FilePartLike, mediaType: string, index: number): string {
  if (part.filename?.trim()) return part.filename
  const extension = mediaType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "bin"
  return `attachment-${index}.${extension}`
}

/** Rebuild one message's composer state. Never throws for a missing original. */
export async function composerRestoreFromMessage(
  sessionId: string,
  message: Pick<UIMessage, "parts" | "metadata">,
  options: { replyTo?: MessageReplyTo; deps?: ComposerRestoreDeps } = {}
): Promise<ComposerRestorePayload> {
  const deps = options.deps ?? defaultDeps
  const text = stripSteerPrefix(typedTextOf(message))
  const files: File[] = []
  const missing: string[] = []
  // A video or multi-page document spreads over several parts; its original
  // is attached to the first one only and restored once.
  const restoredSources = new Set<string>()
  let index = 0
  for (const part of message.parts) {
    if (!isFilePart(part)) continue
    index += 1
    const extraction = readAttachmentExtractedContent(part.extractedContent)
    if (extraction) {
      if (restoredSources.has(extraction.attachmentId)) continue
      restoredSources.add(extraction.attachmentId)
      const asset = await deps.getSessionAsset(sessionId, extraction.attachmentId).catch(() => null)
      if (asset) {
        files.push(
          new File([asset.blob], asset.filename, {
            type: asset.mediaType || asset.blob.type,
          })
        )
        continue
      }
    } else if (part[VIDEO_ATTACHMENT_PART_KEY] !== undefined) {
      // A frame of a video whose original rides another part.
      continue
    }
    const decoded = part.url?.startsWith("data:") ? decodeDataUrl(part.url) : null
    if (decoded) {
      const mediaType = part.mediaType || decoded.mimeType
      files.push(
        new File([decoded.bytes as BlobPart], fileName(part, mediaType, index), {
          type: mediaType,
        })
      )
      continue
    }
    missing.push(part.filename || part.mediaType || `attachment-${index}`)
  }
  const preamble = promptPreambleOfParts(message.parts)
  const summary = readPromptPreambleSummary(message.metadata)
  const replyTo = readReplyTo(message) ?? options.replyTo
  return {
    text,
    files,
    citations: chipCitations(mentionsOf(message.metadata), text),
    ...(replyTo ? { replyTo } : {}),
    carried: preamble ? [{ preamble, ...(summary ? { summary } : {}) }] : [],
    missing,
  }
}

/**
 * Several queued follow-ups go back as one draft, in send order: their words
 * separated by a blank line, every file, every citation once, the first reply
 * target (the one a drained turn would have answered), every envelope.
 */
export function mergeComposerRestores(
  payloads: readonly ComposerRestorePayload[]
): ComposerRestorePayload {
  const replyTo = payloads.find((payload) => payload.replyTo)?.replyTo
  return {
    text: payloads
      .map((payload) => payload.text)
      .filter((text) => text.length > 0)
      .join("\n\n"),
    files: payloads.flatMap((payload) => payload.files),
    citations: mergeContextRefs(
      [],
      payloads.flatMap((payload) => payload.citations)
    ),
    ...(replyTo ? { replyTo } : {}),
    carried: payloads.flatMap((payload) => payload.carried),
    missing: payloads.flatMap((payload) => payload.missing),
  }
}

/** True when there is nothing to put back. */
export function isEmptyComposerRestore(payload: ComposerRestorePayload): boolean {
  return (
    payload.text.length === 0 &&
    payload.files.length === 0 &&
    payload.citations.length === 0 &&
    payload.carried.length === 0 &&
    !payload.replyTo
  )
}
