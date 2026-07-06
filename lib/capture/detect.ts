/**
 * Capture kind detection + candidate building. Pure (crypto via Web Crypto).
 */

import { sha256String } from "@/lib/ocr/hash"
import type { CaptureCandidate, CaptureKind } from "@/types/capture"

const URL_RE = /^https?:\/\/[^\s]+$/i

export function detectKind(text: string): CaptureKind {
  return URL_RE.test(text.trim()) ? "url" : "text"
}

/**
 * Build a text/url candidate from clipboard text. Returns null for empty text.
 * The fingerprint (SHA-256 of the trimmed text) is the dedup key.
 */
export async function buildTextCandidate(
  text: string,
  sourceApp?: string
): Promise<CaptureCandidate | null> {
  const trimmed = text.trim()
  if (!trimmed) return null
  const kind = detectKind(trimmed)
  const fingerprint = await sha256String(trimmed)
  return {
    kind,
    text: trimmed,
    ...(kind === "url" ? { sourceUrl: trimmed } : {}),
    ...(sourceApp ? { sourceApp } : {}),
    fingerprint,
  }
}
