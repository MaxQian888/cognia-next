// Parser for Google Gemini / Bard exports (Google Takeout format).
//
// Takeout produces `MyActivity.json` with a flat array of activity records:
//   { title: "...", titleUrl: "...", time: "ISO", header: "Bard"|"Gemini" }
// We treat every "asked X" entry as a user turn and every "Bard answered"
// (or "Gemini answered") as an assistant turn, pairing them in time order.

import type { ImportedConversation, ChatImportOptions } from "./types"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"

interface GeminiActivity {
  header?: string
  title?: string
  titleUrl?: string
  time?: string
  details?: Array<{ name?: string }>
  products?: string[]
  subtitles?: Array<{ name?: string }>
}

export function detectGemini(data: unknown): data is GeminiActivity[] {
  if (!Array.isArray(data) || data.length === 0) return false
  const first = data[0] as GeminiActivity | undefined
  if (!first || typeof first !== "object") return false
  const header = (first.header ?? "").toString().toLowerCase()
  // Match Bard, Gemini Apps, Gemini, Google AI Studio.
  return (
    header.includes("bard") ||
    header.includes("gemini") ||
    (Array.isArray(first.products) && first.products.some((p) => /bard|gemini/i.test(p)))
  )
}

export async function parseGemini(
  data: GeminiActivity[],
  opts: ChatImportOptions
): Promise<ImportedConversation[]> {
  // Sort by time so we can pair user/assistant turns in order.
  const sorted = [...data].sort((a, b) => {
    const ta = parseISO(a.time) ?? 0
    const tb = parseISO(b.time) ?? 0
    return ta - tb
  })

  // Group adjacent user-question + answer pairs into a single conversation.
  // Gemini Takeout doesn't preserve session boundaries; we use a 30-minute
  // gap as the heuristic.
  const SESSION_GAP_MS = 30 * 60 * 1000
  const conversations: GeminiActivity[][] = []
  let current: GeminiActivity[] = []
  let lastTime = -Infinity
  for (const act of sorted) {
    const t = parseISO(act.time) ?? 0
    if (t - lastTime > SESSION_GAP_MS && current.length > 0) {
      conversations.push(current)
      current = []
    }
    current.push(act)
    lastTime = t
  }
  if (current.length > 0) conversations.push(current)

  const out: ImportedConversation[] = []
  for (const group of conversations) {
    const messages: StoredMessage[] = []
    const sessionId = newSessionId()
    let firstUserText: string | null = null
    const baseCreatedAt = parseISO(group[0]?.time) ?? Date.now()

    for (let i = 0; i < group.length; i++) {
      const act = group[i]
      const t = parseISO(act.time) ?? baseCreatedAt + i
      const titleText = stripHtmlPrefix(act.title ?? "")
      if (!titleText) continue
      const isUser =
        titleText.toLowerCase().startsWith("asked") ||
        titleText.toLowerCase().startsWith("you asked") ||
        titleText.toLowerCase().startsWith("prompted")
      const role: StoredMessage["role"] = isUser ? "user" : "assistant"
      const text = extractText(titleText)
      if (!text) continue
      if (firstUserText === null && isUser) firstUserText = text
      messages.push({
        id: newMessageId(),
        sessionId,
        role,
        parts: [{ type: "text", text }],
        createdAt: t,
      })
    }

    if (messages.length === 0) continue
    const session: ChatSession = {
      id: sessionId,
      title:
        firstUserText && firstUserText.length > 0
          ? truncate(firstUserText, 50)
          : (opts.defaultTitle ?? "Imported from Gemini"),
      kind: "direct",
      createdAt: baseCreatedAt,
      updatedAt: messages[messages.length - 1].createdAt,
    }
    out.push({ session, messages })
  }
  return out
}

// ---------------------------------------------------------------------------

function extractText(title: string): string {
  // Strip the leading "Asked: " or "Bard answered: " labels.
  const colon = title.indexOf(":")
  if (colon > 0 && colon < 32) {
    return title.slice(colon + 1).trim()
  }
  return title.trim()
}

function stripHtmlPrefix(value: string): string {
  // Some Takeout entries embed HTML (`<a href="...">prompt</a>`). Render to
  // plain text by stripping all tags.
  return value.replace(/<[^>]+>/g, "")
}

function parseISO(value: string | undefined): number | null {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + "…"
}

function newSessionId(): string {
  return "s_imp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

function newMessageId(): string {
  return "m_imp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}
