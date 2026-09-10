/**
 * Discord outbound serialiser.
 *
 * Projects an OutboundRequest into one or more Discord REST API calls.
 * Each call is { method, url, payload } — the adapter executes them in order.
 *
 * Discord markdown is close to CommonMark. Only escape characters that would
 * unintentionally open formatting: * _ ~ | > (and \\ itself).
 */

import type { OutboundRequest, SegmentDowngrade } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { fnv1a32 } from "../_shared/fnv1a"
import { buildDiscordA2UIPayload, DiscordA2UIValidationError } from "./a2ui-mapper"

import { walkA2UISurface } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { DISCORD_A2UI_CAPABILITY } from "./capability"

const DISCORD_API_BASE = "https://discord.com/api/v10"

/** Resolve public composite IDs, accepting legacy bare IDs when a channel is known. */
export function splitChannelMessage(
  id: string,
  fallbackChannel?: string
): [channelId: string, messageId: string] {
  const separator = id.indexOf(":")
  if (separator > 0 && separator < id.length - 1) {
    return [id.slice(0, separator), id.slice(separator + 1)]
  }
  if (separator === -1 && id && fallbackChannel) return [fallbackChannel, id]
  throw new Error(`Discord message ops require a "channelId:messageId" composite id, got "${id}"`)
}

export interface SerializedDiscordCall {
  /** Local rendering diagnostics; never sent to the platform. */
  downgrades?: SegmentDowngrade[]
  method: "POST" | "PATCH" | "DELETE" | "PUT"
  url: string
  payload: Record<string, unknown>
}

/** Discord rejects message `content` longer than 2000 characters with a 400. */
export const DISCORD_MAX_CONTENT_LENGTH = 2000

/** Discord caps a message `nonce` at 25 characters. */
export const DISCORD_NONCE_MAX_LENGTH = 25

/**
 * Deterministic Discord `nonce` for one message-create call of an outbound
 * job (ADR-0009 platform idempotency contract).
 *
 * Discord de-duplicates message creation when the same `nonce` is posted
 * again with `enforce_nonce: true` — it returns the already-created message
 * instead of a second one. That closes the crash window between a
 * successful POST and our `markSent`: a retried job re-sends the SAME nonce
 * and Discord hands back the original message id. Two FNV-1a passes over
 * `<idempotencyKey>#<index>` (base36) keep the value well under the 25-char
 * cap; `index` distinguishes the chunks/lanes one job fans out into (chunk
 * 0..n of the REST serializer, `voice:<i>`, `media`).
 *
 * UNVERIFIED (Discord docs only say "a few minutes"): the de-dup window is
 * shorter than the runner's stale-`sending` recovery (≥5 min), so a very
 * late retry can still produce a duplicate; the runner keeps its row-evidence
 * dedupe for that residue.
 */
export function discordNonce(idempotencyKey: string, index: number | string): string {
  const material = `${idempotencyKey}#${index}`
  const first = fnv1a32(material)
  const second = fnv1a32(material, first ^ 0x9e3779b9)
  return `${first.toString(36)}${second.toString(36)}`.slice(0, DISCORD_NONCE_MAX_LENGTH)
}

/**
 * Stamp `nonce` + `enforce_nonce` on every message-create POST of a job so a
 * retry re-posts the same nonces. Calls are indexed in emission order — the
 * order is deterministic for a given request, so a retry reproduces it. Any
 * non-create call (edit/delete/reaction/history) is left untouched.
 */
function stampNonces(
  calls: SerializedDiscordCall[],
  idempotencyKey: string
): SerializedDiscordCall[] {
  if (!idempotencyKey) return calls
  return calls.map((call, index) => {
    if (call.method !== "POST" || !call.url.endsWith("/messages")) return call
    return {
      ...call,
      payload: {
        ...call.payload,
        nonce: discordNonce(idempotencyKey, index),
        enforce_nonce: true,
      },
    }
  })
}

