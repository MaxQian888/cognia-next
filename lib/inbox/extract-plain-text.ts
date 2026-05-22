/**
 * Plain-text projection for Inbox search (v49).
 *
 * Extracted from the inline implementation that previously lived in
 * `components/inbox/conversation-list.tsx`. The old version only walked
 * `parts[].type === "text"` and silently dropped:
 *
 *   • A2UI surfaces — search now consults the surface's plain-text mirror.
 *   • Markdown segments (the message renderer accepts them inline).
 *   • Code blocks (they survive as text under `parts[].type === "code"`).
 *   • Image segments (kept as `[image]` so the search needle can still
 *     hit conversations where the only inbound was a screenshot).
 *
 * The output is fully concatenated, whitespace-collapsed, and trimmed.
 * Callers cap the length (default 240 chars in ConversationList).
 */

interface A2UIPart {
  type: "a2ui"
  plainTextMirror?: string
  /** Some renderers stash the mirror under `text` for legacy reasons. */
  text?: unknown
}

interface CodePart {
  type: "code"
  text?: unknown
  code?: unknown
  language?: unknown
}

interface ImagePart {
  type: "image"
  alt?: unknown
}

interface TextLikePart {
  type: "text" | "markdown"
  text?: unknown
  md?: unknown
}

type AnyPart = A2UIPart | CodePart | ImagePart | TextLikePart | Record<string, unknown>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Walk a `UIMessage.parts` array and produce a single plain-text string.
 * Unknown part types are skipped (forward-compatible). The result is
 * whitespace-collapsed and trimmed — callers apply the length cap.
 */
export function extractPlainText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  const buf: string[] = []
  for (const raw of parts as AnyPart[]) {
    if (!isObject(raw)) continue
    const part = raw as Record<string, unknown>
    const type = part.type
    if (type === "text") {
      buf.push(asString(part.text))
    } else if (type === "markdown") {
      buf.push(asString(part.md))
    } else if (type === "code") {
      const text = asString(part.text) || asString(part.code)
      const language = asString(part.language)
      buf.push(language ? `[${language}] ${text}` : text)
    } else if (type === "image") {
      const alt = asString(part.alt)
      buf.push(alt ? `[image: ${alt}]` : "[image]")
    } else if (type === "a2ui") {
      const mirror = asString(part.plainTextMirror) || asString(part.text)
      if (mirror) buf.push(mirror)
    }
  }
  return buf.join(" ").replace(/\s+/g, " ").trim()
}
