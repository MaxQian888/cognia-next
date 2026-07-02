// Shared per-tool RESULT cap for built-in tools (Anthropic dispatch path).
//
// The ai-sdk path caps oversized tool outputs during compaction (`dispatch/
// tool-result-cap.mjs`, driven by `CompressionSettings.maxToolResultTokens`).
// The Anthropic path has no equivalent: the Claude Agent SDK calls each tool's
// handler itself and forwards the result verbatim, so a single huge bash/grep/
// read output can bloat the context window uncontrolled. This wraps every
// built-in tool's handler at registration time (parallel to
// `wrapDefsWithReadOnlyTimeout`) and head-truncates each TEXT content block to
// `maxToolResultTokens`. Image / resource blocks are left untouched — truncating
// a base64 image would corrupt it and the TUI's image extractor needs it whole.
//
// Coverage note: this caps only the in-process `cognia-tools` outputs (and any
// tool routed through them). The Anthropic path's NATIVE SDK Bash/Grep/Read are
// the SDK's own tools and are not shaped here — the SDK bounds those itself.

import { headTruncate } from "./shared/truncate.mjs"

const APPROX_CHARS_PER_TOKEN = 4
const MARKER = "\n... (tool result truncated to fit the context window)"

/**
 * Cap the TEXT content blocks of one MCP `CallToolResult` to `maxChars`, leaving
 * image / non-text blocks and the `isError` flag intact. Returns the same ref
 * when nothing was over budget (no needless allocation on the common path).
 *
 * @param {any} result
 * @param {number} maxChars
 */
export function capToolCallResult(result, maxChars) {
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) return result
  let changed = false
  const content = result.content.map((block) => {
    if (!block || block.type !== "text" || typeof block.text !== "string") return block
    const { text, truncated } = headTruncate(block.text, maxChars, { marker: MARKER })
    if (!truncated) return block
    changed = true
    return { ...block, text }
  })
  return changed ? { ...result, content } : result
}

/**
 * Wrap ONE tool def's handler so its returned `CallToolResult` text blocks are
 * capped. Returns a NEW def (never mutates). A non-positive / non-finite cap
 * disables it (returns the def untouched).
 *
 * @param {{ name: string, handler: Function }} def
 * @param {number} maxChars
 */
export function wrapHandlerWithResultCap(def, maxChars) {
  if (!def || typeof def.handler !== "function") return def
  if (!Number.isFinite(maxChars) || maxChars <= 0) return def
  const handler = def.handler
  const wrapped = async (args, extra) => {
    const result = await handler(args, extra)
    return capToolCallResult(result, maxChars)
  }
  return { ...def, handler: wrapped }
}

/**
 * Map a list of tool defs through {@link wrapHandlerWithResultCap}. Returns the
 * same array reference when the cap is disabled so the common "no cap" path
 * allocates nothing.
 *
 * @param {Array<{ name: string, handler: Function }>} defs
 * @param {number} [maxToolResultTokens]  cap in tokens (≈4 chars/token)
 */
export function wrapDefsWithResultCap(defs, maxToolResultTokens) {
  if (!Array.isArray(defs)) return defs
  if (typeof maxToolResultTokens !== "number" || maxToolResultTokens <= 0) return defs
  const maxChars = maxToolResultTokens * APPROX_CHARS_PER_TOKEN
  return defs.map((def) => wrapHandlerWithResultCap(def, maxChars))
}