interface DiscordMarkdownSpan {
  start: number
  bodyStart: number
  bodyEnd: number
  end: number
  open: string
  close: string
}

/** Locate paired inline/fenced markup without treating escaped delimiters as formatting. */
function discordMarkdownSpans(text: string): {
  spans: DiscordMarkdownSpan[]
  protectedRanges: Array<[number, number]>
} {
  const spans: DiscordMarkdownSpan[] = []
  const protectedRanges: Array<[number, number]> = []
  const scan = (start: number, end: number) => {
    for (let at = start; at < end;) {
      if (text[at] === "\\") {
        protectedRanges.push([at, Math.min(end, at + 2)])
        at += 2
        continue
      }
      const source = text.slice(at, end)
      const tag = /^<(?:@!?\d+|@&\d+|#\d+|a?:\w+:\d+|https?:\/\/[^>]+)>/.exec(source)
      if (tag) {
        protectedRanges.push([at, at + tag[0].length])
        at += tag[0].length
        continue
      }
      const fence = /^(`{3,})([^`\n]*\n)/.exec(source)
      const link = /^\[((?:\\.|[^\]\\])+)\]\(((?:\\.|[^)\\])+)\)/.exec(source)
      let open = ""
      let close = ""
      let bodyEnd = -1
      if (fence) {
        open = fence[0]
        close = fence[1]
        bodyEnd = text.indexOf(close, at + open.length)
      } else if (link) {
        open = "["
        close = `](${link[2]})`
        bodyEnd = at + 1 + link[1].length
      } else {
        const delimiter = /^(\*\*\*|___|\*\*|__|~~|\|\||\*|_|`+)/.exec(source)?.[0]
        if (delimiter && !/\s/.test(text[at + delimiter.length] ?? " ")) {
          open = close = delimiter
          let candidate = text.indexOf(close, at + open.length)
          while (candidate >= 0 && candidate < end) {
            let slashes = 0
            for (let i = candidate - 1; i >= 0 && text[i] === "\\"; i--) slashes++
            if (slashes % 2 === 0 && !/\s/.test(text[candidate - 1])) break
            candidate = text.indexOf(close, candidate + close.length)
          }
          bodyEnd = candidate
        }
      }
      if (bodyEnd <= at + open.length || bodyEnd + close.length > end) {
        at += String.fromCodePoint(text.codePointAt(at)!).length
        continue
      }
      const span = {
        start: at,
        bodyStart: at + open.length,
        bodyEnd,
        end: bodyEnd + close.length,
        open,
        close,
      }
      spans.push(span)
      protectedRanges.push([span.start, span.bodyStart], [span.bodyEnd, span.end])
      if (!fence && !open.startsWith("`")) scan(span.bodyStart, span.bodyEnd)
      at = span.end
    }
  }
  scan(0, text.length)
  return { spans, protectedRanges }
}

/** Preserve all text, Unicode characters and paired Markdown across message boundaries. */
export function chunkDiscordContent(text: string, max = DISCORD_MAX_CONTENT_LENGTH): string[] {
  if (!Number.isInteger(max) || max < 1)
    throw new DiscordA2UIValidationError("Discord chunk limit must be positive")
  if (text.length <= max) return [text]
  const { spans, protectedRanges } = discordMarkdownSpans(text)
  const activeAt = (offset: number) =>
    spans.filter((span) => span.start < offset && offset < span.end)
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const prefix = activeAt(start)
      .map((span) => span.open)
      .join("")
    let cut = Math.min(text.length, start + max - prefix.length)
    const newline = text.lastIndexOf("\n", cut - 1)
    // Preserve the boundary newline. Avoid choosing only a reopened fence header.
    if (
      cut < text.length &&
      newline > start &&
      !protectedRanges.some(([a, b]) => a <= newline && newline < b)
    )
      cut = newline + 1
    let suffix = ""
    while (cut > start) {
      const protectedRange = protectedRanges.find(([a, b]) => a < cut && cut < b)
      if (protectedRange) {
        cut = protectedRange[0]
        continue
      }
      if (
        cut < text.length &&
        /[\uD800-\uDBFF]/.test(text[cut - 1]) &&
        /[\uDC00-\uDFFF]/.test(text[cut])
      ) {
        cut--
        continue
      }
      suffix = activeAt(cut)
        .map((span) => span.close)
        .reverse()
        .join("")
      const overflow = prefix.length + cut - start + suffix.length - max
      if (overflow <= 0) break
      cut -= overflow
    }
    if (cut <= start)
      throw new DiscordA2UIValidationError(
        "Discord markup or Unicode character cannot fit within the message limit"
      )
    chunks.push(prefix + text.slice(start, cut) + suffix)
    start = cut
  }
  return chunks
}

