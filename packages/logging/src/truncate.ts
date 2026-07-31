/**
 * Cap an unbounded string before it goes into a log entry's `data`.
 *
 * Browser-side `console.warn` / `console.error` output is forwarded by the
 * Next.js dev server into a `FileLogger` that concatenates its whole queue with
 * `Array.prototype.join` before writing `.next/logs/next-development.log`. A
 * single multi-megabyte value — a base64 `data:` URI, a subprocess stderr burst,
 * a whole forwarded IPC payload — can push that concatenation past V8's maximum
 * string length (~536 MB) and throw `RangeError: Invalid string length`, which
 * wedges the dev logger (its catch never clears the queue, so it re-throws every
 * flush). Truncating unbounded values at the source keeps the informative prefix
 * (mime type, first lines) while dropping the bulk that has no diagnostic value.
 *
 * This does NOT stop a high-frequency *stream* of small logs from accumulating —
 * for that, keep the log below the forwarded `warn` level. It only bounds the
 * size of any single entry.
 */

/** Default cap: long enough to keep a `data:<mime>;base64,` prefix + context. */
export const LOG_VALUE_MAX_CHARS = 512

/**
 * Return `value` unchanged when it is within `maxChars`, otherwise the first
 * `maxChars` characters followed by a marker recording how many were dropped.
 * `maxChars` is clamped to `>= 0`.
 */
export function truncateForLog(value: string, maxChars: number = LOG_VALUE_MAX_CHARS): string {
  const cap = Math.max(0, Math.floor(maxChars))
  if (value.length <= cap) {
    return value
  }
  const omitted = value.length - cap
  return `${value.slice(0, cap)}…[+${omitted} chars truncated]`
}
