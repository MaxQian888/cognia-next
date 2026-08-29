/**
 * Turning a chosen candidate back into text.
 *
 * Small enough to be tempting to inline at the call site, and exactly the wrong
 * thing to inline: the trailing-space rule is the difference between completion
 * that flows and completion you have to clean up after. A directory must NOT
 * get a space (the next thing you type is inside it), a file MUST (the next
 * thing you type is the next argument), and neither may double a space that is
 * already there.
 */

import type { ShellCompletion } from "./types"

export interface AppliedCompletion {
  line: string
  cursor: number
}

/**
 * Splice `completion` into `line`, returning the new line and where the caret
 * should land.
 *
 * The replaced span comes from the completion itself rather than being
 * recomputed here, so a candidate built against an older line cannot silently
 * overwrite the wrong characters — the caller compares spans if it needs to.
 */
export function applyShellCompletion(line: string, completion: ShellCompletion): AppliedCompletion {
  const before = line.slice(0, completion.from)
  const after = line.slice(completion.to)
  // A directory (or any candidate that asks to continue) keeps the caret tight
  // against the separator so the next path segment completes immediately.
  const wantsSpace = !completion.continues && !after.startsWith(" ") && !after.startsWith("\t")
  const insert = wantsSpace ? `${completion.insertText} ` : completion.insertText
  return { line: before + insert + after, cursor: before.length + insert.length }
}
