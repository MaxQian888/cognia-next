/**
 * Format staged artifact selections into a context block prepended to the
 * outgoing chat message, so the assistant sees the exact snippet the user wants
 * changed plus their comment. Pure + framework-free for easy testing.
 */

import type { ArtifactSelectionRef } from "@/types/artifact/artifact"

function formatOne(sel: ArtifactSelectionRef): string {
  const rangeLabel =
    sel.range.endLine > sel.range.startLine
      ? `${sel.range.startLine}-${sel.range.endLine}`
      : `${sel.range.startLine}`
  const lines = [
    `Selection from artifact "${sel.title}" (lines ${rangeLabel}):`,
    "```",
    sel.snapshot,
    "```",
  ]
  if (sel.comment.trim()) {
    lines.push(`Comment: ${sel.comment.trim()}`)
  }
  return lines.join("\n")
}

/**
 * Returns a markdown context block, or an empty string when there are no
 * selections (so callers can prepend unconditionally without adding noise).
 */
export function formatArtifactSelectionsForLLM(selections: ArtifactSelectionRef[]): string {
  if (selections.length === 0) {
    return ""
  }
  return ["Referenced artifact selections:", ...selections.map(formatOne)].join("\n\n")
}
