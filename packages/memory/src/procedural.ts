/**
 * Procedural memory assembly — turn active procedural memories into a single
 * capped system-prompt instruction block (≈ a product-level CLAUDE.md the agent
 * grows for itself).
 *
 * Token budgeting reuses `DynamicContextManager.estimateTokens` (`lib/ai/rag/
 * context-manager.ts`) rather than a bespoke counter. Highest-importance, then
 * most-recently-accessed memories win the budget. Pure — no I/O.
 *
 * Security: only memories the caller already trusts reach here. Procedural rows
 * are never auto-extracted from connector-inbound content (see the consolidator
 * + `run-memory-extraction` provenance gate), so this block can't be poisoned by
 * a third party.
 */

import type { Memory } from "./types/memory"
import { createContextManager } from "@cognia/rag/context-manager"

export interface AssembleProceduralOptions {
  /** Max tokens the block may consume. Default 600. */
  maxTokens?: number
  /** Section heading. Default "## Working preferences you've learned". */
  heading?: string
}

const DEFAULT_MAX_TOKENS = 600
const DEFAULT_HEADING = "## Working preferences you've learned"

/**
 * Returns a formatted instruction block, or `null` when there are no procedural
 * memories (so callers can skip injecting an empty heading).
 */
export function assembleProceduralBlock(
  memories: Memory[],
  options: AssembleProceduralOptions = {}
): string | null {
  return assembleProceduralContext(memories, options).text
}

/** Exact rows that fit, for delivery receipts and multiline-safe counts. */
export function assembleProceduralContext(
  memories: Memory[],
  options: AssembleProceduralOptions = {}
): { text: string | null; memories: Memory[] } {
  const procedural = memories.filter((m) => m.type === "procedural" && m.status === "active")
  if (procedural.length === 0) return { text: null, memories: [] }

  const heading = options.heading ?? DEFAULT_HEADING
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const ctx = createContextManager({ maxTokens })

  // Pinned first, then importance desc, then most-recently-accessed.
  const ordered = [...procedural].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (b.importance !== a.importance) return b.importance - a.importance
    return b.lastAccessedAt - a.lastAccessedAt
  })

  const lines: string[] = []
  const selected: Memory[] = []
  for (const m of ordered) {
    const line = `- ${m.text}`
    if (ctx.estimateTokens(`${heading}\n${[...lines, line].join("\n")}`) > maxTokens) continue
    lines.push(line)
    selected.push(m)
  }

  if (lines.length === 0) return { text: null, memories: [] }
  return { text: `${heading}\n${lines.join("\n")}`, memories: selected }
}
