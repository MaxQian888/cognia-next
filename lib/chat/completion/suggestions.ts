/**
 * Suggested prompts — the brain behind the composer's AI starter prompts
 * (empty state) and follow-up suggestions (after an assistant reply).
 *
 * Both ask the injected `LlmClient` for a short JSON array of ready-to-send
 * messages. The conversation context is run through the shared PII gate
 * before any model call (a transcript carrying a credential / email never
 * leaves the device — the call is skipped and `[]` returned).
 *
 * Pure + dependency-injected so the prompt + parse + clamp logic is testable
 * without a model or the real redactor.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractJson } from "@/lib/twin/distill/llm"
import { hasNoLeakingPii } from "@/lib/twin/ingest/redact"
import type { GhostMessage } from "./ghost-prompt"

/** How many suggestions to request / surface. */
export const DEFAULT_SUGGESTION_COUNT = 3
/** Hard cap on a single suggestion (chars). */
export const MAX_SUGGESTION_LEN = 200
/** How many recent turns to feed the follow-up model. */
const RECENT_CONTEXT = 6
const MESSAGE_SNIPPET = 800

export interface SuggestionDeps {
  client: LlmClient
  /** PII gate. Defaults to the shared `hasNoLeakingPii`. */
  isPiiSafe?: (text: string) => boolean
  signal?: AbortSignal
  /** How many to request. Defaults to {@link DEFAULT_SUGGESTION_COUNT}. */
  count?: number
}

export interface StarterContext {
  characterName?: string
  characterDescription?: string
}

export interface FollowUpContext {
  recentMessages: readonly GhostMessage[]
}

const STARTER_SYSTEM = [
  "You suggest opening messages a user could send to an AI assistant to get",
  "started. Produce short, concrete, ready-to-send prompts (under 120 chars",
  "each), varied in topic. Output ONLY a JSON array of strings.",
].join(" ")

const FOLLOWUP_SYSTEM = [
  "You suggest natural follow-up messages the user might send next, given the",
  "conversation so far. Each must be a short, ready-to-send message from the",
  "user's point of view (under 120 chars), building on the last assistant",
  "reply. Output ONLY a JSON array of strings.",
].join(" ")

/** Parse + clean a model reply into at most `count` usable suggestions. */
function parseSuggestions(raw: string, count: number): string[] {
  let parsed: unknown
  try {
    parsed = extractJson<unknown>(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of parsed) {
    if (typeof v !== "string") continue
    const cleaned = v
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim()
    if (cleaned.length === 0 || cleaned.length > MAX_SUGGESTION_LEN) continue
    if (seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
    if (out.length >= count) break
  }
  return out
}

/** Suggest AI starter prompts for the empty state. Returns `[]` on PII / failure. */
export async function suggestStarters(
  ctx: StarterContext,
  deps: SuggestionDeps
): Promise<string[]> {
  const count = deps.count ?? DEFAULT_SUGGESTION_COUNT
  const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
  const persona = [ctx.characterName, ctx.characterDescription].filter(Boolean).join(" — ").trim()
  if (persona && !isPiiSafe(persona)) return []
  const prompt = [
    persona
      ? `The assistant's persona: ${persona.slice(0, MESSAGE_SNIPPET)}`
      : "The assistant is a general-purpose coding and productivity helper.",
    `Suggest ${count} opening prompts the user could send.`,
  ].join("\n")
  let raw: string
  try {
    raw = await deps.client.complete(prompt, {
      system: STARTER_SYSTEM,
      temperature: 0.8,
      maxTokens: 512,
      abortSignal: deps.signal,
    })
  } catch {
    return []
  }
  return parseSuggestions(raw, count)
}

/** Suggest follow-up messages after an assistant reply. Returns `[]` on PII / failure. */
export async function suggestFollowUps(
  ctx: FollowUpContext,
  deps: SuggestionDeps
): Promise<string[]> {
  const count = deps.count ?? DEFAULT_SUGGESTION_COUNT
  const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
  const recent = ctx.recentMessages.slice(-RECENT_CONTEXT).filter((m) => m.text.trim().length > 0)
  if (recent.length === 0) return []
  const transcript = recent
    .map(
      (m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.text.slice(0, MESSAGE_SNIPPET)}`
    )
    .join("\n")
  if (!isPiiSafe(transcript)) return []
  const prompt = [
    "Conversation so far:",
    transcript,
    "",
    `Suggest ${count} follow-up messages the user might send next.`,
  ].join("\n")
  let raw: string
  try {
    raw = await deps.client.complete(prompt, {
      system: FOLLOWUP_SYSTEM,
      temperature: 0.7,
      maxTokens: 512,
      abortSignal: deps.signal,
    })
  } catch {
    return []
  }
  return parseSuggestions(raw, count)
}
