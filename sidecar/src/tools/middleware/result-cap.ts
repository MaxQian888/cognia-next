// Shared per-tool RESULT cap for built-in tools (Anthropic dispatch path).
//
// The ai-sdk path caps oversized tool outputs during compaction (`src/context/
// tool-result-cap.ts`, driven by `CompressionSettings.maxToolResultTokens`).
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

import { headTruncate } from "../../shared/text/truncate.ts"
import type { ToolDefinition, ToolHandlerExtra, WrappedToolDefinition } from "../kernel/define.ts"

interface ContentBlock {
  type?: unknown
  text?: unknown
  [field: string]: unknown
}

const APPROX_CHARS_PER_TOKEN = 4
const MARKER = "\n... (tool result truncated to fit the context window)"

/**
 * Cap the TEXT content blocks of one MCP `CallToolResult` to `maxChars`, leaving
 * image / non-text blocks and the `isError` flag intact. Returns the same ref
 * when nothing was over budget (no needless allocation on the common path).
 */
export function capToolCallResult(result: unknown, maxChars: number): unknown {
  if (!result || typeof result !== "object") return result
  const blocks = (result as { content?: unknown }).content
  if (!Array.isArray(blocks)) return result
  let changed = false
  const content = (blocks as (ContentBlock | null | undefined)[]).map((block) => {
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
 */
export function wrapHandlerWithResultCap<D extends ToolDefinition>(
  def: D,
  maxChars: number
): WrappedToolDefinition<D> {
  if (!def || typeof def.handler !== "function") return def
  if (!Number.isFinite(maxChars) || maxChars <= 0) return def
  const handler = def.handler
  const wrapped = async (args: unknown, extra?: ToolHandlerExtra): Promise<unknown> => {
    const result = await handler(args, extra)
    return capToolCallResult(result, maxChars)
  }
  return { ...def, handler: wrapped }
}

/**
 * Map a list of tool defs through {@link wrapHandlerWithResultCap}, with the
 * cap given in tokens (≈4 chars/token). Returns the same array reference when
 * the cap is disabled so the common "no cap" path allocates nothing.
 */
export function wrapDefsWithResultCap<D extends ToolDefinition>(
  defs: readonly D[],
  maxToolResultTokens: number | undefined
): readonly WrappedToolDefinition<D>[] {
  if (!Array.isArray(defs)) return defs
  if (typeof maxToolResultTokens !== "number" || maxToolResultTokens <= 0) return defs
  const maxChars = maxToolResultTokens * APPROX_CHARS_PER_TOKEN
  return defs.map((def) => wrapHandlerWithResultCap(def, maxChars))
}
