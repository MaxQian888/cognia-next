/**
 * OutboundRequest → DingTalk OpenAPI proactive-send payload.
 *
 * The adapter's `send()` uses the documented proactive-send endpoints with the
 * `sampleText` / `sampleMarkdown` message templates (the `sessionWebhook`
 * reply URL is transient and may have expired by the time the durable outbound
 * queue runs, so we never rely on it). Each `OutboundRequest` collapses to a
 * single `{ msgKey, msgParam }` pair; `msgParam` must be JSON-stringified by
 * the caller before it hits the wire.
 *
 * A2UI surfaces project to DingTalk markdown (see {@link a2uiToDingTalkMarkdown}).
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import type { A2UISegmentContent, MessageSegment } from "@/types/connectors/segment"
import { walkA2UISurface } from "@/lib/connectors/adapters/_shared/a2ui-mapper"

export type DingTalkMsgKey = "sampleText" | "sampleMarkdown"

export interface DingTalkSerialized {
  msgKey: DingTalkMsgKey
  /** Object form; the caller JSON-stringifies it into the `msgParam` field. */
  msgParam: Record<string, string>
}

function stringValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}

/**
 * Project an A2UI surface into DingTalk markdown. Native components map to
 * markdown constructs; a link/href button becomes a clickable markdown link;
 * callback-only buttons and other interactive components are listed under an
 * "操作" heading so the user can type their choice back (the simulated channel).
 */
export function a2uiToDingTalkMarkdown(content: A2UISegmentContent): string {
  const lines: string[] = []
  const actions: string[] = []

  walkA2UISurface(content, (node) => {
    switch (node.component) {
      case "Text": {
        const t = stringValue(node.raw.text)
        if (t) lines.push(t)
        break
      }
      case "Card": {
        const title = stringValue(node.raw.title)
        if (title) lines.push(`### ${title}`)
        const desc = stringValue(node.raw.description)
        if (desc) lines.push(desc)
        break
      }
      case "Alert": {
        const title = stringValue(node.raw.title)
        const text = stringValue(node.raw.message) || stringValue(node.raw.text)
        const inner = [title, text].filter(Boolean).join(": ")
        if (inner) lines.push(`> ⚠️ ${inner}`)
        break
      }
      case "Link": {
        const href = stringValue(node.raw.href)
        const label = stringValue(node.raw.text) || href
        if (href) lines.push(`[${label}](${href})`)
        else if (label) lines.push(label)
        break
      }
      case "Image": {
        const src = stringValue(node.raw.src)
        const alt = stringValue(node.raw.alt) || "image"
        if (src) lines.push(`![${alt}](${src})`)
        break
      }
      case "Divider":
        lines.push("\n---\n")
        break
      case "Button": {
        const label = stringValue(node.raw.text) || stringValue(node.raw.action) || "Action"
        const href = stringValue(node.raw.href) || stringValue(node.raw.url)
        if (href) lines.push(`[${label}](${href})`)
        else actions.push(label)
        break
      }
      case "Select":
      case "RadioGroup": {
        const label = stringValue(node.raw.label) || "Select"
        const options = Array.isArray(node.raw.options)
          ? (node.raw.options as Array<Record<string, unknown>>)
          : []
        for (const opt of options) {
          const ol = stringValue(opt.label) || stringValue(opt.value)
          if (ol) actions.push(`${label}: ${ol}`)
        }
        break
      }
      case "TextField":
      case "TextArea": {
        const label = stringValue(node.raw.label) || stringValue(node.raw.placeholder) || "input"
        actions.push(`${label}: ___`)
        break
      }
      case "Row":
      case "Column":
      case "List":
        break
      default:
        break
    }
  })

  if (actions.length > 0) {
    lines.push("\n**操作 / Available actions:**")
    for (const a of actions) lines.push(`- ${a}`)
  }
  return lines.join("\n")
}

/**
 * Collapse an OutboundRequest into one DingTalk message. Returns `null` when
 * there is nothing renderable to send.
 */
