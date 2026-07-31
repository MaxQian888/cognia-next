/**
 * Generate a Skill draft from a recording trace via the utility LLM.
 *
 * Pure module — the `LlmClient` is injected (the hook resolves it through
 * `buildUtilityLlmClient`), so this stays testable with a mock `{ complete }`.
 *
 * Privacy: the serialized transcript (element labels + typed text hints, all
 * locally-derived screen text) is run through the PII gate BEFORE the model
 * call. Screenshots never enter the prompt — only `traceToPromptText` output
 * does. The returned `redacted` flag lets the caller toast the user.
 */

import type { SkillCategory } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { SKILL_CATEGORIES } from "@/lib/skills/categories"
import { traceToPromptText } from "@/lib/skills/recording/trace-to-prompt"
import type { RecordingTrace } from "@/lib/skills/recording/types"
import { buildSkillSystemPrompt, buildSkillUserPrompt } from "@/lib/skills/trace-prompts"

const MAX_NAME_LEN = 64

export interface SkillGenerationDraft {
  name: string
  description: string
  content: string
  tags: string[]
  category: SkillCategory
  allowedTools: string[]
}

export interface SkillGenerationResult {
  draft: SkillGenerationDraft
  /** True when PII redaction altered the transcript before sending. */
  redacted: boolean
}

const VALID_CATEGORIES = new Set<string>(SKILL_CATEGORIES.map((c) => c.id))

/** Strip a leading/trailing markdown code fence the model may wrap JSON in. */
function stripFences(text: string): string {
  const fenced = text.trim().match(/^```(?:[\w-]*)\n([\s\S]*?)\n```$/)
  return (fenced ? fenced[1] : text).trim()
}

/** Parse the model's JSON, tolerating prose around a single `{...}` object. */
function parseSkillJson(raw: string): Record<string, unknown> {
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

/** Coerce a name to satisfy the skill name pattern (alnum + space/_/-, <=64). */
function sanitizeName(raw: unknown): string {
  const base = typeof raw === "string" ? raw : ""
  const cleaned = base
    .replace(/[^A-Za-z0-9\s_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LEN)
    .trim()
  return cleaned || "Recorded skill"
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
}

function normalizeDraft(parsed: Record<string, unknown>): SkillGenerationDraft {
  const content = typeof parsed.content === "string" ? parsed.content.trim() : ""
  if (!content) {
    throw new Error("Generated skill has no content.")
  }
  const categoryRaw = typeof parsed.category === "string" ? parsed.category : ""
  const category: SkillCategory = VALID_CATEGORIES.has(categoryRaw)
    ? (categoryRaw as SkillCategory)
    : "custom"
  const description = typeof parsed.description === "string" ? parsed.description.trim() : ""
  return {
    name: sanitizeName(parsed.name),
    description,
    content,
    tags: toStringArray(parsed.tags),
    category,
    allowedTools: toStringArray(parsed.allowedTools),
  }
}

export async function generateSkillFromTrace(
  trace: RecordingTrace,
  client: Pick<LlmClient, "complete">
): Promise<SkillGenerationResult> {
  if (trace.observations.length === 0) {
    throw new Error("No steps were captured in this recording.")
  }
  let text = traceToPromptText(trace)
  let redacted = false
  if (!hasNoLeakingPii(text)) {
    text = redactText(text).redacted
    redacted = true
  }
  const raw = await client.complete(buildSkillUserPrompt(text), {
    system: buildSkillSystemPrompt(),
    temperature: 0.2,
    maxTokens: 1400,
  })
  const draft = normalizeDraft(parseSkillJson(raw))
  return { draft, redacted }
}
