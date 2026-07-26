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
 * The selection that means "all of it" — what "Reference in chat" stages when
 * the user picked a whole artifact rather than a range inside one.
 *
 * Lives here rather than at the call site because the range convention is not
 * self-evident: `startLine` is 1-based and `endLine` is inclusive, so the whole
 * document is `1 … <line count>`, and `formatOne` above collapses the label to a
 * single number when the two are equal — which a one-line artifact must hit.
 */
export function wholeArtifactSelection(artifact: {
  id: string
  title: string
  content: string
}): ArtifactSelectionRef {
  return {
    artifactId: artifact.id,
    title: artifact.title,
    snapshot: artifact.content,
    comment: "",
    range: { startLine: 1, endLine: artifact.content.split("\n").length },
  }
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
