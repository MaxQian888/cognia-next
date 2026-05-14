/**
 * DingTalk group-chat export importer.
 *
 * DingTalk's mobile export is plain text. Each message is rendered as:
 *
 *   [YYYY-MM-DD HH:mm:ss] 昵称
 *   message body line 1
 *   message body line 2
 *
 *   [YYYY-MM-DD HH:mm:ss] 昵称
 *   ...
 *
 * The desktop "Export chat history" feature also offers a JSON shape:
 *
 *   { groupName, messages: [{ senderName, sendTime, content, type? }] }
 *
 * Both are handled. Output: one `RawSource` (one chat file → one source).
 */

import type { RawSource } from "@/lib/twin/ingest/parse"
import { conversationToRawSource, type ChatImporterOptions, type ChatMessageBlock } from "./types"

interface JsonMessage {
  senderName?: string
  sender_name?: string
  sendTime?: string | number
  send_time?: string | number
  content?: string
  text?: string
  type?: string
  msgType?: string
}

interface JsonBundle {
  groupName?: string
  chatName?: string
  messages?: JsonMessage[]
}

const HEADER_RE = /^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\]\s+(.+?)\s*$/u

function parseTimestamp(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "number") {
    return value >= 1e12 ? value : Math.round(value * 1000)
  }
  // DingTalk JSON often uses "YYYY-MM-DD HH:mm:ss" — accept both Z and space-naive.
  const isoish = value.includes("T") ? value : value.replace(" ", "T")
  const parsed = Date.parse(isoish)
  return Number.isFinite(parsed) ? parsed : undefined
}

function blocksFromText(text: string): ChatMessageBlock[] {
  const blocks: ChatMessageBlock[] = []
  const lines = text.split(/\r?\n/)
  let current: ChatMessageBlock | null = null
  const bodyLines: string[] = []
  const flush = () => {
    if (current) {
      current.text = bodyLines.join("\n").trim()
      if (current.text) blocks.push(current)
    }
    current = null
    bodyLines.length = 0
  }
  for (const rawLine of lines) {
    const m = HEADER_RE.exec(rawLine)
    if (m) {
      flush()
      const stamp = m[1]
      current = {
        speaker: m[2].trim() || "Unknown",
        timestamp: parseTimestamp(stamp),
        text: "",
      }
      continue
    }
    if (current) {
      bodyLines.push(rawLine)
    }
  }
  flush()
  return blocks
}

function blocksFromJson(bundle: JsonBundle): ChatMessageBlock[] {
  const messages = bundle.messages ?? []
  const blocks: ChatMessageBlock[] = []
  for (const m of messages) {
    const type = m.type ?? m.msgType
    if (type && type !== "text" && type !== "message") continue
    const text = (m.content ?? m.text ?? "").trim()
    if (!text) continue
    blocks.push({
      speaker: m.senderName?.trim() || m.sender_name?.trim() || "Unknown",
      timestamp: parseTimestamp(m.sendTime ?? m.send_time),
      text,
    })
  }
  return blocks
}

export function isDingtalkTextShape(text: string): boolean {
  const lines = text.split(/\r?\n/).slice(0, 30)
  return lines.some((l) => HEADER_RE.test(l))
}

export function isDingtalkJsonShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const obj = value as JsonBundle
  if (!Array.isArray(obj.messages)) return false
  const m = obj.messages[0]
  if (!m) return false
  return (
    typeof m.senderName === "string" ||
    typeof m.sender_name === "string" ||
    typeof m.sendTime === "string" ||
    typeof m.send_time === "string"
  )
}

export function parseDingtalkExport(text: string, opts: ChatImporterOptions): RawSource[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  // Try JSON first; fall back to the bracket-text format.
  let blocks: ChatMessageBlock[] = []
  let title = opts.source || "DingTalk chat"
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        blocks = blocksFromJson({ messages: parsed as JsonMessage[] })
      } else if (parsed && typeof parsed === "object") {
        const bundle = parsed as JsonBundle
        blocks = blocksFromJson(bundle)
        title = bundle.groupName?.trim() || bundle.chatName?.trim() || title
      }
    } catch {
      blocks = blocksFromText(trimmed)
    }
  } else {
    blocks = blocksFromText(trimmed)
  }
  const raw = conversationToRawSource({
    twinId: opts.twinId,
    title,
    blocks,
    label: "dingtalk",
    extraMetadata: { platform: "dingtalk" },
  })
  return raw ? [raw] : []
}
