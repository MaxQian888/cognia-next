/**
 * PlaybookAgent — detect repeated work patterns in chunk batches.
 */

import { extractJson, type LlmClient } from "../llm"
import { applyTemplate, PLAYBOOK_AGENT_PROMPT } from "../prompts"
import type { Playbook, PlaybookExample, PlaybookStep, TwinChunk } from "@/types/twin"

export interface PlaybookAgentInput {
  chunks: TwinChunk[]
  /** Don't emit playbooks below this confidence. Defaults to 0.4. */
  minConfidence?: number
  /** Cap the prompt size; defaults to 80 chunks. */
  maxChunks?: number
}

export interface PlaybookAgentResult {
  playbooks: Playbook[]
}

interface RawPlaybook {
  title?: string
  trigger?: string
  steps?: PlaybookStep[]
  examples?: PlaybookExample[]
  confidence?: number
}

function newPlaybookId(): string {
  return "pb_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

function formatChunksForPrompt(chunks: TwinChunk[]): string {
  return chunks.map((c) => `[${c.id}]\n${c.contentRedacted}`).join("\n\n---\n\n")
}

function normaliseSteps(input: unknown): PlaybookStep[] {
  if (!Array.isArray(input)) return []
  return input
    .map((s, i) => {
      if (typeof s === "string") {
        return { order: i + 1, action: s }
      }
      if (s && typeof s === "object") {
        const obj = s as Partial<PlaybookStep>
        return {
          order: typeof obj.order === "number" ? obj.order : i + 1,
          action: String(obj.action ?? ""),
          rationale: typeof obj.rationale === "string" ? obj.rationale : undefined,
        }
      }
      return null
    })
    .filter((step): step is PlaybookStep => step !== null && step.action.length > 0)
}

function normaliseExamples(input: unknown): PlaybookExample[] {
  if (!Array.isArray(input)) return []
  return input
    .map((ex) => {
      if (!ex || typeof ex !== "object") return null
      const obj = ex as Partial<PlaybookExample>
      return {
        sourceChunkIds: Array.isArray(obj.sourceChunkIds)
          ? obj.sourceChunkIds.filter((id): id is string => typeof id === "string")
          : [],
        outcome: String(obj.outcome ?? ""),
      }
    })
    .filter(
      (ex): ex is PlaybookExample =>
        ex !== null && (ex.sourceChunkIds.length > 0 || ex.outcome.length > 0)
    )
}

export async function runPlaybookAgent(
  llm: LlmClient,
  input: PlaybookAgentInput
): Promise<PlaybookAgentResult> {
  const cap = input.maxChunks ?? 80
  const chunks = input.chunks.slice(0, cap)
  if (chunks.length < 3) return { playbooks: [] }

  const prompt = applyTemplate(PLAYBOOK_AGENT_PROMPT, {
    chunks: formatChunksForPrompt(chunks),
  })

  const response = await llm.complete(prompt, { temperature: 0, maxTokens: 4000 })
  const parsed = extractJson<{ playbooks?: RawPlaybook[] }>(response)
  const rawList = Array.isArray(parsed.playbooks) ? parsed.playbooks : []

  const minConfidence = input.minConfidence ?? 0.4
  const playbooks: Playbook[] = rawList
    .map((raw) => ({
      id: newPlaybookId(),
      title: raw.title?.trim() || "Untitled playbook",
      trigger: raw.trigger?.trim() || "",
      steps: normaliseSteps(raw.steps),
      examples: normaliseExamples(raw.examples),
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0,
    }))
    .filter((pb) => pb.steps.length > 0 && pb.confidence >= minConfidence)

  return { playbooks }
}
