/**
 * Telegram inbound rich-media enrichment.
 *
 * `parse.ts` is pure — no credentials, no I/O — so a photo becomes
 * `{ type: "image", url: "tg://file/<file_id>" }`. Nothing downstream resolved
 * that pseudo-URL, and `inboundEventToSendContent` falls back to a text marker
 * when an image segment carries no bytes. The result: someone sent the bot a
 * photo and asked "what is this?", and the model received the literal text
 * `[image: tg://file/AgACAgEAAx…]`. The inbound OCR pass was dead for the same
 * reason — it only runs on segments that carry inline bytes.
 *
 * This is the async second pass, run just before the event enters the bus. It
 * downloads through the existing encrypted attachment cache and attaches:
 *
 *   - `image` → inline `dataBase64` + `mimeType`, which the OCR pass and the
 *     model's vision path both consume automatically.
 *   - `file`  → cached, and for document types the text is extracted with the
 *     shared `processDocumentAsync` so the model reads the contents rather
 *     than the file name.
 *
 * Telegram needs two calls: `getFile` turns a `file_id` into a short-lived
 * `file_path`, then the file is downloaded from the `/file/bot<token>/` host.
 * The cache is keyed on the STABLE `file_id`, not the expiring path, so a
 * redelivery or an album re-fetch is a cache hit that never calls `getFile`.
 *
 * Everything is best-effort: a missing token, a 4xx, an over-cap file, or a
 * parse failure leaves the segment as its marker and NEVER blocks delivery.
 * Nothing here throws.
 */

import { isTauri } from "@/lib/tauri"
import {
  connectorsAttachmentFetch,
  connectorsAttachmentRead,
  connectorsHttpRequest,
} from "@/lib/connectors/tauri/commands"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

const TELEGRAM_API_BASE = "https://api.telegram.org"

/** The pseudo-URL scheme `parse.ts` emits for every media segment. */
export const TELEGRAM_FILE_SCHEME = "tg://file/"

/**
 * Max bytes to inline as base64 (image vision / OCR) or read for text
 * extraction. Telegram's own Bot-API download ceiling is 20 MB; this is the
 * smaller "worth holding in a prompt" bound, matching the Lark pass.
 */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024

/** Image segment widened with the inline byte fields the vision path reads. */
type InboundImageSegment = Extract<MessageSegment, { type: "image" }> & {
  dataBase64?: string
  mimeType?: string
}

export interface EnrichTelegramMediaDeps {
  /** Resolve the bot token. Both calls need it — one in a path, one in a URL. */
  botToken: () => Promise<string>
  fetchAttachment?: typeof connectorsAttachmentFetch
  readAttachment?: typeof connectorsAttachmentRead
  httpRequest?: typeof connectorsHttpRequest
  /** Injectable document-text extractor; defaults to `processDocumentAsync`. */
  extractDocText?: (data: ArrayBuffer, name: string) => Promise<string>
  maxInlineBytes?: number
  /** Force-enable outside a Tauri host (tests). Defaults to `isTauri()`. */
  enabled?: boolean
}

/** `tg://file/<id>` → `<id>`, or `undefined` for anything else. */
export function fileIdFromUrl(url: string | undefined): string | undefined {
  if (!url || !url.startsWith(TELEGRAM_FILE_SCHEME)) return undefined
  const id = url.slice(TELEGRAM_FILE_SCHEME.length)
  return id.length > 0 ? id : undefined
}

/**
 * Guess a media type from the `file_path` Telegram returns.
 *
 * It matters: `inboundEventToSendContent` passes `mimeType` straight through as
 * the model's `media_type`, and Telegram photos are JPEG while the fallback
 * there is PNG. A declared type that does not match the bytes is rejected by
 * the provider, so guessing from the real extension beats defaulting.
 */
export function mimeFromFilePath(filePath: string | undefined): string | undefined {
  const ext = filePath?.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "png":
      return "image/png"
    case "gif":
      return "image/gif"
    case "webp":
      return "image/webp"
    default:
      return undefined
  }
}

