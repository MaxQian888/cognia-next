/**
 * WeChat chat-history importer.
 *
 * WeChat has no official export. Users rely on third-party tools
 * (chatlog / WechatExporter / WX2DB / Pylogger / Telegram-style bots) that
 * each emit slightly different formats. This importer handles three of
 * the most-common shapes and degrades gracefully — if none match, the
 * caller gets `[]` back so the UI can suggest paste-mode instead.
 *
 *   1. chatlog CSV-like: `Timestamp,Sender,Type,Content` per line
 *   2. WechatExporter JSON: `{ chats: [{ name, msgs: [{ from, content, time, type? }] }] }`
 *   3. Normalised flat array: `[{ user, text, ts, type? }]`
 *
 * Output: one `RawSource` per chat (so a multi-chat WechatExporter bundle
 * fans out to N twin sources).
 */

import type { RawSource } from "@/lib/twin/ingest/parse"
import {
  conversationToRawSource,
  parseChatExportJson,
  type ChatImporterOptions,
  type ChatMessageBlock,
} from "./types"

interface ChatlogBundle {
  // Some chatlog versions wrap rows in `{ messages: [...] }`.
  messages?: ChatlogRow[]
  // Others ship the raw array.
}

interface ChatlogRow {
  Timestamp?: string
  Sender?: string
  Type?: string
  Content?: string
}

interface ExporterChat {
  name?: string
  msgs?: ExporterMsg[]
}

interface ExporterMsg {
  from?: string
  content?: string
  time?: string | number
  type?: string | number
}

interface ExporterBundle {
  chats?: ExporterChat[]
}

interface NormalisedMsg {
  user?: string
  text?: string
  ts?: string | number
  type?: string
}

function parseTimestamp(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "number") return value >= 1e12 ? value : Math.round(value * 1000)
  const asNum = Number(value)
  if (Number.isFinite(asNum)) return asNum >= 1e12 ? asNum : Math.round(asNum * 1000)
  const isoish = value.includes("T") ? value : value.replace(" ", "T")
  const parsed = Date.parse(isoish)
  return Number.isFinite(parsed) ? parsed : undefined
}

function blocksFromChatlog(rows: ChatlogRow[]): ChatMessageBlock[] {
  const blocks: ChatMessageBlock[] = []
  for (const row of rows) {
    const type = row.Type?.toLowerCase?.()
    if (type && type !== "text" && type !== "1" && type !== "message") continue
    const text = (row.Content ?? "").trim()
    if (!text) continue
    blocks.push({
      speaker: (row.Sender ?? "").trim() || "Unknown",
      timestamp: parseTimestamp(row.Timestamp),
      text,
    })
  }
  return blocks
}

function blocksFromExporter(chat: ExporterChat): ChatMessageBlock[] {
  const msgs = chat.msgs ?? []
  const blocks: ChatMessageBlock[] = []
  for (const m of msgs) {
    const typeRaw = m.type
    // WechatExporter encodes type as int — 1=text, 3=image, 49=card etc.
    if (typeof typeRaw === "number" && typeRaw !== 1) continue
    if (
      typeof typeRaw === "string" &&
      typeRaw !== "1" &&
      typeRaw !== "text" &&
      typeRaw !== "message"
    ) {
      continue
    }
    const text = (m.content ?? "").trim()
    if (!text) continue
    blocks.push({
      speaker: m.from?.trim() || "Unknown",
      timestamp: parseTimestamp(m.time),
      text,
    })
  }
  return blocks
}

function blocksFromNormalised(arr: NormalisedMsg[]): ChatMessageBlock[] {
  const blocks: ChatMessageBlock[] = []
  for (const m of arr) {
    if (m.type && m.type !== "text") continue
    const text = (m.text ?? "").trim()
    if (!text) continue
    blocks.push({
      speaker: m.user?.trim() || "Unknown",
      timestamp: parseTimestamp(m.ts),
      text,
    })
  }
  return blocks
}

export function isWechatExportShape(value: unknown): boolean {
  if (!value) return false
  if (Array.isArray(value) && value.length > 0) {
    const sample = value[0] as Record<string, unknown>
    if (typeof sample.Sender === "string" || typeof sample.Content === "string") return true
    if (typeof sample.user === "string" && typeof sample.text === "string") return true
    return false
  }
  if (typeof value === "object") {
    const obj = value as ExporterBundle & ChatlogBundle
    if (Array.isArray(obj.chats)) return true
    if (Array.isArray(obj.messages)) return true
  }
  return false
}

export function parseWechatExport(text: string, opts: ChatImporterOptions): RawSource[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const parsed: unknown = parseChatExportJson(trimmed, "WeChat")
  const sources: RawSource[] = []
  if (Array.isArray(parsed)) {
    const first = (parsed as Array<Record<string, unknown>>)[0]
    let blocks: ChatMessageBlock[] = []
    if (first && (first.Sender !== undefined || first.Content !== undefined)) {
      blocks = blocksFromChatlog(parsed as ChatlogRow[])
    } else if (first && first.user !== undefined && first.text !== undefined) {
      blocks = blocksFromNormalised(parsed as NormalisedMsg[])
    }
    const raw = conversationToRawSource({
      twinId: opts.twinId,
      title: opts.source || "WeChat chat",
      blocks,
      label: "wechat",
      extraMetadata: { platform: "wechat" },
    })
    if (raw) sources.push(raw)
    return sources
  }
  if (parsed && typeof parsed === "object") {
    const bundle = parsed as ExporterBundle & ChatlogBundle
    if (Array.isArray(bundle.chats)) {
      for (const chat of bundle.chats) {
        const blocks = blocksFromExporter(chat)
        const raw = conversationToRawSource({
          twinId: opts.twinId,
          title: chat.name?.trim() || opts.source || "WeChat chat",
          blocks,
          label: "wechat",
          extraMetadata: { platform: "wechat" },
        })
        if (raw) sources.push(raw)
      }
      return sources
    }
    if (Array.isArray(bundle.messages)) {
      const blocks = blocksFromChatlog(bundle.messages)
      const raw = conversationToRawSource({
        twinId: opts.twinId,
        title: opts.source || "WeChat chat",
        blocks,
        label: "wechat",
        extraMetadata: { platform: "wechat" },
      })
      if (raw) sources.push(raw)
      return sources
    }
  }
  return sources
}
