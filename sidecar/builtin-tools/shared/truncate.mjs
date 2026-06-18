// Shared output-truncation primitives for built-in tools.
//
// Two distinct, intentionally-different contracts the tools rely on:
//   - headTruncate: keep the HEAD + a trailing "… (truncated)" marker. Used by
//     git (read-only command output) and shell_execute_advanced. The `inclusive`
//     option selects the truncation predicate so both call sites keep their exact
//     boundary behaviour (git: length > max; shell-advanced: length >= max).
//   - tailTruncate: keep the TAIL — the end carries the verdict for shell runs.
//     Used by the core `bash` tool.

/**
 * Keep the first `max` chars; append `marker` when truncated.
 *
 * @param {string} text
 * @param {number} max
 * @param {{ marker?: string, inclusive?: boolean }} [opts]
 *   `inclusive` truncates when `length >= max` (shell-advanced) instead of the
 *   default `length > max` (git).
 * @returns {{ text: string, truncated: boolean }}
 */
export function headTruncate(text, max, { marker = "\n... (truncated)", inclusive = false } = {}) {
  const over = inclusive ? text.length >= max : text.length > max
  if (!over) return { text, truncated: false }
  return { text: text.slice(0, max) + marker, truncated: true }
}

/** Default tail budget — mirrors the core bash tool's MAX_OUTPUT_CHARS. */
export const DEFAULT_TAIL_MAX = 30_000

/**
 * Keep the last `max` chars, prefixed with a dropped-count note when truncated.
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {{ text: string, truncated: boolean }}
 */
export function tailTruncate(text, max = DEFAULT_TAIL_MAX) {
  if (text.length <= max) return { text, truncated: false }
  return {
    text: `… (${text.length - max} earlier characters dropped)\n${text.slice(-max)}`,
    truncated: true,
  }
}
