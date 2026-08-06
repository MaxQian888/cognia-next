/**
 * Smart content preview for instant title display.
 *
 * `contentPreview` in `lib/claude/adapter.ts` slices the first N characters
 * of any text content — good enough for prose, but terrible for messages
 * that start with code fences, JSON objects, or markdown headings followed
 * by code. This module extracts the first natural-language fragment by
 * skipping leading non-prose blocks, producing a human-readable placeholder
 * until the LLM title generation completes (or retries).
 */

import type { SendContent, SendContentBlock } from "@cognia/agent-config-types"

/**
 * Regex matching the opening line of a fenced code block.
 * Captures optional language tag; the closing fence is just ```.
 */
const OPENING_FENCE_RE = /^```[^\n]*\n/

/**
 * Extract plain text from SendContent (string or text-part array).
 * Same logic as `contentPreview` in `lib/claude/adapter.ts` but without
 * truncation — the caller truncates after smart extraction.
 */
function extractText(content: SendContent): string {
  if (typeof content === "string") return content
  return content
    .filter((b): b is Extract<SendContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ")
}

/**
 * Skip a leading fenced code block (```...```). Returns the text after the
 * closing fence, or the original text if no opening fence is found or the
 * fence isn't closed within the first 2000 characters.
 */
function skipLeadingCodeFence(text: string): string {
  const match = OPENING_FENCE_RE.exec(text)
  if (!match) return text

  // Find the closing fence — it must be ``` at the start of a line.
  const afterOpen = text.slice(match[0].length)
  const closeIdx = afterOpen.indexOf("\n```")
  if (closeIdx < 0 || closeIdx > 2000) return text

  // Skip past the closing fence line.
  const afterClose = afterOpen.slice(closeIdx + 4)
  // Advance past the fence's trailing newline (if present).
  return afterClose.startsWith("\n") ? afterClose.slice(1) : afterClose
}

/**
 * Skip a leading JSON object `{...}` or array `[...]`. Uses simple brace/
 * bracket depth counting — no full JSON parser. Returns the text after the
 * matched block, or the original text if no balanced block is found within
 * 500 characters.
 */
function skipLeadingJson(text: string): string {
  const first = text[0]
  if (first !== "{" && first !== "[") return text

  const close = first === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  let escaped = false
  const limit = Math.min(text.length, 500)

  for (let i = 0; i < limit; i++) {
    const ch = text[i]

    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === first) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) {
        // Found the matching close — return everything after it.
        return text.slice(i + 1)
      }
    }
  }

  // No balanced close within limit — not JSON, return original.
  return text
}

/**
 * Extract the first natural-language sentence (up to `max` characters).
 * A sentence ends at `.` `!` `?` `。` `！` `？` followed by whitespace or
 * end-of-string, or at the first newline — whichever comes first.
 */
function extractFirstSentence(text: string, max: number): string {
  const capped = text.slice(0, max + 20) // slight overread for punctuation
  // Try to find a sentence boundary.
  const sentenceEnd = capped.search(/[.!?。！？]\s|[.!?。！？]$|\n/)
  if (sentenceEnd > 0 && sentenceEnd <= max) {
    return text.slice(0, sentenceEnd + 1).trim()
  }
  // No sentence boundary — just truncate.
  if (text.length > max) return text.slice(0, max).trim()
  return text.trim()
}

/**
 * Smart content preview for instant title display. Skips leading code fences
 * and JSON blocks, extracting the first natural-language sentence.
 *
 * Falls back to simple truncation (matching `contentPreview` behavior) when
 * no natural-language text is found after skipping.
 *
 * @param content - The message content (string or part array).
 * @param max - Maximum preview length in characters. Defaults to 40.
 */
export function smartContentPreview(content: SendContent, max = 40): string {
  const raw = extractText(content)
  if (!raw.trim()) return ""

  // Attempt to skip non-prose leading content.
  let text = raw.trimStart()

  // Skip a leading code fence.
  text = skipLeadingCodeFence(text)
  text = text.trimStart()

  // Skip a leading JSON object/array.
  text = skipLeadingJson(text)
  text = text.trimStart()

  // If we still have nothing useful after skipping, fall back to raw.
  if (!text) text = raw.trim()

  const preview = extractFirstSentence(text, max)
  if (!preview) {
    // Ultimate fallback — simple slice of the raw content.
    return raw.length > max ? raw.slice(0, max) + "…" : raw
  }

  // Add ellipsis if we truncated.
  if (preview.length < text.trim().length && preview.length >= max) {
    return preview + "…"
  }
  return preview
}
