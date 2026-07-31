/**
 * OutboundRequest → Matrix client-server API payloads.
 *
 * Matrix messages are `m.room.message` events whose `content` carries a plain
 * `body` plus, for rich text, an `org.matrix.custom.html` `formatted_body`.
 * This module turns the cross-platform `MessageSegment[]` into one or more
 * such contents, applies reply / thread relations, and projects A2UI surfaces
 * into HTML (native parts) + a numbered fallback (interactive parts).
 *
 * Media segments (image/video/voice/file) are emitted as ordered media chunks.
 * The adapter's send path uploads each chunk to the Matrix media repository
 * and sends a native `m.image` / `m.file` / `m.audio` / `m.video` event.
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import type { A2UISegmentContent, MessageSegment } from "@/types/connectors/segment"
import { walkA2UISurface } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { bareMatrixEventId } from "./ids"
import type { MatrixMentions, MatrixRelatesTo } from "./parse"

// All outbound assistant messages use `msgtype: "m.notice"` — the spec's
// convention for automated senders. Well-behaved bots do not respond to
// m.notice, which is the protocol-level guard against bot-to-bot reply
// loops; `m.text` is reserved for humans and is never emitted here.
const OUTBOUND_MSGTYPE = "m.notice" as const

export interface MatrixSendContent {
  kind?: "message"
  msgtype: "m.text" | "m.notice"
  body: string
  format?: "org.matrix.custom.html"
  formatted_body?: string
  "m.relates_to"?: MatrixRelatesTo
  "m.mentions"?: MatrixMentions
  "m.new_content"?: Omit<MatrixSendContent, "m.relates_to" | "m.new_content">
}

export interface MatrixMediaChunk {
  kind: "media"
  segment: Extract<MessageSegment, { type: "image" | "video" | "voice" | "file" }>
  /**
   * Reply / thread relation for the media event. The send path merges this
   * into the uploaded event's content as `m.relates_to` (media events must
   * carry the thread relation too, or they fall out of the thread).
   */
  relatesTo?: MatrixRelatesTo
}

export type MatrixSerializedContent = MatrixSendContent | MatrixMediaChunk

export interface MatrixSerializedSend {
  /** One `m.room.message` content per outbound chunk, in render order. */
  contents: MatrixSerializedContent[]
  /**
   * Present when the request carried an A2UI surface with interactive
   * components. The index binds `surfaceId` to the sent event id so a user
   * reply correlates back to the surface (force_reply pattern).
   */
  a2uiBinding?: { surfaceId: string }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeAttr(s: string): string {
  return escapeHtml(s)
}

function stringValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}

/**
 * Minimal Markdown → Matrix `org.matrix.custom.html`. Covers the inline
 * constructs Matrix clients render: inline code, bold, italic, links, and
 * newlines. Deliberately small — full CommonMark is out of scope; anything
 * not matched survives as escaped text.
 */
