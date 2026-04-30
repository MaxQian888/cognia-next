// Parser for Claude.ai's `conversations.json` export.
//
// Each conversation has a flat `chat_messages` array — much simpler than
// ChatGPT's tree. Roles are `human` / `assistant`; we map `human` → `user`.

import type { ImportedConversation, ChatImportOptions } from "./types"
import type { ChatSession, StoredMessage } from "@/lib/claude/types"

interface ClaudeConversation {
  uuid: string
  name?: string
  created_at?: string
  updated_at?: string
  chat_messages: ClaudeMessage[]
}

interface ClaudeMessage {
  uuid: string
  text?: string
  sender: "human" | "assistant" | string
  created_at?: string
  updated_at?: string
  content?: Array<{ type: string; text?: string }>
}

export function detectClaude(data: unknown): data is ClaudeConversation[] {
  if (!Array.isArray(data) || data.length === 0) return false
  const first = data[0] as ClaudeConversation | undefined
  return (
    !!first &&
    typeof first === "object" &&
    typeof first.uuid === "string" &&
    Array.isArray(first.chat_messages)
  )
}

export async function parseClaude(
  data: ClaudeConversation[],
  opts: ChatImportOptions
): Promise<ImportedConversation[]> {
  const out: ImportedConversation[] = []
  for (const conv of data) {
    if (!Array.isArray(conv.chat_messages) || conv.chat_messages.length === 0) continue
    const sessionId = newSessionId()
    const createdAt = parseISO(conv.created_at) ?? Date.now()
    const updatedAt = parseISO(conv.updated_at) ?? createdAt
    const session: ChatSession = {
      id: sessionId,
      title: conv.name ?? opts.defaultTitle ?? "Imported from Claude",
      kind: "direct",
      createdAt,
      updatedAt,
    }
    const messages: StoredMessage[] = conv.chat_messages
      .map((msg, i) => toStoredMessage(msg, sessionId, i, createdAt))
      .filter((m): m is StoredMessage => m !== null)
    // Skip conversations whose messages all got filtered out — an empty
    // session adds noise to the UI without carrying any content.
    if (messages.length === 0) continue
    out.push({ session, messages })
  }
  return out
}

function toStoredMessage(
  message: ClaudeMessage,
  sessionId: string,
  index: number,
  baseCreatedAt: number
): StoredMessage | null {
  const text = extractText(message)
  if (!text) return null
  const role: StoredMessage["role"] = message.sender === "human" ? "user" : "assistant"
  const createdAt = parseISO(message.created_at) ?? baseCreatedAt + index
  return {
    id: newMessageId(message.uuid),
    sessionId,
    role,
    parts: [{ type: "text", text }],
    createdAt,
  }
}

function extractText(message: ClaudeMessage): string {
  if (typeof message.text === "string" && message.text.length > 0) return message.text
  if (Array.isArray(message.content)) {
    return message.content
      .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

function parseISO(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function newSessionId(): string {
  return "s_imp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

function newMessageId(seed: string): string {
  return "m_imp_" + seed.slice(0, 8) + "_" + Math.random().toString(36).slice(2, 6)
}