/**
 * Build one POST /messages call per ≤2000-char chunk of `content`. Only the
 * first chunk carries the `message_reference` (one reply ping, not N).
 */
function contentCalls(
  content: string,
  url: string,
  messageReference: Record<string, unknown> | undefined
): SerializedDiscordCall[] {
  return chunkDiscordContent(content).map((chunk, i) => {
    const payload: Record<string, unknown> = { content: chunk }
    if (messageReference && i === 0) payload["message_reference"] = messageReference
    return { method: "POST" as const, url, payload }
  })
}

/** Extract channel_id from the conversation reference. */
function channelIdFromRef(req: OutboundRequest): string {
  const ref = req.conversationRef as Record<string, unknown>
  return String(ref["channelId"] ?? "")
}

/** Build the message_reference field for replies. */
function buildMessageReference(
  req: OutboundRequest,
  channelId: string
): Record<string, unknown> | undefined {
  if (!req.replyTo?.messageId) return undefined
  const ref = req.conversationRef as Record<string, unknown>
  const [replyChannel, messageId] = splitChannelMessage(req.replyTo.messageId, channelId)
  return {
    message_id: messageId,
    channel_id: replyChannel,
    guild_id: ref["guildId"],
  }
}

/**
 * Segment kinds that all project to Discord's `content` field and can
 * therefore share one message.
 *
 * `reply` is deliberately absent from both this set and the "breaks the run"
 * side: it carries no content of its own (the reply is expressed through
 * `message_reference`), so letting it split a run would fragment a message for
 * nothing.
 */
const CONTENT_SEGMENT_TYPES = new Set(["text", "markdown", "code", "mention", "emoji"])

/** One content-bearing segment as the markdown Discord will render. */
function renderContentSegment(seg: MessageSegment): string {
  switch (seg.type) {
    case "text":
      return seg.text
    case "markdown":
      return seg.md
    case "mention":
      return `<@${seg.userId}>`
    case "emoji":
      return seg.code
    case "code": {
      const lang = seg.language ?? ""
      return lang ? `\`\`\`${lang}\n${seg.code}\n\`\`\`` : `\`\`\`\n${seg.code}\n\`\`\``
    }
    default:
      return ""
  }
}

/**
 * Kinds that occupy their own block. Two of them in a row are two paragraphs,
 * not one run-on line, so they are separated by a newline. `mention` and
 * `emoji` are inline and carry their own surrounding spacing from whoever
 * wrote them, so they are appended verbatim.
 */
const BLOCK_SEGMENT_TYPES = new Set(["text", "markdown", "code"])

/**
 * Render a run of content segments as ONE Discord message body.
 *
 * A newline goes between two consecutive BLOCK segments only. That keeps
 * `["Here is the fix:", <code>]` as two lines while leaving
 * `["Ping ", @user, " please"]` a single sentence — inserting a break around an
 * inline segment would corrupt a sentence its author had already spaced.
 * A fenced code block additionally forces a line of its own at both ends:
 * Discord only renders a fence that starts a line, so an inlined one would
 * print its backticks literally.
 */
