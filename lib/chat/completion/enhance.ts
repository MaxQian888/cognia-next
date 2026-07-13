/**
 * Prompt enhancement — the "improve / rewrite my prompt" brain behind the
 * composer's Wand action.
 *
 * It takes the user's draft message and asks the injected `LlmClient` to
 * rewrite it (clearer / shorter / more detailed / more technical / simpler)
 * or to produce a handful of alternative phrasings. This is the UI-facing
 * activation of the otherwise-dormant query-expansion engine
 * (`lib/ai/rag/query-expansion.ts`) — that module's `rewriteQuery` /
 * `generateQueryVariants` only ever run behind an unconfigured RAG model, so
 * their prompt shape is reproduced here against a renderer-resolvable
 * `LlmClient` instead (the two client abstractions — ai-sdk `LanguageModel`
 * vs. our `LlmClient.complete()` — don't interop, so we re-state the prompt
 * rather than bridge the types).
 *
 * Privacy guard: the draft is checked with `hasNoLeakingPii` before any
 * model call. A draft carrying an API key / token / credential / email /
 * card never leaves the device — the call is skipped and the caller is told
 * why so it can surface a quiet notice.
 *
 * Pure + dependency-injected: the `LlmClient` and PII gate are passed in so
 * the (fiddly) prompt + output-cleanup logic is unit-testable without a
 * model or the real redactor.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractJson } from "@/lib/twin/distill/llm"
import { hasNoLeakingPii } from "@cognia/redact"

/** The rewrite intents the composer exposes. */
export type EnhanceMode = "improve" | "concise" | "detailed" | "technical" | "simpler" | "variants"

export const ENHANCE_MODES: readonly EnhanceMode[] = [
  "improve",
  "concise",
  "detailed",
  "technical",
  "simpler",
  "variants",
] as const

/** How many alternative phrasings the `variants` mode asks for. */
export const DEFAULT_VARIANT_COUNT = 3
/** Hard cap on a single rewritten message (chars) — runaway-output guard. */
export const MAX_ENHANCED_LEN = 8_000

export interface EnhanceDeps {
  client: LlmClient
  /** PII gate. Defaults to the shared `hasNoLeakingPii`. */
  isPiiSafe?: (text: string) => boolean
  signal?: AbortSignal
}

export type EnhanceResult =
  | { kind: "rewrite"; text: string }
  | { kind: "variants"; variants: string[] }
  | { kind: "skipped"; reason: "pii" | "empty" | "no-output" }

const SYSTEM_PROMPT = [
  "You are a prompt-editing assistant embedded in a chat composer.",
  "The user is drafting a message to an AI assistant and wants it improved.",
  "Rewrite their draft per the requested style while preserving the original",
  "intent, any quoted text, code, file paths, and @-mentions verbatim.",
  "Do not answer the prompt — only rewrite it. Output ONLY the rewritten",
  "message: no preamble, no surrounding quotes, no markdown code fences,",
  "no commentary.",
].join(" ")

const MODE_INSTRUCTION: Record<Exclude<EnhanceMode, "variants">, string> = {
  improve:
    "Make it clearer, more specific, and well-structured. Resolve ambiguity and state the goal explicitly.",
  concise: "Make it shorter and more focused on the essential ask. Remove filler.",
  detailed:
    "Expand it with the specific details, constraints, and context an assistant would need.",
  technical: "Use precise, domain-appropriate technical terminology.",
  simpler: "Simplify it to plain, basic language a non-expert would use.",
}

/** Strip ``` fences and a single pair of wrapping quotes from a rewrite. */
function cleanRewrite(raw: string): string {
  let out = raw
    .replace(/```[a-zA-Z0-9]*\n?/g, "")
    .replace(/```/g, "")
    .trim()
  if (out.length >= 2) {
    const first = out[0]
    const last = out[out.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      out = out.slice(1, -1).trim()
    }
  }
  return out
}

function buildRewritePrompt(draft: string, mode: Exclude<EnhanceMode, "variants">): string {
  return [
    `Requested style: ${MODE_INSTRUCTION[mode]}`,
    "",
    "Draft message to rewrite:",
    draft,
  ].join("\n")
}

function buildVariantsPrompt(draft: string, count: number): string {
  return [
    `Generate ${count} alternative phrasings of the draft message below.`,
    "Each variant must preserve the core intent but vary the wording or angle.",
    "Each must be a complete, self-contained message.",
    'Return ONLY a JSON array of strings. Example: ["variant 1", "variant 2"]',
    "",
    "Draft message:",
    draft,
  ].join("\n")
}

/**
 * Enhance a draft prompt. Returns the rewritten text (or variants), or a
 * `skipped` result when the draft is empty, fails the PII gate, or the model
 * produced nothing useful. Throws only if the underlying `client.complete`
 * throws for a reason other than abort — callers decide how to surface that.
 */
export async function enhancePrompt(
  draft: string,
  mode: EnhanceMode,
  deps: EnhanceDeps
): Promise<EnhanceResult> {
  const trimmed = draft.trim()
  if (trimmed.length === 0) return { kind: "skipped", reason: "empty" }

  const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
  if (!isPiiSafe(draft)) return { kind: "skipped", reason: "pii" }

  if (mode === "variants") {
    const raw = await deps.client.complete(buildVariantsPrompt(draft, DEFAULT_VARIANT_COUNT), {
      system: SYSTEM_PROMPT,
      temperature: 0.7,
      maxTokens: 1_024,
      abortSignal: deps.signal,
    })
    let parsed: unknown
    try {
      parsed = extractJson<unknown>(raw)
    } catch {
      return { kind: "skipped", reason: "no-output" }
    }
    if (!Array.isArray(parsed)) return { kind: "skipped", reason: "no-output" }
    const variants = parsed
      .filter((v): v is string => typeof v === "string")
      .map((v) => cleanRewrite(v))
      .filter((v) => v.length > 0 && v.length <= MAX_ENHANCED_LEN && v !== trimmed)
    if (variants.length === 0) return { kind: "skipped", reason: "no-output" }
    return { kind: "variants", variants }
  }

  const raw = await deps.client.complete(buildRewritePrompt(draft, mode), {
    system: SYSTEM_PROMPT,
    temperature: 0.3,
    maxTokens: 2_048,
    abortSignal: deps.signal,
  })
  const text = cleanRewrite(raw)
  if (text.length === 0 || text.length > MAX_ENHANCED_LEN || text === trimmed) {
    return { kind: "skipped", reason: "no-output" }
  }
  return { kind: "rewrite", text }
}
