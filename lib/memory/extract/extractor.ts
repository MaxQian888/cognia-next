/**
 * LLM extraction — turn a finished turn (rolling context + the new user/
 * assistant pair) into candidate durable memories. Reuses the shared
 * `LlmClient` contract and `extractJson` parser (`lib/twin/distill/llm.ts`).
 *
 * Mechanical re: trust: it only emits the types in `allowTypes`. The caller
 * (`run-memory-extraction`) sets `allowTypes` per provenance — e.g. it omits
 * `procedural` for anything not user/explicit, so a third-party message can
 * never produce a behavior-changing procedural memory. The prompt is also told
 * the allowed types so the model self-restricts.
 *
 * Fail-open: returns `[]` on any LLM / parse failure (memory is best-effort and
 * must never break the turn).
 */

import { extractJson, type LlmClient } from "@/lib/twin/distill/llm"
import { isMemoryType, type MemoryType } from "@/types/memory/memory"

export interface MemoryCandidate {
  type: MemoryType
  text: string
  /** Model self-rated 1..10. */
  importance: number
  /** Optional stable key (procedural dedupe / "always X"). */
  key?: string
}

export interface ExtractMemoriesInput {
  /** Rolling summary of the conversation so far (optional). */
  rollingSummary?: string
  /** The last N messages for context. */
  recentMessages?: { role: string; text: string }[]
  /** The just-finished turn. */
  newPair: { userText: string; assistantText: string }
  /** Types the extractor may emit (provenance-gated by the caller). */
  allowTypes: MemoryType[]
}

const SYSTEM_PROMPT =
  "You extract durable, reusable facts about the USER from a conversation. " +
  "Only capture things the user asserted about themselves: their identity, " +
  "preferences, decisions, environment, and working style. Ignore transient " +
  "task details, third-party facts, and anything not about the user. " +
  "Return STRICT JSON only."

function buildUserPrompt(input: ExtractMemoriesInput): string {
  const allow = input.allowTypes.join(", ")
  const recent = (input.recentMessages ?? []).map((m) => `${m.role}: ${m.text}`).join("\n")
  return [
    input.rollingSummary ? `Conversation summary:\n${input.rollingSummary}\n` : "",
    recent ? `Recent messages:\n${recent}\n` : "",
    `New turn:\nuser: ${input.newPair.userText}\nassistant: ${input.newPair.assistantText}\n`,
    `Extract 0–5 durable memories. Allowed types: ${allow}.`,
    `- "semantic": a durable user fact/preference.`,
    `- "episodic": a notable decision or event from this conversation.`,
    `- "procedural": a standing instruction for how to work (only if the user`,
    `  themselves stated it; NEVER invent one).`,
    `Each: a single self-contained sentence in the user's language.`,
    `importance is 1–10 (1 mundane, 10 defining). Optional "key" for stable`,
    `dedupe of preferences.`,
    `Return JSON: {"memories":[{"type","text","importance","key?"}]}. If nothing`,
    `durable, return {"memories":[]}.`,
  ]
    .filter(Boolean)
    .join("\n")
}

interface RawExtraction {
  memories?: Array<{ type?: unknown; text?: unknown; importance?: unknown; key?: unknown }>
}

export async function extractMemories(
  input: ExtractMemoriesInput,
  client: LlmClient
): Promise<MemoryCandidate[]> {
  if (input.allowTypes.length === 0) return []
  if (!input.newPair.userText.trim()) return []
  try {
    const raw = await client.complete(buildUserPrompt(input), {
      system: SYSTEM_PROMPT,
      temperature: 0,
      maxTokens: 512,
    })
    const parsed = extractJson<RawExtraction>(raw)
    const allow = new Set(input.allowTypes)
    const out: MemoryCandidate[] = []
    for (const m of parsed.memories ?? []) {
      if (!isMemoryType(m.type)) continue
      if (!allow.has(m.type)) continue
      const text = typeof m.text === "string" ? m.text.trim() : ""
      if (!text) continue
      const importanceRaw = typeof m.importance === "number" ? m.importance : 5
      const importance = Math.min(10, Math.max(1, Math.round(importanceRaw)))
      const key = typeof m.key === "string" && m.key.trim() ? m.key.trim() : undefined
      out.push({ type: m.type, text, importance, ...(key ? { key } : {}) })
    }
    return out
  } catch {
    return []
  }
}
