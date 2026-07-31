/**
 * Format staged context selections into a block prepended to the outgoing chat
 * message, so the assistant sees the exact material the user pointed at plus
 * their comment. Pure + framework-free for easy testing.
 *
 * Four kinds share this pipeline (artifact / file / comment / web). Each gets
 * its own heading so the assistant can tell a snippet it may be asked to revise
 * from a page it may only cite — the artifact heading is load-bearing for that
 * reason, not decoration.
 */

import type {
  ArtifactSelectionRef,
  ContextSelectionRef,
  FileSelectionRef,
} from "@/types/artifact/artifact"
import type { ContextCommentAnchor } from "@/types/context-comment"

/** `12-18`, or a bare `12` when the range covers a single line. */
function rangeLabel(range: { startLine: number; endLine: number }): string {
  return range.endLine > range.startLine
    ? `${range.startLine}-${range.endLine}`
    : `${range.startLine}`
}

/**
 * How a comment's anchor reads inside the prompt heading above.
 *
 * English on purpose, like every other string in this file: it is prompt
 * scaffolding for the assistant, not UI copy, so it must not follow the user's
 * locale. It lives here rather than in the comments panel for exactly that
 * reason — in a `.tsx` it read as an untranslated interface string, and it had
 * grown its own copy of the line-range formatting `rangeLabel` already owns.
 *
 * Offsets mean nothing to the assistant on their own, so a text range prefers
 * line numbers and otherwise names the quoted text instead of raw positions.
 */
export function commentAnchorLabel(anchor: ContextCommentAnchor): string | undefined {
  switch (anchor.kind) {
    case "text-range":
      if (anchor.lineRange) {
        const { startLine, endLine } = anchor.lineRange
        return endLine > startLine
          ? `lines ${rangeLabel(anchor.lineRange)}`
          : `line ${rangeLabel(anchor.lineRange)}`
      }
      return anchor.quotedText ? `on "${anchor.quotedText}"` : undefined
    case "workflow-node":
      return `node ${anchor.nodeId}`
    case "workflow-edge":
      return `edge ${anchor.edgeId}`
    case "resource":
      return undefined
  }
}

function headingFor(sel: ContextSelectionRef): string {
  switch (sel.kind) {
    case "artifact":
      return `Selection from artifact "${sel.title}" (lines ${rangeLabel(sel.range)}):`
    case "file":
      return sel.range
        ? `Selection from file "${sel.relPath}" (lines ${rangeLabel(sel.range)}):`
        : `File "${sel.relPath}":`
    case "comment":
      return sel.anchorLabel
        ? `Comment on "${sel.title}" (${sel.anchorLabel}):`
        : `Comment on "${sel.title}":`
    case "web":
      return `From the page "${sel.title}" (${sel.url}):`
    case "external": {
      const sourceTitle = sel.sourceTitle ? `, window "${sel.sourceTitle}"` : ""
      const truncation = sel.truncated ? " (truncated to 20,000 characters)" : ""
      return `Selection from app "${sel.sourceApp}"${sourceTitle}${truncation}:`
    }
  }
}

function formatOne(sel: ContextSelectionRef): string {
  const lines = [headingFor(sel), "```", sel.snapshot, "```"]
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
 * document is `1 … <line count>`, and `rangeLabel` above collapses the label to
 * a single number when the two are equal — which a one-line artifact must hit.
 */
export function wholeArtifactSelection(artifact: {
  id: string
  title: string
  content: string
}): ArtifactSelectionRef {
  return {
    kind: "artifact",
    artifactId: artifact.id,
    title: artifact.title,
    snapshot: artifact.content,
    comment: "",
    range: { startLine: 1, endLine: artifact.content.split("\n").length },
  }
}

/**
 * The whole-file counterpart, staged by the dock's workspace panel.
 *
 * No range, deliberately: "this file" is a different statement from "lines
 * 1..N of this file", and collapsing the two would make the chip claim a
 * hand-picked excerpt. `range` stays optional on `FileSelectionRef` so a diff
 * hunk can carry one.
 */
export function wholeFileSelection(file: {
  relPath: string
  content: string
  title?: string
}): FileSelectionRef {
  return {
    kind: "file",
    relPath: file.relPath,
    title: file.title ?? file.relPath.split("/").pop() ?? file.relPath,
    snapshot: file.content,
    comment: "",
  }
}

/**
 * Returns a markdown context block, or an empty string when there are no
 * selections (so callers can prepend unconditionally without adding noise).
 */
export function formatContextSelectionsForLLM(selections: ContextSelectionRef[]): string {
  if (selections.length === 0) {
    return ""
  }
  return ["Referenced context:", ...selections.map(formatOne)].join("\n\n")
}
