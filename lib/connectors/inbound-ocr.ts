/**
 * Eager, quality-gated OCR of inbound platform-connector images (ADR-0024).
 *
 * Runs in the inbound dispatch pipeline (`ConnectorBus.dispatchInboundFull`)
 * right after dedup, so the extracted text is available to trigger matching,
 * the stored message, the live agent prompt, and the digest turn — instead of
 * the image collapsing to a bare `[image]` placeholder.
 *
 * Byte source: the inline `dataBase64` some adapters (WeChat / WeCom …) attach
 * to inbound image segments. Images that arrive as a bare URL / platform key
 * have no in-renderer plaintext bytes (the attachment cache stores them
 * encrypted on disk) and are skipped — extraction is best-effort and NEVER
 * blocks message delivery.
 *
 * No new PII gate: inbound OCR text is equivalent to inbound user text (which
 * isn't redacted today). Outbound leak protection stays the existing
 * `safeSendPrompt` gate, which scans every prompt text block — including the
 * injected `ocrText` — before any auto-reply leaves the device.
 */

import { extract as defaultExtract } from "@/lib/ocr"
import type { ExtractDeps } from "@/lib/ocr"
import { buildOcrDeps } from "@/lib/ocr/deps"
import { getSettings } from "@/lib/db/settings"
import { DEFAULT_OCR_SETTINGS, type OcrInput, type OcrResult } from "@/types/ocr"
import type { MessageSegment } from "@/types/connectors/segment"
import { appendAudit } from "./audit"

/** Image segment widened with the inline byte fields adapters attach. */
type InboundImageSegment = Extract<MessageSegment, { type: "image" }> & {
  dataBase64?: string
  mimeType?: string
}

/**
 * Segments this pass can read: an `image`, and a `file` whose declared type is
 * an image.
 *
 * The second one is not a curiosity — a picture sent as a document is how
 * Telegram sends an uncompressed screenshot, i.e. exactly the picture the
 * sender wanted read accurately. It reaches `inboundEventToSendContent` as
 * `[file: <name>]`, so without OCR the model is told a file arrived and nothing
 * about what is in it. The inbound rich-media pass attaches the bytes for both.
 */
type OcrableSegment = InboundImageSegment | Extract<MessageSegment, { type: "file" }>

function ocrable(seg: MessageSegment): OcrableSegment | undefined {
  if (seg.type === "image") return seg as InboundImageSegment
  if (seg.type === "file" && seg.mimeType.toLowerCase().startsWith("image/")) return seg
  return undefined
}

export interface InboundOcrDeps {
  /** Master switch — `UserOcrSettings.ocrInboundImages !== false`. */
  enabled: boolean
  extract: (input: OcrInput, deps: ExtractDeps) => Promise<OcrResult>
  ocrDeps: ExtractDeps
  /** Optional failure sink — fired when extraction throws, so a silently
   * dropped image's OCR failure is traceable instead of invisible. The
   * extractor still best-effort-ignores the error (delivery never blocks). */
  onError?: (info: { error: unknown }) => void
}

/**
 * True when at least one segment is an image carrying inline bytes
 * (`dataBase64`) — the only case `runInboundOcr` does any work. Lets the
 * inbound pipeline skip the settings read + OCR-dep build entirely for the
 * common text-only / URL-only message (an image that arrives as a bare URL /
 * platform key has no inline bytes and is skipped by `maybeOcrInboundSegments`
 * anyway).
 */
export function hasOcrableInboundImage(segments: MessageSegment[]): boolean {
  return segments.some((seg) => {
    const b64 = ocrable(seg)?.dataBase64
    return typeof b64 === "string" && b64.length > 0
  })
}

/**
 * Mutate image segments in place, attaching `ocrText` when extraction
 * succeeds. Pure w.r.t. its injected deps so it's unit-testable without the
 * keyring / Dexie / a real provider.
 */
export async function maybeOcrInboundSegments(
  segments: MessageSegment[],
  deps: InboundOcrDeps
): Promise<void> {
  if (!deps.enabled) return
  for (const seg of segments) {
    const img = ocrable(seg)
    if (!img) continue
    if (img.ocrText) continue
    const b64 = img.dataBase64
    if (typeof b64 !== "string" || b64.length === 0) continue
    const mimeType = img.mimeType ?? "image/png"
    try {
      const result = await deps.extract(
        {
          source: { kind: "data-url", dataUrl: `data:${mimeType};base64,${b64}`, mimeType },
        },
        deps.ocrDeps
      )
      const text = result.combinedText.trim()
      if (text.length > 0) img.ocrText = text
    } catch (err) {
      // Best-effort: a provider failure leaves the segment as a plain [image].
      // Surface it via the optional sink so the failure isn't silent.
      deps.onError?.({ error: err })
    }
  }
}

/**
 * Production wrapper: load OCR settings, build real deps, and run the inbound
 * OCR pass over the event's segments. Best-effort — callers should ignore
 * rejections so OCR never blocks the inbound pipeline. Extraction failures
 * are audited as `inbound.ocr_failed` (instead of swallowed silently) when
 * the event carries the audit context.
 */
export async function runInboundOcr(event: {
  segments: MessageSegment[]
  adapterId?: string
  conversationKey?: string
}): Promise<void> {
  let settings = DEFAULT_OCR_SETTINGS
  try {
    settings = (await getSettings()).ocrSettings ?? DEFAULT_OCR_SETTINGS
  } catch {
    // Dexie unavailable — fall back to defaults (inbound OCR on).
  }
  const adapterId = event.adapterId
  const conversationKey = event.conversationKey
  await maybeOcrInboundSegments(event.segments, {
    enabled: settings.ocrInboundImages !== false,
    extract: defaultExtract,
    ocrDeps: buildOcrDeps({ settings }),
    onError:
      adapterId != null
        ? ({ error }) => {
            void appendAudit({
              adapterId,
              kind: "inbound.ocr_failed",
              at: Date.now(),
              ...(conversationKey != null ? { conversationKey } : {}),
              reason: "ocr_extract_threw",
              message: error instanceof Error ? error.message : String(error),
            })
          }
        : undefined,
  })
}