export function renderDiscordContentRun(segments: readonly MessageSegment[]): string {
  let out = ""
  let previousWasBlock = false
  let lastWasCode = false
  for (const seg of segments) {
    const piece = renderContentSegment(seg)
    if (!piece) continue
    const isBlock = BLOCK_SEGMENT_TYPES.has(seg.type)
    if (out.length > 0 && isBlock && previousWasBlock && !out.endsWith("\n")) out += "\n"
    out += seg.type === "code" ? `${piece}\n` : piece
    previousWasBlock = isBlock
    lastWasCode = seg.type === "code"
  }
  return lastWasCode ? out.slice(0, -1) : out
}

/**
 * Collapse consecutive content-bearing segments into a single `markdown`
 * segment.
 *
 * Every text / markdown / code / mention / emoji segment used to become its own
 * Discord message, so an answer of "Here is the fix:" plus a code block arrived
 * as two messages — and because each one carried `message_reference`, a reply
 * pinged the user once per fragment instead of once. Segments that genuinely
 * need their own message (a2ui surfaces, and anything the serializer does not
 * recognise) still break the run and keep their position.
 */
export function mergeDiscordContentSegments(segments: readonly MessageSegment[]): MessageSegment[] {
  const out: MessageSegment[] = []
  let run: MessageSegment[] = []
  const flush = () => {
    if (run.length === 0) return
    const md = renderDiscordContentRun(run)
    run = []
    if (md.length > 0) out.push({ type: "markdown", md })
  }
  for (const seg of segments) {
    if (CONTENT_SEGMENT_TYPES.has(seg.type)) {
      run.push(seg)
      continue
    }
    // A reply segment carries no content and must not split the run.
    if (seg.type === "reply") continue
    flush()
    out.push(seg)
  }
  flush()
  return out
}

function serializeSegment(
  seg: MessageSegment,
  channelId: string,
  messageReference: Record<string, unknown> | undefined
): SerializedDiscordCall[] {
  const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`

  switch (seg.type) {
    case "text":
      // Chunked at Discord's 2000-char content cap (400 otherwise).
      return contentCalls(seg.text, url, messageReference)

    case "markdown":
      return contentCalls(seg.md, url, messageReference)

    case "code": {
      const lang = seg.language ?? ""
      const block = lang ? `\`\`\`${lang}\n${seg.code}\n\`\`\`` : `\`\`\`\n${seg.code}\n\`\`\``
      const payload: Record<string, unknown> = { content: block }
      if (messageReference) payload["message_reference"] = messageReference
      return [{ method: "POST", url, payload }]
    }

    case "image": {
      // Phase 1: URL-only via attachments array embed in embeds[]
      const payload: Record<string, unknown> = {
        embeds: [{ image: { url: seg.url } }],
      }
      if (messageReference) payload["message_reference"] = messageReference
      return [{ method: "POST", url, payload }]
    }

    case "file": {
      // Phase 1: URL-only link in content
      const payload: Record<string, unknown> = { content: seg.url }
      if (messageReference) payload["message_reference"] = messageReference
      return [{ method: "POST", url, payload }]
    }

    case "mention": {
      const content = `<@${seg.userId}>`
      const payload: Record<string, unknown> = { content }
      if (messageReference) payload["message_reference"] = messageReference
      return [{ method: "POST", url, payload }]
    }

    case "emoji": {
      const payload: Record<string, unknown> = { content: seg.code }
      if (messageReference) payload["message_reference"] = messageReference
      return [{ method: "POST", url, payload }]
    }

    case "location":
    case "poll": {
      const text =
        seg.type === "location"
          ? [seg.name, String(seg.lat) + ", " + String(seg.lon)].filter(Boolean).join("\n")
          : [
              seg.question,
              ...(seg.multi ? ["Multiple selections allowed"] : []),
              ...seg.options.map((option, index) => String(index + 1) + ". " + option),
            ].join("\n")
      const downgrades: SegmentDowngrade[] = [
        {
          from: seg.type,
          to: "text",
          reason:
            "Native " + seg.type + " sending is unavailable; complete content retained as text",
        },
      ]
      const calls = contentCalls(text, url, messageReference)
      calls[0].downgrades = downgrades
      return calls
    }

    case "reply":
      // reply segments are handled via replyTo on the OutboundRequest
      return []

    case "a2ui": {
      // Sync path: emit the `plainTextMirror` as fallback. The async
      // `serializeOutboundAsync` invokes the full mapper (embeds +
      // components) and overrides this.
      const payload: Record<string, unknown> = { content: seg.plainTextMirror }
      if (messageReference) payload["message_reference"] = messageReference
      return [{ method: "POST", url, payload }]
    }

    default:
      // Unsupported segment types dropped in Phase 1
      return []
  }
}

