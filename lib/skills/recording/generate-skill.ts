/**
 * Send a generation envelope to the utility model and validate what comes back.
 *
 * The `LlmClient` is injected so this stays testable with a `{ complete }` mock,
 * and — more importantly — so the envelope is the *only* thing that decides what
 * is sent. This module must never assemble prompt text of its own: the preview
 * the user approved is `envelope.systemPrompt` / `envelope.userPrompt`, and
 * anything re-derived here would make that preview a lie.
 *
 * Validation is strict because a model that returns almost-JSON, or invents a
 * tool name, produces a skill that looks authoritative and does nothing.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { SKILL_CATEGORIES } from "@/lib/skills/categories"

import type { GenerationEnvelope } from "./generation-envelope"
import type { GeneratedDraft } from "./state-machine"
import { intersectAllowedTools, type ToolIntersection } from "./tool-catalog"

const MAX_NAME_LEN = 64
const TEMPERATURE = 0.2
const MAX_TOKENS = 1400

const VALID_CATEGORIES = new Set<string>(SKILL_CATEGORIES.map((c) => c.id))
export const CATEGORY_IDS = SKILL_CATEGORIES.map((c) => c.id).join(" | ")

export interface SkillGenerationResult {
  draft: GeneratedDraft
  /** What happened to the model's proposed tools. Shown for confirmation. */
  tools: ToolIntersection
  /** True when redaction altered the transcript before sending. */
  redacted: boolean
}

/** Strip a leading/trailing markdown fence the model may wrap JSON in. */
export function stripFences(text: string): string {
  const fenced = text.trim().match(/^```(?:[\w-]*)\n([\s\S]*?)\n```$/)
  return (fenced ? fenced[1] : text).trim()
}

/** Parse the model's JSON, tolerating prose around a single `{...}` object. */
export function parseSkillJson(raw: string): Record<string, unknown> {
  const stripped = stripFences(raw)
  try {
    return JSON.parse(stripped) as Record<string, unknown>
  } catch {
    const start = stripped.indexOf("{")
    const end = stripped.lastIndexOf("}")
    if (start >= 0 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>
    }
    throw new Error("Model did not return valid JSON for the skill.")
  }
}

/** Coerce a name to the skill name pattern (alnum + space/_/-, <= 64). */
export function sanitizeName(raw: unknown, fallback: string): string {
  const base = typeof raw === "string" ? raw : ""
  const cleaned = base
    .replace(/[^A-Za-z0-9\s_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LEN)
    .trim()
  return cleaned || fallback
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
}

export function normalizeDraft(
  parsed: Record<string, unknown>,
  fallbackName: string
): GeneratedDraft {
  const content = typeof parsed.content === "string" ? parsed.content.trim() : ""
  if (!content) throw new Error("Generated skill has no content.")
  const categoryRaw = typeof parsed.category === "string" ? parsed.category : ""
  return {
    name: sanitizeName(parsed.name, fallbackName),
    description: typeof parsed.description === "string" ? parsed.description.trim() : "",
    content,
    tags: toStringArray(parsed.tags),
    category: VALID_CATEGORIES.has(categoryRaw) ? categoryRaw : "custom",
    allowedTools: toStringArray(parsed.allowedTools),
  }
}

export async function generateSkillFromEnvelope(
  envelope: GenerationEnvelope,
  client: Pick<LlmClient, "complete">,
  options: { toolCatalog: readonly string[]; fallbackName: string }
): Promise<SkillGenerationResult> {
  // Verbatim. Not `buildGenerationEnvelope(...)` called again, not a rebuilt
  // string — the exact object the preview rendered.
  const raw = await client.complete(envelope.userPrompt, {
    system: envelope.systemPrompt,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
  })
  const draft = normalizeDraft(parseSkillJson(raw), options.fallbackName)
  const tools = intersectAllowedTools(draft.allowedTools, options.toolCatalog)
  return {
    // Only names that exist survive into the draft. The dropped ones are
    // reported rather than discarded silently, so the user can tell whether the
    // model was reaching for something real.
    draft: { ...draft, allowedTools: tools.kept },
    tools,
    redacted: envelope.redacted,
  }
}
