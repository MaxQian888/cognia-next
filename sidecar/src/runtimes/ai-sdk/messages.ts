import type { ConversationMessage } from "../../context/compaction.ts"
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}
export function errorToMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  if (typeof record(err).message === "string") return record(err).message as string
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

export function stripReasoningParts(messages: ConversationMessage[]) {
  const out = []
  for (const msg of messages) {
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg)
      continue
    }
    const filtered = msg.content.filter((part) => part?.type !== "reasoning")
    if (filtered.length === 0) continue
    out.push(filtered.length === msg.content.length ? msg : { ...msg, content: filtered })
  }
  return out
}

/**
 * Convert an Anthropic agent-SDK content-block array (what the composer emits)
 * into AI SDK v6 user-message content parts.
 *
 * Anthropic shape → AI SDK v6 shape:
 *  - `{ type:'text', text }`                                  → unchanged
 *  - `{ type:'image', source:{ type:'base64', media_type, data } }`
 *        → `{ type:'image', image:'data:<media_type>;base64,<data>', mediaType }`
 *  - `{ type:'image', source:{ type:'url', url } }`           → `{ type:'image', image:url }`
 *  - `{ type:'document'|'file', source:{ type:'base64', media_type, data } }`
 *        → `{ type:'file', data:'data:<media_type>;base64,<data>', mediaType }`
 *  - blocks already in AI SDK shape (`{ type:'image', image }`,
 *    `{ type:'file', data }`) pass through untouched (idempotent)
 *  - strings and any unrecognised block pass through verbatim so content is
 *    never silently dropped.
 *
 * Exported via `__testing__` for unit coverage.
 *
 * @param {any[]} blocks
 * @returns {any[]}
 */
export function toAiSdkUserContent<T>(blocks: T): T extends unknown[] ? unknown[] : T {
  if (!Array.isArray(blocks)) return blocks as T extends unknown[] ? unknown[] : T
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return block
    const part = record(block)
    const src = record(part.source)
    const isBase64Source = src && typeof src === "object" && src.type === "base64"
    const isUrlSource = src && typeof src === "object" && src.type === "url"

    if (part.type === "image") {
      // AI SDK 7 deprecated the dedicated `image` part: images are just files
      // with an image media type. `mediaType` accepts either a full IANA type
      // ("image/png") or the bare top-level segment ("image"), which is the
      // right answer when the source never told us the subtype.
      if ("image" in block && !part.source) {
        return { type: "file", mediaType: part.mediaType ?? "image", data: part.image }
      }
      if (isBase64Source) {
        return {
          type: "file",
          mediaType: src.media_type ?? "image",
          data: `data:${src.media_type ?? ""};base64,${src.data ?? ""}`,
        }
      }
      if (isUrlSource && typeof src.url === "string") {
        return { type: "file", mediaType: src.media_type ?? "image", data: src.url }
      }
      return block
    }

    if (part.type === "document" || part.type === "file") {
      // Already AI SDK file shape — leave as-is.
      if ("data" in block && !part.source) return block
      if (isBase64Source) {
        return {
          type: "file",
          data: `data:${src.media_type ?? ""};base64,${src.data ?? ""}`,
          mediaType: src.media_type ?? "application/octet-stream",
        }
      }
      if (isUrlSource && typeof src.url === "string") {
        return {
          type: "file",
          data: src.url,
          mediaType: src.media_type ?? "application/octet-stream",
        }
      }
      return block
    }

    return block
  }) as T extends unknown[] ? unknown[] : T
}

/**
 * Does a tool's execute output carry an image? Tolerant of both shapes a step's
 * `toolResults[i].output` can take: the raw MCP `CallToolResult`
 * (`{ content:[{ type:'image', data, mimeType }] }`, what our built-in `read`
 * returns) and the already-mapped `toModelOutput` content form
 * (`{ type:'content', value:[{ type:'image-data'|'file-data'|'media', mediaType }] }`).
 *
 * @param {unknown} output
 * @returns {boolean}
 */
export function toolOutputHasImage(output: unknown) {
  if (!output || typeof output !== "object") return false
  const o = record(output)
  if (Array.isArray(o.content)) {
    if (o.content.some((b) => b && b.type === "image" && typeof b.data === "string")) return true
  }
  if (o.type === "content" && Array.isArray(o.value)) {
    return o.value.some(
      (v) =>
        v &&
        (v.type === "image-data" || v.type === "file-data" || v.type === "media") &&
        typeof v.mediaType === "string" &&
        v.mediaType.startsWith("image/")
    )
  }
  return false
}

/**
 * Most non-Anthropic provider APIs cannot carry an image INSIDE a tool-result
 * message (OpenAI Chat Completions, Mistral, Cohere, and older Gemini have no
 * slot for it; the AI SDK then serializes the image to a base64 JSON string the
 * model can't read). The portable fix: pull every image out of the model's
 * tool-result messages and re-project it as a normal USER-message image part —
 * which every vision model accepts — leaving a short text marker behind.
 *
 * Returns the AI SDK user-content image parts found, plus a sanitized copy of
 * `messages` with the image payloads replaced by text. Non-tool messages and
 * image-free tool results pass through untouched (object identity preserved when
 * nothing changed, so a no-image turn is a true no-op).
 *
 * @param {Array<any>} messages  AI SDK ModelMessages (from `result.response.messages`).
 * @returns {{ images: Array<{ type: "image", image: string, mediaType: string }>, sanitized: Array<any> }}
 */
export function projectToolResultImages(messages: ConversationMessage[]) {
  if (!Array.isArray(messages)) return { images: [], sanitized: messages }
  const images: { type: "image"; image: string; mediaType: string }[] = []
  const sanitized = messages.map((msg) => {
    if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) return msg
    let msgChanged = false
    const content = msg.content.map((part) => {
      if (!part || part.type !== "tool-result") return part
      const out = part.output
      if (!out || out.type !== "content" || !Array.isArray(out.value)) return part
      let partChanged = false
      const value = out.value.map((v: Record<string, unknown>) => {
        const isImage =
          v &&
          (v.type === "image-data" || v.type === "file-data" || v.type === "media") &&
          typeof v.data === "string" &&
          typeof v.mediaType === "string" &&
          v.mediaType.startsWith("image/")
        if (!isImage) return v
        partChanged = true
        images.push({
          type: "image",
          image: `data:${v.mediaType};base64,${v.data}`,
          mediaType: v.mediaType as string,
        })
        return {
          type: "text",
          text: `[image returned by ${part.toolName ?? "tool"} — shown in the next message]`,
        }
      })
      if (!partChanged) return part
      msgChanged = true
      // Collapse to a plain-text output when nothing but text remains, so a
      // chat-completions provider receives clean text rather than a JSON array.
      const allText = value.every((v: Record<string, unknown>) => v && v.type === "text")
      const nextOutput = allText
        ? { type: "text", value: value.map((v: Record<string, unknown>) => v.text).join("\n") }
        : { ...out, value }
      return { ...part, output: nextOutput }
    })
    return msgChanged ? { ...msg, content } : msg
  })
  return { images, sanitized }
}