/**
 * Project an OutboundRequest into an ordered list of Discord REST calls
 * (sync path). a2ui segments fall back to `plainTextMirror`; use
 * `serializeOutboundAsync` for the full embed + components rendering.
 */
export function serializeOutbound(req: OutboundRequest): SerializedDiscordCall[] {
  if (req.segments.some((segment) => segment.type === "card")) {
    throw new DiscordA2UIValidationError(
      "Opaque native cards are not supported by discord; use an A2UI surface or text"
    )
  }
  const channelId = channelIdFromRef(req)
  const messageReference = buildMessageReference(req, channelId)
  const calls: SerializedDiscordCall[] = []

  for (const seg of mergeDiscordContentSegments(req.segments)) {
    calls.push(...serializeSegment(seg, channelId, messageReference))
  }

  return stampNonces(calls, req.metadata?.idempotencyKey ?? "")
}

/**
 * Async serializer used by the production adapter `send()`. a2ui
 * segments are projected via `buildDiscordA2UIPayload` (embeds +
 * components + callback bindings); other segments delegate to the sync
 * path.
 */
export async function serializeOutboundAsync(
  req: OutboundRequest,
  adapterId: string
): Promise<SerializedDiscordCall[]> {
  if (req.segments.some((segment) => segment.type === "card")) {
    throw new DiscordA2UIValidationError(
      "Opaque native cards are not supported by discord; use an A2UI surface or text"
    )
  }
  const channelId = channelIdFromRef(req)
  const messageReference = buildMessageReference(req, channelId)
  const calls: SerializedDiscordCall[] = []
  const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`

  for (const seg of mergeDiscordContentSegments(req.segments)) {
    if (seg.type === "a2ui") {
      const fallbackKinds = new Set<string>()
      walkA2UISurface(seg.content, (node) => {
        const support = (DISCORD_A2UI_CAPABILITY as Readonly<Record<string, string>>)[
          node.component
        ]
        if (support !== "native" && support !== "simulated") fallbackKinds.add(node.component)
      })
      const downgrades: SegmentDowngrade[] = fallbackKinds.size
        ? [
            {
              from: "a2ui",
              to: "text",
              reason:
                "A2UI surface " +
                seg.surfaceId +
                " uses its text mirror for: " +
                [...fallbackKinds].join(", "),
            },
          ]
        : []

      const payload = await buildDiscordA2UIPayload({
        adapterId,
        surfaceId: seg.surfaceId,
        surface: seg.content,
        conversationKey: extractConversationKey(req, channelId),
      })
      const hasNative =
        (payload.embeds && payload.embeds.length > 0) ||
        (payload.components && payload.components.length > 0) ||
        (payload.content && payload.content.length > 0)
      if (!hasNative) {
        // Mapper produced nothing — fall back to plain text mirror.
        const fallbackCalls = contentCalls(seg.plainTextMirror, url, messageReference)
        if (downgrades.length) fallbackCalls[0].downgrades = downgrades
        calls.push(...fallbackCalls)
        continue
      }
      const content = [payload.content, ...(fallbackKinds.size ? [seg.plainTextMirror] : [])]
        .filter(Boolean)
        .join("\n")
      const nativeCalls = contentCalls(content, url, messageReference)
      Object.assign(nativeCalls[nativeCalls.length - 1].payload, {
        ...(payload.embeds ? { embeds: payload.embeds } : {}),
        ...(payload.components ? { components: payload.components } : {}),
      })
      if (downgrades.length) nativeCalls[0].downgrades = downgrades
      calls.push(...nativeCalls)
      continue
    }
    calls.push(...serializeSegment(seg, channelId, messageReference))
  }

  return stampNonces(calls, req.metadata?.idempotencyKey ?? "")
}

function extractConversationKey(req: OutboundRequest, channelId: string): string | undefined {
  const ref = req.conversationRef as Record<string, unknown>
  const adapterId = typeof ref["adapterId"] === "string" ? ref["adapterId"] : ""
  if (!adapterId || !channelId) return undefined
  const thread = req.threadId
  return thread
    ? `discord:${adapterId}:${channelId}:${thread}`
    : `discord:${adapterId}:${channelId}`
}

/**
 * Build a DELETE call for a specific message.
 */
export function serializeDelete(channelId: string, messageId: string): SerializedDiscordCall {
  return {
    method: "DELETE",
    url: `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`,
    payload: {},
  }
}

/**
 * Build a PATCH call for editing a message.
 */
export function serializeEdit(
  channelId: string,
  messageId: string,
  content: string
): SerializedDiscordCall {
  return {
    method: "PATCH",
    url: `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`,
    payload: { content },
  }
}

/**
 * Build a `GET /channels/{channel.id}/messages?limit=N&before=cursor`
 * call (added at ADR-0009 v41 / A2.b). Discord's REST history endpoint
 * caps `limit` at 100 per request; the adapter pages with `before` to
 * walk older messages.
 */
export function serializeFetchHistory(
  channelId: string,
  options: { limit?: number; before?: string; after?: string }
): SerializedDiscordCall {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100)
  const qs = new URLSearchParams({ limit: String(limit) })
  if (options.before) qs.set("before", options.before)
  if (options.after) qs.set("after", options.after)
  // GET is not in the SerializedDiscordCall method union (the adapter's
  // doRequest handles all REST verbs through fetch directly). We model
  // history fetches as method="POST" with an empty payload so the type
  // contract stays narrow — the adapter switches to GET when the URL
  // ends in /messages?limit=...
  return {
    method: "POST",
    url: `${DISCORD_API_BASE}/channels/${channelId}/messages?${qs.toString()}`,
    payload: {},
  }
}

/**
 * Build a `PUT /channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me`
 * call (added at ADR-0009 v41 / A2 of the IM connector gap-closure plan).
 *
 * `emoji` may be either:
 *   - a unicode character (e.g. `"👍"`) — URL-encoded by this helper, OR
 *   - a custom-emoji identifier in Discord's `name:id` form
 *     (e.g. `"thumbsup:43623862374"`) — URL-encoded as a single segment.
 *
 * Reactions are per-emoji on Discord (no batched ReactionType[] like on
 * Telegram). To remove a reaction, use `serializeReactionRemoval` below
 * (DELETE on the same path).
 */
export function serializeReaction(
  channelId: string,
  messageId: string,
  emoji: string
): SerializedDiscordCall {
  return {
    method: "PUT",
    url: `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    payload: {},
  }
}

/**
 * Build a DELETE call to remove the bot's own reaction from a message.
 * Useful for retracting an earlier `serializeReaction` call.
 */
export function serializeReactionRemoval(
  channelId: string,
  messageId: string,
  emoji: string
): SerializedDiscordCall {
  return {
    method: "DELETE",
    url: `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    payload: {},
  }
}
