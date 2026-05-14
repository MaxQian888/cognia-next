/**
 * ChatGPT export importer.
 *
 * Input: OpenAI's official export bundle — a `conversations.json` array,
 * one element per chat. Each element has a `mapping` tree (parent →
 * children) and a `current_node` pointing at the active leaf. The export
 * is branchy (regenerated turns become sibling nodes); we reconstruct the
 * linear history along the `current_node` ancestry so we don't double-
 * count regenerated outputs.
 *
 * Output: one `RawSource` per usable conversation in the bundle (so a
 * single uploaded `conversations.json` fans out to N twin sources). The
 * format on the resulting source is `markdown` so the existing parser
 * + chunker passthrough handles it without forking.
 */

import type { RawSource } from "@/lib/twin/ingest/parse"
import { conversationToRawSource, type ChatImporterOptions, type ChatMessageBlock } from "./types"

interface RawNode {
  id: string
  message: {
    id?: string
    author?: { role?: string; name?: string | null }
    create_time?: number | null
    content?: {
      content_type?: string
      parts?: unknown[]
    } | null
  } | null
  parent?: string | null
  children?: string[]
}

interface RawConversation {
  title?: string
  create_time?: number
  mapping: Record<string, RawNode>
  current_node?: string
}

function partsToText(parts: unknown[] | undefined): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .map((p) => {
      if (typeof p === "string") return p
      if (p && typeof p === "object") {
        const obj = p as { text?: unknown }
        if (typeof obj.text === "string") return obj.text
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()
}

function speakerOf(role: string | undefined, name: string | null | undefined): string {
  if (name) return name
  if (role === "user") return "User"
  if (role === "assistant") return "ChatGPT"
  if (role === "system") return "System"
  if (role === "tool") return "Tool"
  return role || "Unknown"
}

function pickDeepestLeaf(conv: RawConversation): string | undefined {
  let best: { id: string; ts: number } | null = null
  for (const node of Object.values(conv.mapping)) {
    if (!node?.message) continue
    const ts = node.message.create_time ?? 0
    if (!best || ts > best.ts) best = { id: node.id, ts }
  }
  return best?.id
}

function linearisePath(conv: RawConversation): RawNode[] {
  const path: RawNode[] = []
  const start = conv.current_node || pickDeepestLeaf(conv)
  if (!start) return path
  let cursor: string | undefined = start
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const node: RawNode | undefined = conv.mapping[cursor]
    if (!node) break
    path.push(node)
    cursor = node.parent ?? undefined
  }
  return path.reverse()
}

function conversationToBlocks(conv: RawConversation): ChatMessageBlock[] {
  const ordered = linearisePath(conv)
  const blocks: ChatMessageBlock[] = []
  for (const node of ordered) {
    const msg = node.message
    if (!msg?.author?.role) continue
    if (msg.author.role === "system") continue
    const body = partsToText(msg.content?.parts)
    if (!body) continue
    blocks.push({
      speaker: speakerOf(msg.author.role, msg.author.name),
      timestamp: msg.create_time ? Math.round(msg.create_time * 1000) : undefined,
      text: body,
      externalId: msg.id ?? node.id,
    })
  }
  return blocks
}

/**
 * Heuristic — does this JSON body look like a ChatGPT export? Caller (the
 * source uploader) uses this to set the default format on file upload.
 */
export function isChatgptExportShape(value: unknown): boolean {
  if (!value) return false
  const sample = Array.isArray(value) ? value[0] : value
  if (!sample || typeof sample !== "object") return false
  const obj = sample as { mapping?: unknown; current_node?: unknown }
  return typeof obj.mapping === "object" && obj.mapping !== null
}

/**
 * Parse a single ChatGPT export and emit one `RawSource` per usable
 * conversation. Throws on invalid JSON; returns `[]` on empty exports.
 */
export function parseChatgptExport(text: string, opts: ChatImporterOptions): RawSource[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as RawConversation | RawConversation[]
  const conversations = Array.isArray(parsed) ? parsed : [parsed]
  const sources: RawSource[] = []
  for (const conv of conversations) {
    if (!conv?.mapping) continue
    const blocks = conversationToBlocks(conv)
    const raw = conversationToRawSource({
      twinId: opts.twinId,
      title: conv.title?.trim() || opts.source || "ChatGPT conversation",
      blocks,
      label: "chatgpt",
      extraMetadata: { platform: "chatgpt" },
    })
    if (raw) sources.push(raw)
  }
  return sources
}
