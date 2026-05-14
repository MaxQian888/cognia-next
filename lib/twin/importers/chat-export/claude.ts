/**
 * Claude.ai conversation export importer.
 *
 * Claude's "Download data" produces `conversations.json` with a flat
 * per-conversation shape:
 *   [{
 *     uuid, name, created_at, updated_at,
 *     chat_messages: [
 *       { uuid, text, sender: "human"|"assistant", created_at,
 *         content?: Array<{ type: "text"; text: string }>
 *       }, …
 *     ]
 *   }, …]
 *
 * Output: one `RawSource` per usable conversation. Format: markdown.
 */

import type { RawSource } from "@/lib/twin/ingest/parse"
import { conversationToRawSource, type ChatImporterOptions, type ChatMessageBlock } from "./types"

interface RawChatMessage {
  uuid?: string
  text?: string
  content?: Array<{ type?: string; text?: string }>
  sender?: string
  created_at?: string
}

interface RawConversation {
  uuid?: string
  name?: string
  created_at?: string
  updated_at?: string
  chat_messages?: RawChatMessage[]
}

function pickText(msg: RawChatMessage): string {
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    return msg.content
      .map((seg) => (typeof seg.text === "string" ? seg.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim()
  }
  return typeof msg.text === "string" ? msg.text.trim() : ""
}

function speakerOf(sender: string | undefined): string {
  if (sender === "human") return "User"
  if (sender === "assistant") return "Claude"
  return sender || "Unknown"
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

export function isClaudeExportShape(value: unknown): boolean {
  if (!value) return false
  const sample = Array.isArray(value) ? value[0] : value
  if (!sample || typeof sample !== "object") return false
  const obj = sample as { chat_messages?: unknown }
  return Array.isArray(obj.chat_messages)
}

export function parseClaudeExport(text: string, opts: ChatImporterOptions): RawSource[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as RawConversation | RawConversation[]
  const conversations = Array.isArray(parsed) ? parsed : [parsed]
  const sources: RawSource[] = []
  for (const conv of conversations) {
    const messages = conv?.chat_messages
    if (!Array.isArray(messages) || messages.length === 0) continue
    const blocks: ChatMessageBlock[] = []
    for (const msg of messages) {
      const body = pickText(msg)
      if (!body) continue
      blocks.push({
        speaker: speakerOf(msg.sender),
        timestamp: parseTimestamp(msg.created_at),
        text: body,
        externalId: msg.uuid,
      })
    }
    const raw = conversationToRawSource({
      twinId: opts.twinId,
      title: conv.name?.trim() || opts.source || "Claude conversation",
      blocks,
      label: "claude",
      extraMetadata: { platform: "claude" },
    })
    if (raw) sources.push(raw)
  }
  return sources
}
