/**
 * Coerce an arbitrary thrown / serialized error into a single string the error
 * parsers can consume.
 *
 * - `string` passes through (empty → `fallback`).
 * - `Error` prefers its `stack` (so the stack-trace parser can surface
 *   clickable frames) and falls back to `message`.
 * - An object carrying a string `stack` uses it; a bare `{ message }` uses the
 *   message; any other object is pretty-printed as JSON so the JSON /
 *   Anthropic-envelope parsers can render it instead of the UI showing
 *   `[object Object]`.
 * - Nullish input yields `fallback`.
 */
export function normalizeErrorText(input: unknown, fallback = ""): string {
  if (typeof input === "string") {
    return input.length > 0 ? input : fallback
  }
  if (input instanceof Error) {
    const stack = input.stack?.trim()
    return stack && stack.length > 0 ? input.stack! : input.message || fallback
  }
  if (input != null && typeof input === "object") {
    const obj = input as Record<string, unknown>
    if (typeof obj.stack === "string" && obj.stack.trim().length > 0) {
      return obj.stack
    }
    // A bare `{ message }` is plain text; anything more structured (e.g. an
    // Anthropic `{ type, error }` envelope, `{ error: { ... } }`, …) is kept as
    // JSON so the structured parsers can claim it.
    if (typeof obj.message === "string" && Object.keys(obj).length === 1) {
      return obj.message.length > 0 ? obj.message : fallback
    }
    try {
      return JSON.stringify(obj, null, 2)
    } catch {
      return String(input)
    }
  }
  if (input == null) {
    return fallback
  }
  return String(input)
}
