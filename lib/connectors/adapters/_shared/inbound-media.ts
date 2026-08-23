/**
 * The one inbound rich-media enrichment loop.
 *
 * Every `parse.ts` in this tree is pure — no credentials, no I/O — so an
 * inbound photo or document becomes a segment carrying only a platform
 * *reference*: a Lark `image_key`, a Telegram `tg://file/<id>`, a signed
 * Discord CDN URL, a Slack `url_private` that needs a bearer token. Nothing
 * downstream resolves those, and `runtime.ts:inboundEventToSendContent`
 * degrades an image with no bytes to the literal text `[image: <url>]`. So
 * someone sends the bot a picture, asks "what is this?", and the model is
 * handed a URL string it cannot open. The inbound OCR pass
 * (`inbound-ocr.ts`) is dead for the same reason — it only runs on segments
 * that carry inline bytes.
 *
 * This is the async second pass every adapter runs just before the event
 * enters the bus. It downloads through the existing encrypted attachment
 * cache (`connectors_attachment_fetch` / `connectors_attachment_read`) and
 * attaches:
 *
 *   - `image` → inline `dataBase64` + `mimeType`, which the OCR pass and the
 *     model's vision path both consume automatically.
 *   - `file`  → text extracted with the shared `processDocumentAsync`, so the
 *     model reads the document's contents rather than only its name.
 *   - `file` whose `mimeType` is an image → inline `dataBase64` too, for the
 *     OCR pass. A picture sent as a document is not an edge case: it is how
 *     Telegram sends an uncompressed screenshot, i.e. exactly the one the
 *     sender wanted read accurately.
 *
 * Whichever route ran, the media type stamped on the segment is read from the
 * BYTES (`sniffImageMediaType`), not from whoever guessed first.
 *
 * Adapters supply only what differs: how to name a segment's cache entry
 * (`ref`) and how to turn one into a download (`source`). Everything else —
 * the cache-hit short circuit, the per-segment error containment, the mime
 * fallback, the extractable-type list — lives here exactly once.
 *
 * ## Cache-read first
 *
 * The loop reads the cache BEFORE calling `source`, and a hit skips `source`
 * entirely. That is not just an IPC saving: for Telegram, `source` is an HTTP
 * `getFile` round trip, and for Lark it is a keyring token resolution. Cache
 * refs must therefore be stable across redeliveries — never derived from a
 * signed or expiring URL. `stableMediaRef` strips the query string for the
 * platforms whose CDN signs it.
 *
 * ## Best-effort, always
 *
 * A missing token, a 4xx, an over-cap file, or a parse failure leaves the
 * segment as its original marker and NEVER blocks delivery. One unreadable
 * attachment does not cost the others. Nothing here throws.
 *
 * Binary media reaching a cloud model is a separate decision, made once by the
 * bus (step 9.7) and enforced in `inboundEventToSendContent`. Inlining bytes
 * here does not authorise sending them: under the default `local_extract_only`
 * only locally-extracted text goes out.
 */

import { evaluateFetchTarget } from "@cognia/network-guard"

import { isTauri } from "@/lib/tauri"
import {
  connectorsAttachmentFetch,
  connectorsAttachmentRead,
} from "@/lib/connectors/tauri/commands"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

/**
 * Max bytes to inline as base64 (image vision / OCR) or read for text
 * extraction. Larger media stays on disk in the cache but is not inlined — the
 * segment keeps its original marker.
 */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024

/** The two segment kinds this pass can enrich. */
export type EnrichableSegment = Extract<MessageSegment, { type: "image" | "file" }>

/** Image segment widened with the inline byte fields the vision path reads. */
type InlineImageSegment = Extract<MessageSegment, { type: "image" }> & {
  dataBase64?: string
  mimeType?: string
}

