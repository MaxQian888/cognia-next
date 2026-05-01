/**
 * Evaluator — newcomer-perspective quality grading on synthesized drafts.
 */

import { extractJson, type LlmClient } from "../llm"
import { applyTemplate, EVALUATOR_PROMPT } from "../prompts"
import type { TwinDraft, TwinDraftEvaluation } from "@/types/twin"

export interface EvaluatorInput {
  drafts: TwinDraft[]
}

export interface EvaluatorResult {
  /** keyed by draft id. */
  evaluations: Record<string, TwinDraftEvaluation>
}

interface RawEvaluation {
  draftId?: string
  qualityScore?: number
  concerns?: string[]
  suggestions?: string[]
}

function formatDraftsForPrompt(drafts: TwinDraft[]): string {
  return drafts
    .map((draft) => {
      const data = draft.payload.data as Record<string, unknown>
      const name =
        typeof data.name === "string"
          ? data.name
          : draft.payload.kind === "character"
            ? "Character draft"
            : "Skill draft"
      const body =
        typeof data.systemPrompt === "string"
          ? data.systemPrompt
          : typeof data.content === "string"
            ? data.content
            : ""
      return [
        `[${draft.id}] (${draft.payload.kind})`,
        `Title: ${name}`,
        `Body:`,
        body.slice(0, 1500),
      ].join("\n")
    })
    .join("\n\n---\n\n")
}

export async function runEvaluator(
  llm: LlmClient,
  input: EvaluatorInput
): Promise<EvaluatorResult> {
  if (input.drafts.length === 0) return { evaluations: {} }

  const prompt = applyTemplate(EVALUATOR_PROMPT, {
    drafts: formatDraftsForPrompt(input.drafts),
  })

  const response = await llm.complete(prompt, { temperature: 0.1, maxTokens: 3000 })
  const parsed = extractJson<{ evaluations?: RawEvaluation[] }>(response)
  const rawList = Array.isArray(parsed.evaluations) ? parsed.evaluations : []

  const evaluations: Record<string, TwinDraftEvaluation> = {}
  for (const raw of rawList) {
    if (!raw.draftId) continue
    evaluations[raw.draftId] = {
      qualityScore:
        typeof raw.qualityScore === "number" ? Math.max(0, Math.min(1, raw.qualityScore)) : 0.5,
      concerns: Array.isArray(raw.concerns)
        ? raw.concerns.filter((c): c is string => typeof c === "string")
        : [],
      suggestions: Array.isArray(raw.suggestions)
        ? raw.suggestions.filter((s): s is string => typeof s === "string")
        : [],
    }
  }

  return { evaluations }
}
