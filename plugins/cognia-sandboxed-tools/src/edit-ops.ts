/**
 * Pure, renderer-safe file-edit operations for the sandboxed file tools.
 *
 * The Node sidecar's `sidecar/builtin-tools/core/edit.mjs` is filesystem-
 * coupled and cannot be imported into this renderer-side plugin, so the
 * literal str-replace / insert logic lives here as pure string transforms.
 * The actual disk read + write are performed inside the OS sandbox by
 * `index.ts`; these functions only compute the new file content in memory.
 *
 * Semantics mirror the Anthropic Edit / text_editor tools:
 *   - `str_replace` requires `oldStr` to occur exactly once unless
 *     `replaceAll` is set (matches the Edit tool's uniqueness guard).
 *   - `insert` places `text` AFTER line `line` (1-based; 0 = file start),
 *     matching text_editor's `insert_line` semantics.
 */

/** Thrown when an edit cannot be applied (no match / ambiguous match). */
export class EditOpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EditOpError"
  }
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    count += 1
    from = idx + needle.length
  }
  return count
}

/**
 * Apply a literal string replacement. Throws `EditOpError` when `oldStr`
 * is empty, is not found, or (without `replaceAll`) occurs more than once.
 */
export function applyStrReplace(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll = false
): string {
  if (oldStr.length === 0) {
    throw new EditOpError("oldString must not be empty")
  }
  const occurrences = countOccurrences(content, oldStr)
  if (occurrences === 0) {
    throw new EditOpError("oldString not found in file")
  }
  if (!replaceAll && occurrences > 1) {
    throw new EditOpError(
      `oldString is not unique (${occurrences} occurrences); pass replaceAll or add more context`
    )
  }
  if (replaceAll) {
    return content.split(oldStr).join(newStr)
  }
  const idx = content.indexOf(oldStr)
  return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length)
}

/**
 * Insert `text` after 1-based `line` (0 = before the first line). Throws
 * `EditOpError` when `line` is negative or beyond the end of the file.
 * A trailing newline is added to the inserted block if missing so the
 * following line stays on its own row.
 */
export function applyInsert(content: string, line: number, text: string): string {
  if (!Number.isInteger(line) || line < 0) {
    throw new EditOpError(`insert line must be a non-negative integer, got ${line}`)
  }
  // Split preserving the structure: a file with N "\n" has N+1 segments.
  const lines = content.length === 0 ? [] : content.split("\n")
  if (line > lines.length) {
    throw new EditOpError(`insert line ${line} is beyond end of file (${lines.length} lines)`)
  }
  const block = text.endsWith("\n") ? text.slice(0, -1) : text
  const insertLines = block.split("\n")
  lines.splice(line, 0, ...insertLines)
  return lines.join("\n")
}

/** Slice 1-based inclusive `[start, end]` lines for a text_editor view. */
export function sliceViewRange(content: string, start: number, end: number): string {
  const lines = content.split("\n")
  const from = Math.max(1, start)
  const to = end < 0 ? lines.length : Math.min(lines.length, end)
  return lines.slice(from - 1, to).join("\n")
}