export function mdToMatrixHtml(md: string): string {
  let html = escapeHtml(md)
  // Inline code first so its contents are not re-processed for bold/italic.
  html = html.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`)
  html = html.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => `<strong>${t}</strong>`)
  html = html.replace(
    /(^|[^*])\*([^*\s][^*]*)\*/g,
    (_m, pre: string, t: string) => `${pre}<em>${t}</em>`
  )
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, text: string, url: string) => `<a href="${url}">${text}</a>`
  )
  html = html.replace(/\n/g, "<br/>")
  return html
}

/**
 * Project an A2UI surface into Matrix HTML. Native components render as HTML;
 * interactive components (Button / Select / TextField …) render as a numbered
 * list so the user can reply with their choice (the simulated channel).
 */
export function a2uiToMatrixHtml(content: A2UISegmentContent): {
  html: string
  hasInteractive: boolean
} {
  const lines: string[] = []
  let optionIdx = 0
  let hasInteractive = false

  walkA2UISurface(content, (node) => {
    switch (node.component) {
      case "Text": {
        const t = stringValue(node.raw.text)
        if (t) lines.push(escapeHtml(t))
        break
      }
      case "Link": {
        const href = stringValue(node.raw.href)
        const label = stringValue(node.raw.text) || href
        if (href) lines.push(`<a href="${escapeAttr(href)}">${escapeHtml(label)}</a>`)
        else if (label) lines.push(escapeHtml(label))
        break
      }
      case "Divider":
        lines.push("<hr/>")
        break
      case "Card": {
        const title = stringValue(node.raw.title)
        if (title) lines.push(`<strong>${escapeHtml(title)}</strong>`)
        break
      }
      case "Alert": {
        const title = stringValue(node.raw.title)
        const text = stringValue(node.raw.text)
        const inner = `${title ? `<strong>${escapeHtml(title)}</strong>` : ""}${
          title && text ? ": " : ""
        }${text ? escapeHtml(text) : ""}`
        if (inner) lines.push(`<blockquote>⚠️ ${inner}</blockquote>`)
        break
      }
      case "Button": {
        hasInteractive = true
        optionIdx += 1
        const label =
          stringValue(node.raw.text) || stringValue(node.raw.action) || `Option ${optionIdx}`
        lines.push(`${optionIdx}. <strong>${escapeHtml(label)}</strong>`)
        break
      }
      case "Select":
      case "RadioGroup": {
        hasInteractive = true
        const label = stringValue(node.raw.label) || "Select"
        lines.push(`${escapeHtml(label)}:`)
        const options = Array.isArray(node.raw.options)
          ? (node.raw.options as Array<Record<string, unknown>>)
          : []
        for (const opt of options) {
          optionIdx += 1
          const ol = stringValue(opt.label) || stringValue(opt.value) || `Option ${optionIdx}`
          lines.push(`${optionIdx}. ${escapeHtml(ol)}`)
        }
        break
      }
      case "TextField":
      case "TextArea": {
        hasInteractive = true
        const label = stringValue(node.raw.label) || stringValue(node.raw.placeholder) || "input"
        lines.push(`<em>${escapeHtml(label)}:</em> ____`)
        break
      }
      case "Image": {
        const alt = stringValue(node.raw.alt) || "image"
        lines.push(`[${escapeHtml(alt)}]`)
        break
      }
      case "Row":
      case "Column":
      case "List":
        break
      default:
        lines.push(`[${escapeHtml(String(node.component))}]`)
    }
  })

  if (hasInteractive) {
    lines.push("<em>↩ Reply to this message to respond.</em>")
  }
  return { html: lines.join("<br/>"), hasInteractive }
}

// ---------------------------------------------------------------------------
// Segment → body/html rendering
// ---------------------------------------------------------------------------

interface RenderedBody {
  body: string
  formattedBody: string
  usedHtml: boolean
  mentionUsers: string[]
}

/**
 * Render a run of non-A2UI segments into a single body + formatted_body pair.
 */
function renderSegments(segments: MessageSegment[]): RenderedBody {
  const textParts: string[] = []
  const htmlParts: string[] = []
  const mentionUsers: string[] = []
  let usedHtml = false

  for (const seg of segments) {
    switch (seg.type) {
      case "text":
        textParts.push(seg.text)
        htmlParts.push(escapeHtml(seg.text))
        break
      case "markdown":
        textParts.push(seg.md)
        htmlParts.push(mdToMatrixHtml(seg.md))
        usedHtml = true
        break
      case "code":
        textParts.push(seg.code)
        htmlParts.push(`<pre><code>${escapeHtml(seg.code)}</code></pre>`)
        usedHtml = true
        break
      case "mention": {
        const label = seg.displayName ?? seg.userId
        textParts.push(`@${label}`)
        htmlParts.push(
          `<a href="https://matrix.to/#/${encodeURIComponent(seg.userId)}">${escapeHtml(label)}</a>`
        )
        mentionUsers.push(seg.userId)
        usedHtml = true
        break
      }
      case "emoji":
        textParts.push(seg.code)
        htmlParts.push(escapeHtml(seg.code))
        break
      case "image":
      case "video":
      case "voice":
      case "file": {
        // In the outbound SEND path, media segments are split into upload
        // chunks by serializeOutbound before ever reaching renderSegments, so
        // this arm only fires for edits (serializeEdit), where an `m.replace`
        // can't carry a real media upload. Render a link line so an edit to a
        // media segment isn't silently dropped to an empty body.
        const label = `[${seg.type}]`
        textParts.push(`${label} ${seg.url}`)
        htmlParts.push(`<a href="${escapeAttr(seg.url)}">${escapeHtml(label)}</a>`)
        usedHtml = true
        break
      }
      case "location":
        textParts.push(`[location ${seg.lat},${seg.lon}]`)
        htmlParts.push(escapeHtml(`[location ${seg.lat},${seg.lon}]`))
        break
      case "poll": {
        const opts = seg.options.map((o, i) => `${i + 1}. ${o}`).join("\n")
        textParts.push(`[poll] ${seg.question}\n${opts}`)
        htmlParts.push(escapeHtml(`[poll] ${seg.question}`))
        usedHtml = true
        break
      }
      case "card":
        textParts.push("[card]")
        htmlParts.push("[card]")
        break
      case "reply":
        // Reply is conveyed via m.relates_to, not the body.
        break
    }
  }

  return {
    body: textParts.join("\n"),
    formattedBody: htmlParts.join("<br/>"),
    usedHtml,
    mentionUsers,
  }
}

// ---------------------------------------------------------------------------
// Public serializers
// ---------------------------------------------------------------------------

export function serializeOutbound(req: OutboundRequest): MatrixSerializedSend {
  const contents: MatrixSerializedContent[] = []
  let a2uiBinding: { surfaceId: string } | undefined
  let buffer: MessageSegment[] = []

  const flush = (): void => {
    if (buffer.length === 0) return
    const rendered = renderSegments(buffer)
    buffer = []
    if (!rendered.body && !rendered.formattedBody) return
    const content: MatrixSendContent = { msgtype: OUTBOUND_MSGTYPE, body: rendered.body }
    if (rendered.usedHtml) {
      content.format = "org.matrix.custom.html"
      content.formatted_body = rendered.formattedBody
    }
    if (rendered.mentionUsers.length > 0) {
      content["m.mentions"] = { user_ids: [...new Set(rendered.mentionUsers)] }
    }
    contents.push(content)
  }

  for (const seg of req.segments) {
    if (seg.type === "a2ui") {
      flush()
      const { html, hasInteractive } = a2uiToMatrixHtml(seg.content)
      const content: MatrixSendContent = {
        msgtype: OUTBOUND_MSGTYPE,
        body: seg.plainTextMirror || "[interactive message]",
        format: "org.matrix.custom.html",
        formatted_body: html || escapeHtml(seg.plainTextMirror || "[interactive message]"),
      }
      contents.push(content)
      if (hasInteractive) a2uiBinding = { surfaceId: seg.surfaceId }
    } else if (
      seg.type === "image" ||
      seg.type === "video" ||
      seg.type === "voice" ||
      seg.type === "file"
    ) {
      flush()
      contents.push({ kind: "media", segment: seg })
    } else {
      buffer.push(seg)
    }
  }
  flush()

  // Apply reply / thread relations. A Matrix thread relation must be carried
  // by EVERY event in the thread (message and media alike), or later chunks
  // render outside the thread. A plain reply annotates only the first chunk.
  if (contents.length > 0 && (req.replyTo || req.threadId)) {
    // Callers (workflow nodes, stored platformMessageIds) may hold the
    // adapter-public "<roomId>|<eventId>" composite — the wire relation
    // needs the bare event id.
    const replyTarget = req.replyTo ? bareMatrixEventId(req.replyTo.messageId) : undefined
    const threadRoot = req.threadId ? bareMatrixEventId(req.threadId) : undefined
    const rel: MatrixRelatesTo = {}
    if (threadRoot) {
      rel.rel_type = "m.thread"
      rel.event_id = threadRoot
      rel.is_falling_back = true
      rel["m.in_reply_to"] = { event_id: replyTarget ?? threadRoot }
    } else if (replyTarget) {
      rel["m.in_reply_to"] = { event_id: replyTarget }
    }
    const targets = req.threadId ? contents : [contents[0]]
    for (const chunk of targets) {
      if (chunk.kind === "media") chunk.relatesTo = rel
      else chunk["m.relates_to"] = rel
    }
  }

  return { contents, a2uiBinding }
}

/**
 * Link-line fallback for a media chunk whose upload to the Matrix media
 * repository failed (media repo error, unfetchable source URL, or web mode
 * where the Tauri upload command doesn't exist). This is the pre-upload
 * Phase 1 rendering — the recipient still gets the URL instead of the whole
 * send aborting.
 */
export function serializeMediaLinkFallback(seg: MatrixMediaChunk["segment"]): MatrixSendContent {
  return {
    msgtype: OUTBOUND_MSGTYPE,
    body: `[${seg.type}] ${seg.url}`,
    format: "org.matrix.custom.html",
    formatted_body: `<a href="${escapeAttr(seg.url)}">[${seg.type}]</a>`,
  }
}

/**
 * Plain-text fallback for a failed media upload whose source URL is NOT
 * shareable (local file paths, `asset://` URIs) — embedding it verbatim
 * would leak local paths into the room. Names the attachment so the
 * recipient at least knows something was meant to arrive.
 */
export function serializeMediaFailureNotice(name: string): MatrixSendContent {
  return {
    msgtype: OUTBOUND_MSGTYPE,
    body: `[attachment upload failed: ${name}]`,
  }
}

/**
 * Build the `m.replace` content for an in-place edit of `targetEventId`.
 */
export function serializeEdit(targetEventId: string, req: OutboundRequest): MatrixSendContent {
  const rendered = renderSegments(req.segments)
  const newContent: MatrixSendContent["m.new_content"] = {
    msgtype: OUTBOUND_MSGTYPE,
    body: rendered.body,
  }
  if (rendered.usedHtml) {
    newContent.format = "org.matrix.custom.html"
    newContent.formatted_body = rendered.formattedBody
  }
  if (rendered.mentionUsers.length > 0) {
    // Per the edit spec, `m.new_content` carries the replacement's mentions;
    // without them, clients drop mention pills/notifications on the edit.
    newContent["m.mentions"] = { user_ids: [...new Set(rendered.mentionUsers)] }
  }
  const content: MatrixSendContent = {
    // Fallback body for clients that don't render edits — Matrix convention
    // prefixes the replacement with "* ".
    msgtype: OUTBOUND_MSGTYPE,
    body: `* ${rendered.body}`,
    "m.new_content": newContent,
    "m.relates_to": { rel_type: "m.replace", event_id: bareMatrixEventId(targetEventId) },
  }
  if (rendered.usedHtml) {
    content.format = "org.matrix.custom.html"
    content.formatted_body = `* ${rendered.formattedBody}`
  }
  return content
}

/** Build the `m.reaction` (annotation) content for a bot reaction. */
export function serializeReaction(
  targetEventId: string,
  key: string
): { eventType: "m.reaction"; content: { "m.relates_to": MatrixRelatesTo } } {
  return {
    eventType: "m.reaction",
    content: { "m.relates_to": { rel_type: "m.annotation", event_id: targetEventId, key } },
  }
}
