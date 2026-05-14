/**
 * Google Gemini (Bard) export importer.
 *
 * Gemini conversations land inside a Google Takeout archive under
 * `My Activity/Gemini/MyActivity.json`. Each entry is a single user
 * prompt + the model response, with the prompt under `title` (e.g.
 * "Asked Gemini …") and the body inside the `details` array — Google
 * uses a flat list, NOT a thread tree, so we treat each entry as a
 * two-message block (user + assistant) paired by index.
 *
 * Output: one `RawSource` for the whole activity log (consecutive
 * entries represent independent prompts; we still keep them together so
 * the embedder sees user voice + Gemini response in context). Caller can
 * always upload smaller files for finer granularity.
 */

import type { RawSource } from "@/lib/twin/ingest/parse"
import { conversationToRawSource, type ChatImporterOptions, type ChatMessageBlock } from "./types"

interface RawDetail {
  text?: string
  name?: string
  url?: string
}

interface RawEntry {
  header?: string
  title?: string
  titleUrl?: string
  time?: string
  products?: string[]
  details?: RawDetail[]
  subtitles?: Array<{ name?: string }>
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function stripPromptPrefix(title: string): string {
  const m = /^([\p{L}\s']{0,40}?:\s*)?(.*)$/u.exec(title.trim())
  return m?.[2]?.trim() || title.trim()
}

function extractResponse(entry: RawEntry): string {
  if (Array.isArray(entry.details)) {
    for (const detail of entry.details) {
      if (typeof detail.text === "string" && detail.text.trim()) return detail.text.trim()
    }
  }
  if (Array.isArray(entry.subtitles)) {
    for (const sub of entry.subtitles) {
      if (typeof sub.name === "string" && sub.name.trim()) return sub.name.trim()
    }
  }
  return ""
}

export function isGeminiExportShape(value: unknown): boolean {
  if (!value) return false
  const sample = Array.isArray(value) ? value[0] : value
  if (!sample || typeof sample !== "object") return false
  const obj = sample as { products?: unknown; header?: unknown; title?: unknown }
  if (Array.isArray(obj.products) && obj.products.some((p) => /gemini|bard/i.test(String(p)))) {
    return true
  }
  // Older Takeout exports lack `products` but mark the header as "Gemini" /
  // "Bard"; that's a softer signal but useful for the uploader's auto-pick.
  const header = typeof obj.header === "string" ? obj.header : ""
  if (/gemini|bard/i.test(header)) return true
  return false
}

export function parseGeminiExport(text: string, opts: ChatImporterOptions): RawSource[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as RawEntry | RawEntry[]
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const blocks: ChatMessageBlock[] = []
  for (const entry of entries) {
    if (Array.isArray(entry.products) && !entry.products.some((p) => /gemini|bard/i.test(p))) {
      continue
    }
    const promptRaw = entry.title?.trim()
    if (promptRaw) {
      blocks.push({
        speaker: "User",
        timestamp: parseTimestamp(entry.time),
        text: stripPromptPrefix(promptRaw),
      })
    }
    const response = extractResponse(entry)
    if (response) {
      blocks.push({
        speaker: "Gemini",
        timestamp: parseTimestamp(entry.time),
        text: response,
      })
    }
  }
  const raw = conversationToRawSource({
    twinId: opts.twinId,
    title: opts.source || "Gemini activity",
    blocks,
    label: "gemini",
    extraMetadata: { platform: "gemini" },
  })
  return raw ? [raw] : []
}
