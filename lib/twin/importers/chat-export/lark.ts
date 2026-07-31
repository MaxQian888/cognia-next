/**
 * Lark / Feishu group-chat export importer.
 *
 * Lark's export bundle ships a JSON per chat with a top-level `messages`
 * array. Field names vary by exporter version; we accept three commonly-
 * seen shapes:
 *
 *   1. The official Lark `chat_messages` export:
 *      `{ chat_name, messages: [{ msg_id, sender_name, create_time,
 *                                 msg_type: "text", content: { text } }] }`
 *   2. The `groupId/messages.json` shape from the unofficial CLI:
 *      `{ groupName, messages: [{ uuid, from, ts, type, body }] }`
 *   3. A flat array of normalised messages produced by community scripts:
 *      `[{ user, text, ts }]`
 *
 * All three normalise to the canonical `ChatMessageBlock[]` and a single
 * `RawSource` with format=markdown.
 */

import type { RawSource } from "@/lib/twin/ingest/parse"
import {
  conversationToRawSource,
  parseChatExportJson,
  type ChatImporterOptions,
  type ChatMessageBlock,
} from "./types"

interface OfficialMessage {
  msg_id?: string
  sender_name?: string
  sender_id?: string
  create_time?: number | string
  msg_type?: string
  content?: { text?: string; richText?: string } | string
  reply_to?: string
  thread_id?: string
}

interface UnofficialMessage {
  uuid?: string
  from?: string
  ts?: number | string
  type?: string
  body?: string
  thread_id?: string
}

interface NormalisedMessage {
  user?: string
  text?: string
  ts?: number | string
  thread_id?: string
}

interface OfficialBundle {
  chat_name?: string
  messages?: OfficialMessage[]
}

interface UnofficialBundle {
  groupName?: string
  messages?: UnofficialMessage[]
}

function parseTs(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === "number") {
    // Lark exports use seconds for `create_time`; if the value looks like a
    // ms-since-epoch (≥ 1e12) keep it, else treat as seconds.
    return value >= 1e12 ? value : Math.round(value * 1000)
  }
  // ISO string or numeric string
  const asNum = Number(value)
  if (Number.isFinite(asNum)) return asNum >= 1e12 ? asNum : Math.round(asNum * 1000)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function pickContent(content: OfficialMessage["content"]): string {
  if (typeof content === "string") return content.trim()
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text.trim()
    if (typeof content.richText === "string") return content.richText.trim()
  }
  return ""
}

function blocksFromOfficial(bundle: OfficialBundle): ChatMessageBlock[] {
  const messages = bundle.messages ?? []
  const blocks: ChatMessageBlock[] = []
  for (const m of messages) {
    if (m.msg_type && m.msg_type !== "text" && m.msg_type !== "post") continue
    const text = pickContent(m.content)
    if (!text) continue
    blocks.push({
      speaker: m.sender_name?.trim() || m.sender_id || "Unknown",
      timestamp: parseTs(m.create_time),
      text,
      threadId: m.thread_id,
      externalId: m.msg_id,
    })
  }
  return blocks
}

function blocksFromUnofficial(bundle: UnofficialBundle): ChatMessageBlock[] {
  const messages = bundle.messages ?? []
  const blocks: ChatMessageBlock[] = []
  for (const m of messages) {
    if (m.type && m.type !== "text") continue
    const text = (m.body || "").trim()
    if (!text) continue
    blocks.push({
      speaker: m.from?.trim() || "Unknown",
      timestamp: parseTs(m.ts),
      text,
      threadId: m.thread_id,
      externalId: m.uuid,
    })
  }
  return blocks
}

function blocksFromNormalised(arr: NormalisedMessage[]): ChatMessageBlock[] {
  const blocks: ChatMessageBlock[] = []
  for (const m of arr) {
    const text = (m.text || "").trim()
    if (!text) continue
    blocks.push({
      speaker: m.user?.trim() || "Unknown",
      timestamp: parseTs(m.ts),
      text,
      threadId: m.thread_id,
    })
  }
  return blocks
}

export function isLarkExportShape(value: unknown): boolean {
  if (!value) return false
  if (Array.isArray(value) && value.length > 0) {
    const sample = value[0] as { user?: unknown; text?: unknown; ts?: unknown }
    return typeof sample.user === "string" && typeof sample.text === "string"
  }
  if (typeof value === "object") {
    const obj = value as { chat_name?: unknown; messages?: unknown; groupName?: unknown }
    if (typeof obj.chat_name === "string" && Array.isArray(obj.messages)) return true
    if (typeof obj.groupName === "string" && Array.isArray(obj.messages)) return true
  }
  return false
}

export function parseLarkExport(text: string, opts: ChatImporterOptions): RawSource[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const parsed: unknown = parseChatExportJson(trimmed, "Lark")
  let blocks: ChatMessageBlock[] = []
  let title = opts.source || "Lark chat"
  if (Array.isArray(parsed)) {
    blocks = blocksFromNormalised(parsed as NormalisedMessage[])
  } else if (parsed && typeof parsed === "object") {
    const asOfficial = parsed as OfficialBundle
    const asUnofficial = parsed as UnofficialBundle
    if (Array.isArray(asOfficial.messages) && asOfficial.chat_name !== undefined) {
      blocks = blocksFromOfficial(asOfficial)
      title = asOfficial.chat_name?.trim() || title
    } else if (Array.isArray(asUnofficial.messages) && asUnofficial.groupName !== undefined) {
      blocks = blocksFromUnofficial(asUnofficial)
      title = asUnofficial.groupName?.trim() || title
    } else if (Array.isArray(asOfficial.messages)) {
      // Unlabelled bundle — try the official shape and fall back to unofficial.
      blocks = blocksFromOfficial(asOfficial)
      if (blocks.length === 0) blocks = blocksFromUnofficial(asUnofficial)
    }
  }
  const raw = conversationToRawSource({
    twinId: opts.twinId,
    title,
    blocks,
    label: "lark",
    extraMetadata: { platform: "lark" },
  })
  return raw ? [raw] : []
}
