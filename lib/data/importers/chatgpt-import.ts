// Parser for ChatGPT's `conversations.json` export.
//
// The OpenAI export bundles every chat into a single JSON array. Each entry
// has a `mapping` keyed by node id forming a tree (forks + edits). We
// linearize by walking from `current_node` back through `parent` pointers
// and reversing — the result is the conversation as the user last saw it.

import type { ImportedConversation, ChatImportOptions } from "./types"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"

interface ChatGPTConversation {
  title?: string
  create_time?: number
  update_time?: number
  current_node?: string
  mapping: Record<string, ChatGPTNode>
}

interface ChatGPTNode {
  id: string
  parent?: string | null
  children?: string[]
  message?: ChatGPTMessage | null
}

interface ChatGPTMessage {
  id: string
  create_time?: number | null
  author?: { role?: string; name?: string }
  content?: { content_type?: string; parts?: unknown[] } | string
  status?: string
  end_turn?: boolean | null
  metadata?: Record<string, unknown>
}

export function detectChatGPT(data: unknown): data is ChatGPTConversation[] {
  if (!Array.isArray(data) || data.length === 0) return false
  const first = data[0] as ChatGPTConversation | undefined
  return !!first && typeof first === "object" && !!first.mapping
}

export async function parseChatGPT(
  data: ChatGPTConversation[],
  opts: ChatImportOptions
): Promise<ImportedConversation[]> {
  const out: ImportedConversation[] = []
  for (const conv of data) {
    const linearized = linearize(conv)
    if (linearized.length === 0) continue
    const sessionId = newSessionId()
    const sessionCreatedAt = msFromMaybeSeconds(conv.create_time, Date.now())
    const sessionUpdatedAt = msFromMaybeSeconds(conv.update_time, sessionCreatedAt)
    const session: ChatSession = {
      id: sessionId,
      title: conv.title ?? opts.defaultTitle ?? "Imported from ChatGPT",
      kind: "direct",
      createdAt: sessionCreatedAt,
      updatedAt: sessionUpdatedAt,
    }
    const messages: StoredMessage[] = linearized.map((msg, i) =>
      toStoredMessage(msg, sessionId, i, sessionCreatedAt)
    )
    out.push({ session, messages })
  }
  return out
}

// ---------------------------------------------------------------------------

function linearize(conv: ChatGPTConversation): ChatGPTMessage[] {
  // Walk parent pointers from `current_node` backward, then reverse. If
  // current_node isn't set, fall back to the deepest leaf.
  const start = conv.current_node ?? findDeepestLeaf(conv)
  if (!start) return []

  const chain: ChatGPTMessage[] = []
  let cursor: string | undefined = start
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const node: ChatGPTConversation["mapping"][string] | undefined = conv.mapping[cursor]
    if (!node) break
    if (node.message && shouldKeep(node.message)) {
      chain.push(node.message)
    }
    cursor = node.parent ?? undefined
  }
  return chain.reverse()
}

function findDeepestLeaf(conv: ChatGPTConversation): string | undefined {
  // Pick any node with no children; ties broken by depth via parent chain length.
  const ids = Object.keys(conv.mapping)
  let best: string | undefined
  let bestDepth = -1
  for (const id of ids) {
    const node = conv.mapping[id]
    if (node.children && node.children.length > 0) continue
    let depth = 0
    let cursor: string | undefined = id
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      cursor = conv.mapping[cursor]?.parent ?? undefined
      depth++
    }
    if (depth > bestDepth) {
      bestDepth = depth
      best = id
    }
  }
  return best
}

function shouldKeep(message: ChatGPTMessage): boolean {
  // Drop "tether_browsing_display" and other non-text helper roles when the
  // content is empty.
  const text = extractText(message)
  if (!text) return false
  const role = message.author?.role
  return role === "user" || role === "assistant" || role === "system"
}

function extractText(message: ChatGPTMessage): string {
  const c = message.content
  if (!c) return ""
  if (typeof c === "string") return c
  if (Array.isArray((c as { parts?: unknown[] }).parts)) {
    const parts = (c as { parts: unknown[] }).parts
    return parts
      .map((p) => (typeof p === "string" ? p : safeJSON(p)))
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

function toStoredMessage(
  message: ChatGPTMessage,
  sessionId: string,
  index: number,
  sessionCreatedAt: number
): StoredMessage {
  const role = (message.author?.role ?? "assistant") as StoredMessage["role"]
  const text = extractText(message)
  const createdAt = msFromMaybeSeconds(message.create_time, sessionCreatedAt + index)
  return {
    id: newMessageId(message.id),
    sessionId,
    role: role === "user" || role === "assistant" || role === "system" ? role : "assistant",
    parts: [{ type: "text", text }],
    createdAt,
  }
}

function msFromMaybeSeconds(value: number | null | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback
  // ChatGPT stores unix seconds with microsecond precision; multiply if it
  // looks like seconds (small enough that 2030 still fits in a 32-bit-second).
  return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000)
}

function newSessionId(): string {
  return "s_imp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

function newMessageId(seed: string): string {
  return "m_imp_" + seed.slice(0, 8) + "_" + Math.random().toString(36).slice(2, 6)
}

function safeJSON(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}
