/**
 * Conversation summarization.
 *
 * Two entry points:
 *
 *  • `summarizeConversation` — the real LLM path. Given a `LlmClient` (built by
 *    the caller via `buildUtilityLlmClient`, exactly like title / turn-label
 *    generation) it asks a cheap model for a concise, neutral summary of a
 *    conversation slice. Used by the "summarize-then-branch" flow
 *    (`components/chat/branch-dialog.tsx` → `lib/chat/branch-session.ts`) so a
 *    branch can carry a compact context seed instead of the full transcript.
 *    Falls back to the structural summary when no client is available (web mode
 *    with no key, provider unresolved) or the call fails.
 *
 *  • `generateAICompressionSummary` — legacy structural fallback kept for the
 *    context-window compression path. Never calls a model; produces a
 *    head/tail digest so callers always get usable output. Now shares the
 *    `structuralSummary` core and the canonical `extractPlainText` projector.
 *
 * This module owns only the prompt + text projection so it stays pure and
 * unit-testable with a mock `LlmClient`.
 */

import type { UIMessage } from "ai"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"

const ROLE_LABEL: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
}

const SYSTEM_PROMPT =
  "You summarize a chat conversation so it can seed a new branch of the same " +
  "discussion. Write a concise, neutral summary that preserves: the user's " +
  "goal, key facts and decisions, any constraints, and open / unresolved " +
  "threads. Use short paragraphs or bullet points. Do not add a preamble like " +
  "'Here is a summary'. Write in the same language as the conversation."

/** Hard ceiling on transcript characters fed to the model (keeps cost bounded). */
const MAX_TRANSCRIPT_CHARS = 24_000

/**
 * Render a conversation slice as a plain-text transcript. Empty turns
 * (tool-only assistant steps) are skipped. Exported for tests.
 */
export function renderConversation(messages: UIMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const text = extractPlainText(m.parts)
    if (!text) continue
    lines.push(`${ROLE_LABEL[m.role] ?? m.role}: ${text}`)
  }
  return lines.join("\n\n")
}

/**
 * Deterministic, model-free digest: head + tail of the conversation with an
 * elision marker. Always returns usable text. Exported for tests and reused as
 * the fallback for {@link summarizeConversation}.
 */
export function structuralSummary(messages: UIMessage[]): string {
  if (messages.length === 0) return ""
  const line = (m: UIMessage) => {
    const text = extractPlainText(m.parts).slice(0, 120)
    return `${ROLE_LABEL[m.role] ?? m.role}: ${text || `[${m.role}]`}`
  }
  if (messages.length <= 6) {
    return [`[Conversation: ${messages.length} messages]`, ...messages.map(line)].join("\n")
  }
  const head = messages.slice(0, 3)
  const tail = messages.slice(-3)
  return [
    `[Conversation: ${messages.length} messages]`,
    "Beginning:",
    ...head.map(line),
    `…(${messages.length - 6} messages elided)…`,
    "Recent:",
    ...tail.map(line),
  ].join("\n")
}

export interface SummarizeOptions {
  /** Utility LLM client (from `buildUtilityLlmClient`). When null/omitted, the structural fallback is used. */
  client?: LlmClient | null
  /** UI locale so the summary language matches the user. */
  locale?: string
  /** Cancellation signal forwarded to the LLM call. */
  signal?: AbortSignal
}

/**
 * Summarize a conversation slice. Returns the LLM summary when a client is
 * available and the call succeeds; otherwise the structural digest. Never
 * throws — callers always get usable text.
 */
export async function summarizeConversation(
  messages: UIMessage[],
  opts: SummarizeOptions = {}
): Promise<string> {
  if (messages.length === 0) return ""
  const { client, locale, signal } = opts
  if (!client) return structuralSummary(messages)

  const transcript = renderConversation(messages)
  if (!transcript) return structuralSummary(messages)

  const localeHint = locale ? `UI locale: ${locale}\n\n` : ""
  const prompt = `${localeHint}Conversation to summarize:\n\n${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`

  try {
    const text = await client.complete(prompt, {
      system: SYSTEM_PROMPT,
      temperature: 0.3,
      maxTokens: 600,
      abortSignal: signal,
    })
    const trimmed = (text ?? "").trim()
    return trimmed || structuralSummary(messages)
  } catch {
    return structuralSummary(messages)
  }
}

/**
 * Legacy structural compression summary (no LLM). Kept for the context-window
 * compression path; signature preserved. Prefer {@link summarizeConversation}
 * for new callers.
 */
export async function generateAICompressionSummary(
  messages: UIMessage[],
  _config: { provider: string; model: string; apiKey: string; baseURL?: string },
  _targetTokens?: number
): Promise<string> {
  return structuralSummary(messages)
}