/** What it takes to download one segment's bytes. */
export interface InboundMediaSource {
  url: string
  /** Auth the download needs (Slack's `url_private`, Lark's open-apis host). */
  headers?: Record<string, string>
  /**
   * Media type learned while resolving — Telegram only discovers the real
   * extension from `getFile`. Wins over `defaultImageMime`, loses to a type
   * the parser already put on the segment.
   */
  mimeType?: string
}

/** The per-platform half of the pass. */
export interface InboundMediaPlan {
  /**
   * Stable cache ref for this segment, or `undefined` to skip it entirely.
   * Called synchronously for every media segment, so it must be cheap and must
   * not embed anything that expires.
   */
  ref: (seg: EnrichableSegment, event: NormalizedInboundEvent) => string | undefined
  /**
   * How to download a cache miss. May resolve credentials and may make network
   * calls — it only runs when the bytes are not already cached. Returning
   * `undefined` (or throwing) leaves the segment as its marker.
   */
  source: (
    seg: EnrichableSegment,
    event: NormalizedInboundEvent
  ) => InboundMediaSource | undefined | Promise<InboundMediaSource | undefined>
  /**
   * Media type stamped on an image when neither the parser nor `source` named
   * one. It matters: `inboundEventToSendContent` passes `mimeType` straight
   * through as the model's `media_type`, and a declared type that disagrees
   * with the bytes is rejected by the provider.
   */
  defaultImageMime?: string
  /** Prefix for the document-extraction id, e.g. `"discord-inbound"`. */
  extractLabel: string
  /**
   * Opt-in widening of the `isPublicHttpUrl` floor, for the one legitimate
   * case: a self-hosted protocol implementation serving media from an address
   * the OPERATOR configured (OneBot's forward-WS host is routinely on the LAN).
   * Only ever return true for a host the operator named themselves — never for
   * one that arrived inside a message.
   */
  allowPrivateHost?: (url: string) => boolean
}

