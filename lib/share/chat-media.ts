// Resolving a conversation's private media references before it is shared
// (ADR-0222 §6.3).
//
// Images in a conversation are stored once, content-addressed, and messages
// point at them as `cognia-media:<hash>`. That reference means nothing outside
// this device, so a shared transcript that carried it verbatim showed every
// image as broken. Before a transcript is rendered for a share, each
// reference is replaced:
//
// - an image within the per-image cap, while the share's inline budget
//   lasts, becomes a `data:` URL inside the transcript — the envelope
//   carries it, and a sandboxed `srcdoc` frame can show it;
// - anything larger, or not an image, travels as one of the share's
//   encrypted files and the transcript names it without a link;
// - a reference whose bytes are gone is named without a link and counted.
//
// The inline budget exists because the envelope is a single request: base64
// of the image inside JSON inside base64 ciphertext roughly doubles it, and
// the share server caps a request at 10 MiB.

import type { StoredMessage } from "@cognia/agent-config-types"
import { getMessageMedia, parseMediaRef, type MessageMediaRow } from "@/lib/db/message-media"

import { blobShareSource } from "./file-sources"
import { encodeBase64 } from "./encoding"
import type { CreateShareFile } from "./client"

/** Largest image inlined into a shared transcript. */
export const SHARE_INLINE_IMAGE_MAX_BYTES = 1024 * 1024
/** Most image bytes one shared transcript inlines in total. */
export const SHARE_INLINE_MEDIA_BUDGET_BYTES = 3 * 1024 * 1024
/** Where media carried as files appear in the share's file list. */
export const SHARE_ATTACHMENTS_PREFIX = "/attachments"

export interface ChatShareMedia {
  /** The messages with every `cognia-media:` reference resolved or dropped. */
  messages: StoredMessage[]
  /** Media too large to inline, to be carried as share files. */
  attachments: CreateShareFile[]
  /** References whose bytes are no longer on this device. */
  unavailable: number
}

interface FileLikePart {
  type?: unknown
  url?: unknown
  mediaType?: unknown
  filename?: unknown
}

const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
}

function safeName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ").trim()
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "attachment"
}

/** `name` unless taken, else `stem (2).ext`, `stem (3).ext`, … */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name)
    return name
  }
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

export interface ChatShareMediaDeps {
  getMessageMedia: (refOrHash: string) => Promise<MessageMediaRow | undefined>
}

export const defaultChatShareMediaDeps: ChatShareMediaDeps = { getMessageMedia }

type Resolved =
  { kind: "inline"; url: string } | { kind: "attached"; name: string } | { kind: "unavailable" }

/** Resolve every private media reference in `messages` for a share. */
export async function materializeChatShareMedia(
  messages: readonly StoredMessage[],
  deps: ChatShareMediaDeps = defaultChatShareMediaDeps
): Promise<ChatShareMedia> {
  const byHash = new Map<string, Resolved>()
  const attachments: CreateShareFile[] = []
  const takenNames = new Set<string>()
  let budget = SHARE_INLINE_MEDIA_BUDGET_BYTES
  let unavailable = 0

  const resolve = async (hash: string, part: FileLikePart): Promise<Resolved> => {
    const known = byHash.get(hash)
    if (known) return known
    const media = await deps.getMessageMedia(hash)
    let resolved: Resolved
    if (!media || media.canonicalAvailable === false || !(media.blob instanceof Blob)) {
      resolved = { kind: "unavailable" }
    } else {
      const blob = media.blob
      const image = media.mediaType.startsWith("image/")
      if (image && blob.size <= SHARE_INLINE_IMAGE_MAX_BYTES && blob.size <= budget) {
        budget -= blob.size
        const bytes = new Uint8Array(await blob.arrayBuffer())
        resolved = { kind: "inline", url: `data:${media.mediaType};base64,${encodeBase64(bytes)}` }
      } else {
        const given = typeof part.filename === "string" ? part.filename : ""
        const fallback = `image-${hash.slice(0, 8)}.${EXTENSION_BY_TYPE[media.mediaType] ?? "bin"}`
        const name = uniqueName(safeName(given || fallback), takenNames)
        attachments.push({
          path: `${SHARE_ATTACHMENTS_PREFIX}/${name}`,
          name,
          mime: media.mediaType || "application/octet-stream",
          open: async () => blobShareSource(blob),
        })
        resolved = { kind: "attached", name }
      }
    }
    byHash.set(hash, resolved)
    return resolved
  }

  const out: StoredMessage[] = []
  for (const message of messages) {
    let changed = false
    const parts = []
    for (const part of message.parts) {
      const file = part as FileLikePart
      const hash =
        (file.type === "file" || file.type === "image") && typeof file.url === "string"
          ? parseMediaRef(file.url)
          : null
      if (!hash) {
        parts.push(part)
        continue
      }
      changed = true
      const resolved = await resolve(hash, file)
      if (resolved.kind === "inline") {
        parts.push({ ...part, url: resolved.url } as typeof part)
        continue
      }
      if (resolved.kind === "unavailable") unavailable++
      // An empty URL renders as the file's name without a link in every
      // export format; an attached file keeps the name it has in the list.
      parts.push({
        ...part,
        url: "",
        ...(resolved.kind === "attached" ? { filename: resolved.name } : {}),
      } as typeof part)
    }
    out.push(changed ? { ...message, parts } : message)
  }
  return { messages: out, attachments, unavailable }
}
