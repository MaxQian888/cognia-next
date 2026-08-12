import type { UIMessage } from "ai"
import type { StoredMessage } from "@cognia/agent-config-types"
import { isMediaRef } from "@/lib/db/message-media"
import { ingestImageDataUrl } from "./ingest-media"

interface FileLikePart {
  type?: unknown
  url?: unknown
  mediaType?: unknown
  width?: unknown
  height?: unknown
  byteSize?: unknown
}

function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/")
}

/**
 * Move inline image bytes out of a message before it reaches IndexedDB.
 *
 * The adapter, composer and import paths all project visible images to AI SDK
 * `file` parts. Keeping the normalization at the persistence boundary makes
 * those producers safe even when they are called outside the main composer.
 * Unknown/remote/blob URLs and existing content-addressed references retain
 * their original object identity.
 */
export async function normalizeMessageMedia(message: UIMessage): Promise<UIMessage> {
  let changed = false
  const parts = await Promise.all(
    message.parts.map(async (part) => {
      const file = part as FileLikePart
      if (file.type !== "file" || !isImageDataUrl(file.url)) return part
      if (isMediaRef(file.url)) return part

      const ingested = await ingestImageDataUrl(file.url, { keepOriginal: message.role === "user" })
      if (!ingested) return part
      changed = true
      return {
        ...part,
        url: ingested.ref,
        mediaType: ingested.mediaType,
        width: ingested.width,
        height: ingested.height,
        byteSize: ingested.byteSize,
      } as unknown as typeof part
    })
  )

  return changed ? { ...message, parts } : message
}

/**
 * Stored-message counterpart used by import/sync producers that already own
 * database-shaped rows. Keeping this beside `normalizeMessageMedia` prevents
 * those paths from bypassing the content-addressed media boundary merely to
 * preserve StoredMessage-only columns such as `platformMessageId`.
 */
export async function normalizeStoredMessageMedia(message: StoredMessage): Promise<StoredMessage> {
  const normalized = await normalizeMessageMedia({
    id: message.id,
    role: message.role,
    parts: message.parts,
  } as UIMessage)
  return normalized.parts === message.parts ? message : { ...message, parts: normalized.parts }
}