export interface InboundMediaDeps {
  fetchAttachment?: typeof connectorsAttachmentFetch
  readAttachment?: typeof connectorsAttachmentRead
  /** Injectable document-text extractor; defaults to `processDocumentAsync`. */
  extractDocText?: (data: ArrayBuffer, name: string) => Promise<string>
  maxInlineBytes?: number
  /** Force-enable outside a Tauri host (tests). Defaults to `isTauri()`. */
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

/** True when `processDocumentAsync` has a chance of reading this file. */
export function isExtractableDoc(name: string): boolean {
  const dot = name.lastIndexOf(".")
  if (dot < 0) return false
  return EXTRACTABLE_EXTS.has(name.slice(dot + 1).toLowerCase())
}

/**
 * Cache ref for a platform that hands us a real, signed HTTP URL.
 *
 * Discord signs every attachment URL (`?ex=&is=&hm=`) and the signature is
 * refreshed on redelivery, so keying the cache on the whole URL would miss on
 * a message the bot has already downloaded. The path identifies the file.
 */
export function stableMediaRef(prefix: string, url: string): string {
  try {
    return `${prefix}:${new URL(url).pathname}`
  } catch {
    // Not absolute (or not a URL at all) — the raw value is the best id there
    // is, and it is at least stable.
    return `${prefix}:${url}`
  }
}

/**
 * Loopback / private / link-local hosts a download must never be aimed at.
 *
 * The URL a message's media lives at is remote-controlled data, and the Rust
 * fetch command applies no guard of its own, so this is the floor: every plan
 * passes through it before a byte is requested. It stops the obvious targets —
 * `127.0.0.1`, a LAN address, and the cloud metadata endpoint at
 * `169.254.169.254`.
 *
 * The classification itself lives in `@cognia/network-guard`, shared with the
 * `web_fetch` gate and the web-clone sidecar so the three cannot drift apart
 * again. This wrapper keeps the boolean shape the plans are written against.
 *
 * It does NOT stop a public name that resolves to a private address (DNS
 * rebinding); catching that needs a check at resolution time, which belongs in
 * the Rust client. Platforms whose media lives on a known host (Discord, Slack)
 * narrow this further with their own allowlist.
 */
export function isPublicHttpUrl(raw: string): boolean {
  return evaluateFetchTarget(raw).allowed
}

/**
 * Memoise an async resolution — including its rejection — for the lifetime of
 * one enrichment pass.
 *
 * A 10-photo album shares one bot token; without this a locked keyring costs
 * ten failed reads instead of one.
 */
export function onceAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => (pending ??= fn())
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function defaultExtractor(label: string) {
  return async (data: ArrayBuffer, name: string): Promise<string> => {
    const { processDocumentAsync } = await import("@cognia/document/document-processor")
    const processed = await processDocumentAsync(`${label}:${name}`, name, data)
    return processed.content ?? ""
  }
}

/**
 * Segments this pass would do work on: media that still needs bytes AND that
 * the plan can name. A text-only message resolves no credentials and makes no
 * call at all.
 */
function targetsOf(
  event: NormalizedInboundEvent,
  plan: InboundMediaPlan
): Array<{ seg: EnrichableSegment; ref: string }> {
  const targets: Array<{ seg: EnrichableSegment; ref: string }> = []
  for (const seg of event.segments) {
    if (seg.type !== "image" && seg.type !== "file") continue
    // Already enriched — an adapter that inlines bytes at parse time (WeCom,
    // WeChat) must not pay for a second download.
    if (seg.type === "image" && (seg as InlineImageSegment).dataBase64) continue
    if (seg.type === "file") {
      if (seg.ocrText || seg.dataBase64) continue
      // A file is only worth downloading when something can read it back:
      // nothing surfaces an inbound cached blob, so caching one nobody can open
      // is pure disk churn. Two things can — the document extractor, and (for a
      // picture sent as a document, which is how Telegram sends an
      // uncompressed screenshot) the inbound OCR pass.
      if (!isExtractableDoc(seg.name) && !isImageMediaType(seg.mimeType)) continue
    }
    const ref = plan.ref(seg, event)
    if (ref) targets.push({ seg, ref })
  }
  return targets
}

/**
 * Refs whose cached entry is known to be over the inline cap.
 *
 * `connectors_attachment_read` answers `null` both for "not cached" and for
 * "cached, but bigger than `maxBytes`" (`attachments.rs`), so the cache-first
 * short circuit cannot fire for an over-cap file: every later message naming it
 * would pay `plan.source` again — a `getFile` round trip on Telegram, a keyring
 * read on Lark and Slack — to re-request a file whose bytes are already on disk
 * and will be discarded again. Remembering the verdict is what closes that;
 * `fetchAttachment` reports the real `sizeBytes`, so the entry is authoritative
 * the first time.
 *
 * Bounded and process-local: it is an optimisation, and a cold start simply
 * pays the round trip once more.
 */
const OVER_CAP_REFS = new Set<string>()
const OVER_CAP_MEMO_LIMIT = 512

function rememberOverCap(key: string): void {
  if (OVER_CAP_REFS.size >= OVER_CAP_MEMO_LIMIT) {
    // Insertion-ordered, so the oldest goes first.
    OVER_CAP_REFS.delete(OVER_CAP_REFS.values().next().value as string)
  }
  OVER_CAP_REFS.add(key)
}

/** Test seam — the memo outlives a single pass by design. */
export function __resetInboundMediaOverCapMemo(): void {
  OVER_CAP_REFS.clear()
}

/** Media types the OCR pass and the model's vision path can read. */
function isImageMediaType(mimeType: string | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/")
}

/**
 * The media type of these bytes, read from their own magic number.
 *
 * The declared type is the one thing that must not be guessed:
 * `inboundEventToSendContent` passes `mimeType` straight through as the model's
 * `media_type`, and a provider rejects a declared type that disagrees with the
 * payload. Every other source is a guess — OneBot's `segments.ts` names no type
 * at all, and a cache hit never runs `source`, so a redelivered picture would
 * otherwise fall all the way through to a hard-coded default. The bytes are
 * already in hand, so they get the last word.
 */
export function sniffImageMediaType(base64: string): string | undefined {
  let head: string
  try {
    // 16 base64 chars is a whole number of groups and decodes to 12 bytes —
    // enough for every signature below.
    head = atob(base64.slice(0, 16))
  } catch {
    return undefined
  }
  const b = (i: number) => head.charCodeAt(i)
  if (head.length < 3) return undefined
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg"
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return "image/png"
  if (head.startsWith("GIF8")) return "image/gif"
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp"
  if (head.startsWith("BM")) return "image/bmp"
  return undefined
}

/**
 * Second-pass enrichment of an inbound event's media segments. Mutates
 * segments in place. Safe to await in the inbound path — it never throws.
 */
export async function enrichInboundMedia(
  event: NormalizedInboundEvent,
  plan: InboundMediaPlan,
  deps: InboundMediaDeps = {}
): Promise<void> {
  if (!(deps.enabled ?? isTauri())) return

  const targets = targetsOf(event, plan)
  if (targets.length === 0) return

  const fetchAttachment = deps.fetchAttachment ?? connectorsAttachmentFetch
  const readAttachment = deps.readAttachment ?? connectorsAttachmentRead
  const extractDocText = deps.extractDocText ?? defaultExtractor(plan.extractLabel)
  const maxBytes = deps.maxInlineBytes ?? MAX_INLINE_BYTES
  const adapterId = event.adapterId

  for (const { seg, ref } of targets) {
    try {
      const memoKey = `${adapterId}:${ref}`
      // Known over-cap: the bytes are cached and unusable, and `plan.source`
      // would only pay a round trip to learn that again.
      if (OVER_CAP_REFS.has(memoKey)) continue

      let bytes = await readAttachment(adapterId, ref, maxBytes)
      let resolvedMime: string | undefined
      if (!bytes) {
        const source = await plan.source(seg, event)
        if (!source) continue
        // The floor every plan passes through — see `isPublicHttpUrl`.
        if (!isPublicHttpUrl(source.url) && !plan.allowPrivateHost?.(source.url)) continue
        resolvedMime = source.mimeType
        const stored = await fetchAttachment(adapterId, ref, source.url, source.headers)
        // The fetch reports the real size, which is the only place the two
        // meanings of a `null` read are distinguishable. Record it and skip the
        // read that would answer `null` again.
        if (stored && stored.sizeBytes > maxBytes) {
          rememberOverCap(memoKey)
          continue
        }
        bytes = await readAttachment(adapterId, ref, maxBytes)
      }
      // The fetch stored nothing usable — keep the marker.
      if (!bytes) continue

      // The bytes decide the media type; every other source is a guess. See
      // `sniffImageMediaType`.
      const mimeOf = (declared: string | undefined) =>
        sniffImageMediaType(bytes) ??
        declared ??
        resolvedMime ??
        plan.defaultImageMime ??
        "image/png"

      if (seg.type === "image") {
        const img = seg as InlineImageSegment
        img.dataBase64 = bytes
        img.mimeType = mimeOf(img.mimeType)
        continue
      }

      // A picture sent as a document. It has no text to extract — its bytes go
      // to the inbound OCR pass, which writes `ocrText`, the field
      // `inboundEventToSendContent` already renders under `[file: <name>]`.
      if (isImageMediaType(seg.mimeType)) {
        seg.dataBase64 = bytes
        seg.mimeType = mimeOf(seg.mimeType)
        continue
      }

      const text = await extractDocText(base64ToArrayBuffer(bytes), seg.name).catch(() => "")
      if (text.trim()) seg.ocrText = text.trim()
    } catch {
      // Per-segment best-effort: one unreadable attachment must not cost the
      // others, and never the message.
    }
  }
}
