/**
 * `{{variable}}` interpolation for canned responses. Pure + dependency-free so
 * it's trivially testable and reusable from both the composer picker and any
 * future automated insertion. Unknown tokens resolve to an empty string (a
 * missing contact name should never leak a literal `{{contact.name}}` to the
 * recipient). Whitespace inside the braces is tolerated.
 */

export interface CannedContext {
  contact?: { name?: string; handle?: string; platform?: string }
  conversation?: { title?: string; platform?: string }
  operator?: { name?: string }
}

/** Resolve a dotted token path (e.g. "contact.name") against the context. */
function resolveToken(path: string, ctx: CannedContext): string {
  const segments = path.split(".")
  let cursor: unknown = ctx
  for (const seg of segments) {
    if (cursor && typeof cursor === "object" && seg in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[seg]
    } else {
      return ""
    }
  }
  return typeof cursor === "string" ? cursor : cursor == null ? "" : String(cursor)
}

/** Replace every `{{ token }}` in `body` with its resolved value (or ""). */
export function interpolate(body: string, ctx: CannedContext = {}): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => resolveToken(path, ctx))
}

/** The variables the picker advertises as insertable; used to render hints. */
export const CANNED_VARIABLES: ReadonlyArray<string> = [
  "contact.name",
  "contact.handle",
  "contact.platform",
  "conversation.title",
  "operator.name",
]