export function serializeOutbound(req: OutboundRequest): DingTalkSerialized | null {
  const textParts: string[] = []
  const mdParts: string[] = []
  let usedMarkdown = false

  const renderPlain = (segments: MessageSegment[]): void => {
    for (const seg of segments) {
      switch (seg.type) {
        case "text":
          textParts.push(seg.text)
          mdParts.push(seg.text)
          break
        case "markdown":
          textParts.push(seg.md)
          mdParts.push(seg.md)
          usedMarkdown = true
          break
        case "mention": {
          const label = seg.displayName ?? seg.userId
          textParts.push(`@${label}`)
          mdParts.push(`@${label}`)
          break
        }
        case "emoji":
          textParts.push(seg.code)
          mdParts.push(seg.code)
          break
        case "image":
        case "video":
        case "voice":
        case "file":
          textParts.push(`[${seg.type}] ${seg.url}`)
          mdParts.push(`[${seg.type}](${seg.url})`)
          usedMarkdown = true
          break
        case "code":
          textParts.push(seg.code)
          mdParts.push("```\n" + seg.code + "\n```")
          usedMarkdown = true
          break
        case "a2ui": {
          const md = a2uiToDingTalkMarkdown(seg.content) || seg.plainTextMirror
          textParts.push(seg.plainTextMirror)
          mdParts.push(md)
          usedMarkdown = true
          break
        }
        default:
          break
      }
    }
  }

  renderPlain(req.segments)

  const plain = textParts.join("\n").trim()
  const markdown = mdParts.join("\n\n").trim()
  if (!plain && !markdown) return null

  if (usedMarkdown) {
    const title = deriveTitle(markdown) || "Message"
    return { msgKey: "sampleMarkdown", msgParam: { title, text: markdown } }
  }
  return { msgKey: "sampleText", msgParam: { content: plain } }
}

/** First non-empty markdown line (stripped of markdown syntax) as the card title. */
function deriveTitle(markdown: string): string {
  for (const raw of markdown.split("\n")) {
    const line = raw
      .replace(/^#+\s*/, "")
      .replace(/[*_>`-]/g, "")
      .trim()
    if (line) return line.slice(0, 40)
  }
  return ""
}

// ---------------------------------------------------------------------------
// Platform message ids + recall (撤回)
// ---------------------------------------------------------------------------

/**
 * What `send()` encodes into `platformMessageId` so a later `delete()` can
 * route the recall. DingTalk's proactive-send endpoints answer with a
 * `processQueryKey` (not a message id) and the recall endpoints are scoped by
 * robot + scene, so all three must travel together:
 *   - group → `POST /v1.0/robot/groupMessages/recall`
 *             `{ robotCode, openConversationId, processQueryKeys: [key] }`
 *   - oto   → `POST /v1.0/robot/otoMessages/batchRecall`
 *             `{ robotCode, processQueryKeys: [key] }`
 * A message posted through the transient `sessionWebhook` returns no key and
 * therefore cannot be recalled (send() leaves `platformMessageId` undefined).
 * UNVERIFIED: whether the recall accepts a `robotCode` other than the one
 * that sent the message — we always echo the sending robotCode.
 */
export interface DingTalkMessageId {
  robotCode: string
  scope: "group" | "oto"
  /** Required for `scope: "group"`; ignored for `oto`. */
  openConversationId?: string
  processQueryKey: string
}

const DINGTALK_MESSAGE_ID_PREFIX = "dt"

/** `dt:<scope>:<robotCode>:<openConversationId|->:<processQueryKey>` — parts URI-encoded. */
export function encodeDingTalkMessageId(id: DingTalkMessageId): string {
  return [
    DINGTALK_MESSAGE_ID_PREFIX,
    id.scope,
    encodeURIComponent(id.robotCode),
    id.scope === "group" ? encodeURIComponent(id.openConversationId ?? "") : "-",
    encodeURIComponent(id.processQueryKey),
  ].join(":")
}

/**
 * Decode an id produced by {@link encodeDingTalkMessageId}. Returns null for
 * anything else (a bare processQueryKey, a foreign id) — callers fail loudly.
 */
export function decodeDingTalkMessageId(messageId: string): DingTalkMessageId | null {
  const parts = messageId.split(":")
  if (parts.length !== 5 || parts[0] !== DINGTALK_MESSAGE_ID_PREFIX) return null
  const scope = parts[1]
  if (scope !== "group" && scope !== "oto") return null
  const robotCode = decodeURIComponent(parts[2])
  const processQueryKey = decodeURIComponent(parts[4])
  if (!robotCode || !processQueryKey) return null
  if (scope === "group") {
    const openConversationId = decodeURIComponent(parts[3])
    if (!openConversationId) return null
    return { scope, robotCode, openConversationId, processQueryKey }
  }
  return { scope, robotCode, processQueryKey }
}

export interface DingTalkRecallCall {
  path: string
  payload: Record<string, unknown>
}

/** Build the recall call for a decoded message id (see {@link DingTalkMessageId}). */
export function serializeRecall(id: DingTalkMessageId): DingTalkRecallCall {
  if (id.scope === "group") {
    return {
      path: "/v1.0/robot/groupMessages/recall",
      payload: {
        robotCode: id.robotCode,
        openConversationId: id.openConversationId,
        processQueryKeys: [id.processQueryKey],
      },
    }
  }
  return {
    path: "/v1.0/robot/otoMessages/batchRecall",
    payload: { robotCode: id.robotCode, processQueryKeys: [id.processQueryKey] },
  }
}
