/**
 * Lark inbound rich-media enrichment (closes the ADR-0009 "Phase 1 / Phase 2
 * attachment caching" markers for the Lark adapter).
 *
 * `parse.ts:buildSegments` projects an inbound Feishu message into typed
 * `MessageSegment[]` but can only carry the platform media *ref* (image_key /
 * file_key) — the parser is pure and has no credentials or I/O. This module is
 * the async second pass, run in the adapter's `dispatchEnvelope` before the
 * event enters the bus. It downloads the media through the existing encrypted
 * attachment cache (`connectors_attachment_fetch` / `connectors_attachment_read`,
 * which already accept an auth header + return capped base64) and attaches:
 *
 *   - `image` → inline `dataBase64` + `mimeType`, which the already-wired inbound
 *     OCR pass (`inbound-ocr.ts`) and the model vision path
 *     (`runtime.ts:inboundEventToSendContent`) both consume automatically.
 *   - `file`  → downloads to cache and, for document types, extracts text via
 *     the shared `processDocumentAsync` so the model can read the file's
 *     contents instead of only its name.
 *
 * Everything is best-effort: a missing token, a non-2xx download, an
 * over-cap file, or a parser failure degrades the segment back to its URL /
 * name marker and NEVER blocks inbound delivery.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { isTauri } from "@/lib/tauri"
import {
  connectorsAttachmentFetch,
  connectorsAttachmentRead,
} from "@/lib/connectors/tauri/commands"

const LARK_API_BASE = "https://open.feishu.cn/open-apis"

/**
 * Max bytes to inline as base64 (for image OCR / vision) or read for file
 * text-extraction. Larger media stays cached on disk but is not inlined — the
 * segment keeps its URL / name marker.
 */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024

/** Image segment widened with the inline byte fields the OCR / vision paths read. */
type InboundImageSegment = Extract<MessageSegment, { type: "image" }> & {
  dataBase64?: string
  mimeType?: string
}

export interface EnrichLarkMediaDeps {
  /** Resolve a valid tenant (or user) access token for the download auth header. */
  getAccessToken: () => Promise<string>
  /** Injectable for tests; defaults to the real Tauri command wrapper. */
  fetchAttachment?: typeof connectorsAttachmentFetch
  /** Injectable for tests; defaults to the real Tauri command wrapper. */
  readAttachment?: typeof connectorsAttachmentRead
  /**
   * Injectable document-text extractor. Defaults to `processDocumentAsync`
   * (dynamically imported so the parsers stay lazy). Returns extracted text
   * (empty string when nothing could be extracted).
   */
  extractDocText?: (data: ArrayBuffer, name: string) => Promise<string>
  /** Override the inline/read cap (tests). */
  maxInlineBytes?: number
  /**
   * Force-enable outside a Tauri host (tests). In production this defaults to
   * `isTauri()` — the attachment commands throw in web mode.
   */
  enabled?: boolean
}

/** File extensions worth running through `processDocumentAsync` for text. */
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
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

async function defaultExtractDocText(data: ArrayBuffer, name: string): Promise<string> {
  const { processDocumentAsync } = await import("@cognia/document/document-processor")
  const processed = await processDocumentAsync(`lark-inbound:${name}`, name, data)
  return processed.content ?? ""
}

/** Build the Lark message-resource download URL for a media key. */
function resourceUrl(messageId: string, key: string, type: "image" | "file"): string {
  return (
    `${LARK_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}` +
    `/resources/${encodeURIComponent(key)}?type=${type}`
  )
}

/**
 * Second-pass enrichment of an inbound Lark event's media segments. Mutates the
 * event's segments in place (attaching `dataBase64` / `ocrText`). Best-effort:
 * any failure leaves the segment as its URL / name marker. Safe to await in the
 * inbound path — it never throws.
 */
export async function enrichLarkInboundMedia(
  event: NormalizedInboundEvent,
  deps: EnrichLarkMediaDeps
): Promise<void> {
  const enabled = deps.enabled ?? isTauri()
  if (!enabled) return
  const messageId = event.messageId
  if (!messageId) return

  const fetchAttachment = deps.fetchAttachment ?? connectorsAttachmentFetch
  const readAttachment = deps.readAttachment ?? connectorsAttachmentRead
  const extractDocText = deps.extractDocText ?? defaultExtractDocText
  const maxBytes = deps.maxInlineBytes ?? MAX_INLINE_BYTES
  const adapterId = event.adapterId

  // A single message shares one token; resolving it up front means an
  // image-heavy post pays for the token resolution once.
  let token: string
  try {
    token = await deps.getAccessToken()
  } catch {
    // No token → cannot authenticate the download. Leave every marker intact.
    return
  }
  const headers = { Authorization: `Bearer ${token}` }

  for (const seg of event.segments) {
    try {
      if (seg.type === "image") {
        const img = seg as InboundImageSegment
        if (img.dataBase64 || !seg.url) continue
        const remoteRef = `lark:${messageId}:${seg.url}`
        await fetchAttachment(
          adapterId,
          remoteRef,
          resourceUrl(messageId, seg.url, "image"),
          headers
        )
        const b64 = await readAttachment(adapterId, remoteRef, maxBytes)
        if (b64) {
          img.dataBase64 = b64
          img.mimeType = img.mimeType ?? "image/png"
        }
      } else if (seg.type === "file") {
        if (!seg.url) continue
        const remoteRef = `lark:${messageId}:${seg.url}`
        await fetchAttachment(
          adapterId,
          remoteRef,
          resourceUrl(messageId, seg.url, "file"),
          headers
        )
        if (!seg.ocrText && isExtractableDoc(seg.name)) {
          const b64 = await readAttachment(adapterId, remoteRef, maxBytes)
          if (b64) {
            const text = await extractDocText(base64ToArrayBuffer(b64), seg.name).catch(() => "")
            if (text.trim()) seg.ocrText = text.trim()
          }
        }
      }
    } catch {
      // Best-effort — a download / extraction failure leaves the segment as
      // its URL / name marker. Inbound delivery must never block on media.
    }
  }
}
