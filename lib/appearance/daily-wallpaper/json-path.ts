/**
 * A deliberately tiny reader for the path a user types into the custom
 * daily-wallpaper source.
 *
 * This runs on every scheduled fetch, on a string the user supplied, against
 * JSON a remote host supplied. That is a bad place for anything clever, so
 * this walks plain object keys and array indices and does nothing else: no
 * expression evaluation, no wildcards, no filters, no function calls.
 *
 * Accepted forms, which cover every real-world "where is the image URL" case
 * the built-in providers needed:
 *
 *   images.0.url        dot segments, numeric segments index arrays
 *   images[0].url       bracket indices, same meaning
 *   data.today.image    nested objects
 *
 * Anything the path does not reach returns `undefined` rather than throwing,
 * because a provider that changed its response shape is an ordinary runtime
 * failure the caller reports as `no-image`, not an exception.
 */

/** Split a path into segments, accepting both dot and bracket notation. */
export function parseJsonPath(path: string): string[] {
  const segments: string[] = []
  // Normalise `[0]` into `.0` first so one split handles both notations.
  const normalized = path.replace(/\[(\d+)\]/g, ".$1")
  for (const raw of normalized.split(".")) {
    const segment = raw.trim()
    if (segment === "") continue
    segments.push(segment)
  }
  return segments
}

/**
 * Read a value out of a parsed JSON document.
 *
 * Returns `undefined` for a path that does not resolve, and for any path that
 * would traverse INTO a non-plain value. Notably it refuses to read
 * `__proto__`, `constructor` and `prototype`, because the path is untrusted
 * input and reading a prototype chain is never what a wallpaper URL lookup
 * meant.
 */
export function readJsonPath(document: unknown, path: string): unknown {
  const segments = parseJsonPath(path)
  if (segments.length === 0) return undefined

  let cursor: unknown = document
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined

    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(segment)) return undefined
      const index = Number(segment)
      if (index >= cursor.length) return undefined
      cursor = cursor[index]
      continue
    }

    if (typeof cursor !== "object") return undefined
    // `in` would walk the prototype chain. An own-property check keeps the
    // lookup to what the remote host actually sent.
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/** Read a path and require the result to be a non-empty string. */
export function readJsonPathString(document: unknown, path: string): string | undefined {
  const value = readJsonPath(document, path)
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"])