const EXTRACTABLE_EXTS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "csv",
  "md",
  "markdown",
  "rtf",
  "epub",
  "json",
  "html",
  "htm",
  "xml",
])

function isExtractableDoc(name: string): boolean {
  const dot = name.lastIndexOf(".")
  if (dot < 0) return false
  return EXTRACTABLE_EXTS.has(name.slice(dot + 1).toLowerCase())
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

async function defaultExtractDocText(data: ArrayBuffer, name: string): Promise<string> {
  const { processDocumentAsync } = await import("@cognia/document/document-processor")
  const processed = await processDocumentAsync(`telegram-inbound:${name}`, name, data)
  return processed.content ?? ""
}

/**
 * `getFile` — resolve a `file_id` to the path under `/file/bot<token>/`.
 * Returns `undefined` for any non-ok response rather than throwing, because a
 * file that has aged out of Telegram's storage is an expected outcome.
 */
async function resolveFilePath(
  token: string,
  fileId: string,
  httpRequest: typeof connectorsHttpRequest
): Promise<string | undefined> {
  const resp = await httpRequest({
    url: `${TELEGRAM_API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
    method: "GET",
  })
  if (resp.status < 200 || resp.status >= 300) return undefined
  const body = JSON.parse(resp.body) as { ok?: boolean; result?: { file_path?: string } }
  if (!body.ok) return undefined
  const filePath = body.result?.file_path
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined
}

/**
 * Second-pass enrichment of an inbound Telegram event's media segments.
 * Mutates segments in place. Safe to await in the inbound path.
 */
export async function enrichTelegramInboundMedia(
  event: NormalizedInboundEvent,
  deps: EnrichTelegramMediaDeps
): Promise<void> {
  const enabled = deps.enabled ?? isTauri()
  if (!enabled) return

  // Nothing to do for a text-only message — resolve no token and make no call.
  const hasMedia = event.segments.some(
    (seg) => (seg.type === "image" || seg.type === "file") && fileIdFromUrl(seg.url) !== undefined
  )
  if (!hasMedia) return

  const fetchAttachment = deps.fetchAttachment ?? connectorsAttachmentFetch
  const readAttachment = deps.readAttachment ?? connectorsAttachmentRead
  const httpRequest = deps.httpRequest ?? connectorsHttpRequest
  const extractDocText = deps.extractDocText ?? defaultExtractDocText
  const maxBytes = deps.maxInlineBytes ?? MAX_INLINE_BYTES
  const adapterId = event.adapterId

  let token: string
  try {
    token = await deps.botToken()
  } catch {
    // No token → nothing can be downloaded. Leave every marker intact.
    return
  }

  for (const seg of event.segments) {
    try {
      const fileId = fileIdFromUrl(
        seg.type === "image" || seg.type === "file" ? seg.url : undefined
      )
      if (!fileId) continue

      // Keyed on the file_id, so a cache hit skips `getFile` entirely — which
      // matters because the path it returns expires in about an hour while the
      // id does not.
      const remoteRef = `telegram:${fileId}`
      let cached = await readAttachment(adapterId, remoteRef, maxBytes)
      let filePath: string | undefined
      if (!cached) {
        filePath = await resolveFilePath(token, fileId, httpRequest)
        if (!filePath) continue
        await fetchAttachment(
          adapterId,
          remoteRef,
          `${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`
        )
        cached = await readAttachment(adapterId, remoteRef, maxBytes)
      }
      if (!cached) continue

      if (seg.type === "image") {
        const img = seg as InboundImageSegment
        if (img.dataBase64) continue
        img.dataBase64 = cached
        img.mimeType = img.mimeType ?? mimeFromFilePath(filePath) ?? "image/jpeg"
        continue
      }

      if (seg.type === "file" && isExtractableDoc(seg.name)) {
        const text = await extractDocText(base64ToArrayBuffer(cached), seg.name)
        if (text.length > 0) {
          ;(seg as { ocrText?: string }).ocrText = text
        }
      }
    } catch {
      // Per-segment best-effort: one unreadable attachment must not cost the
      // others, and never the message.
    }
  }
}
