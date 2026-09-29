/**
 * Extractive compaction — shrink a cold episodic memory to what stays useful
 * without an LLM: a one-paragraph summary plus the durable tokens a later
 * question is most likely to hinge on (file paths, error codes, identifiers,
 * URLs). Ported from ai-memory's `compaction.rs` + `keep_tokens.rs`.
 *
 * Reversible by construction: the caller writes the result through the
 * revision path, so the full pre-compaction text stays in the memory's history
 * and one click restores it. The row gets `compactedAt` and is never compacted
 * again.
 *
 * Pure — no I/O.
 */

/** Summary cap, in UTF-8 bytes (cut on a character boundary). */
export const MAX_SUMMARY_BYTES = 500
/** Most durable tokens retained per memory. */
export const MAX_KEEP_TOKENS = 48
const MIN_TOKEN_BYTES = 2
const MAX_TOKEN_BYTES = 128

/**
 * Token classes in priority order — higher-signal classes first, so when the
 * budget runs out it is the generic identifiers that are dropped, not the file
 * paths. First occurrence wins; duplicates across classes are kept once.
 */
const KEEP_TOKEN_PATTERNS: readonly { pattern: RegExp; group?: number }[] = [
  // URLs
  { pattern: /https?:\/\/[^\s<>()[\]"'`]+/g },
  // Paths with an extension
  { pattern: /\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+\b/g },
  // Bare filenames with a known source/config extension
  {
    pattern:
      /\b[A-Za-z0-9_.-]+\.(?:rs|md|mdx|toml|sql|json|ya?ml|sh|py|js|mjs|cjs|ts|tsx|jsx|rb|go|c|h|cc|cpp|hpp|txt|lock|cfg|ini|env|xml|html|css|proto)\b/g,
  },
  // Compiler-style error codes (E0433, TS2556 is caught by the constant class)
  { pattern: /\bE\d{2,4}\b/g },
  // HTTP status codes
  { pattern: /\bHTTP\s?\d{3}\b/g },
  // Inline code spans
  { pattern: /`([^`\n]{1,120})`/g, group: 1 },
  // UPPER_SNAKE constants / env vars
  { pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g },
  // snake_case / camelCase identifiers
  { pattern: /\b(?:[a-z][a-z0-9]*_[a-z0-9_]+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)\b/g },
]

const EDGE_CHARS = /^[.,;:)("'<>`]+|[.,;:)("'<>`]+$/g

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes on a character boundary,
 * appending `…` when cut. A budget too small for the 3-byte ellipsis itself
 * cuts without one, so the result never exceeds `maxBytes`.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text
  const fitsEllipsis = maxBytes >= utf8Length("…")
  const ellipsis = fitsEllipsis ? "…" : ""
  const budget = Math.max(0, maxBytes - utf8Length(ellipsis))
  let used = 0
  let out = ""
  for (const char of text) {
    const size = utf8Length(char)
    if (used + size > budget) break
    out += char
    used += size
  }
  return `${out.trimEnd()}${ellipsis}`
}

/** Durable tokens in priority order, deduped, capped at {@link MAX_KEEP_TOKENS}. */
export function mineKeepTokens(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const { pattern, group } of KEEP_TOKEN_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const raw = group !== undefined ? match[group] : match[0]
      if (!raw) continue
      const token = raw.replace(EDGE_CHARS, "")
      const size = utf8Length(token)
      if (size < MIN_TOKEN_BYTES || size > MAX_TOKEN_BYTES || seen.has(token)) continue
      seen.add(token)
      out.push(token)
      if (out.length >= MAX_KEEP_TOKENS) return out
    }
  }
  return out
}

/**
 * The summary line: the first non-heading paragraph, whitespace-collapsed and
 * capped at {@link MAX_SUMMARY_BYTES}.
 */
export function summaryLine(text: string): string {
  const paragraph =
    text
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block.length > 0 && !block.startsWith("#")) ?? ""
  return truncateUtf8(paragraph.replace(/\s+/g, " ").trim(), MAX_SUMMARY_BYTES)
}

export interface CompactionResult {
  text: string
  summary: string
  keepTokens: string[]
}

/**
 * Compact `text`, or return `null` when compaction would not shrink it — a
 * short single statement is already its own summary, and rewriting it would
 * only add a revision with no benefit. `force` skips that check; the dedup
 * merge uses it, because a survivor must absorb its duplicates' durable tokens
 * even when the merged text ends up no shorter than the survivor alone.
 *
 * Tokens already present verbatim in the summary are not repeated.
 */
export function compactMemoryText(
  text: string,
  options: { force?: boolean } = {}
): CompactionResult | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const summary = summaryLine(trimmed)
  const keepTokens = mineKeepTokens(trimmed).filter((token) => !summary.includes(token))
  const compacted = keepTokens.length
    ? `${summary}\nRetained facts: ${keepTokens.map((token) => `\`${token}\``).join(", ")}`
    : summary
  if (!summary) return null
  if (!options.force && utf8Length(compacted) >= utf8Length(trimmed)) return null
  return { text: compacted, summary, keepTokens }
}
