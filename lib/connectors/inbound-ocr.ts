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

/** Image segment widened with the inline byte fields adapters attach. */
type InboundImageSegment = Extract<MessageSegment, { type: "image" }> & {
  dataBase64?: string
  mimeType?: string
}

export interface InboundOcrDeps {
  /** Master switch — `UserOcrSettings.ocrInboundImages !== false`. */
  enabled: boolean
  extract: (input: OcrInput, deps: ExtractDeps) => Promise<OcrResult>
  ocrDeps: ExtractDeps
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
    if (seg.type !== "image") continue
    const img = seg as InboundImageSegment
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
    } catch {
      // Best-effort: a provider failure leaves the segment as a plain [image].
    }
  }
}

/**
 * Production wrapper: load OCR settings, build real deps, and run the inbound
 * OCR pass over the event's segments. Best-effort — callers should ignore
 * rejections so OCR never blocks the inbound pipeline.
 */
export async function runInboundOcr(event: { segments: MessageSegment[] }): Promise<void> {
  let settings = DEFAULT_OCR_SETTINGS
  try {
    settings = (await getSettings()).ocrSettings ?? DEFAULT_OCR_SETTINGS
  } catch {
    // Dexie unavailable — fall back to defaults (inbound OCR on).
  }
  await maybeOcrInboundSegments(event.segments, {
    enabled: settings.ocrInboundImages !== false,
    extract: defaultExtract,
    ocrDeps: buildOcrDeps({ settings }),
  })
}
