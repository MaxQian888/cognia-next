// Manage a single self-contained marker block in `.gitignore` so git ignores the
// cloned dependency source while keeping the manifest tracked. Pure string ops —
// `clone.mjs` does the file read/write. Idempotent: applying twice is a no-op.

export const MARKER_START = "# >>> cognia clonedeps (managed) >>>"
export const MARKER_END = "# <<< cognia clonedeps (managed) <<<"

/**
 * Ensure `.gitignore` content contains the managed block with exactly the given
 * ignore lines. Replaces an existing managed block in place; appends one when
 * absent. Returns the (possibly unchanged) full file content.
 * @param {string} existing  Current .gitignore content ("" when the file is new).
 * @param {string[]} ignoreLines  Patterns to ignore inside the managed block.
 * @returns {string}
 */
export function applyMarkerBlock(existing, ignoreLines) {
  const content = typeof existing === "string" ? existing : ""
  const block = [MARKER_START, ...ignoreLines, MARKER_END].join("\n")

  const startIdx = content.indexOf(MARKER_START)
  const endIdx = content.indexOf(MARKER_END)
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = content.slice(0, startIdx)
    const after = content.slice(endIdx + MARKER_END.length)
    const next = `${before}${block}${after}`
    return next === content ? content : next
  }

  // Append, ensuring a clean separating newline.
  if (content.length === 0) return `${block}\n`
  const sep = content.endsWith("\n") ? "" : "\n"
  return `${content}${sep}\n${block}\n`
}

/** True when `existing` already contains the managed block with these lines. */
export function hasMarkerBlock(existing, ignoreLines) {
  return applyMarkerBlock(existing, ignoreLines) === existing
}
