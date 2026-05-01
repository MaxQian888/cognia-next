/**
 * StyleAgent — extract representative writing samples from a chunk pool.
 */

import { extractJson, type LlmClient } from "../llm"
import { applyTemplate, STYLE_AGENT_PROMPT } from "../prompts"
import type { StyleSample, TwinChunk } from "@/types/twin"

export interface StyleAgentInput {
  chunks: TwinChunk[]
  /** Cap the prompt size to ~N chunks. Defaults to 60. */
  maxChunks?: number
}

export interface StyleAgentResult {
  samples: StyleSample[]
}

interface RawStyleSample {
  contextLabel: string
  original: string
  summary: string
  tone?: string[]
}

function newSampleId(): string {
  return "ss_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

function formatChunksForPrompt(chunks: TwinChunk[]): string {
  return chunks.map((c) => `[${c.id}]\n${c.contentRedacted}`).join("\n\n---\n\n")
}

export async function runStyleAgent(
  llm: LlmClient,
  input: StyleAgentInput
): Promise<StyleAgentResult> {
  const cap = input.maxChunks ?? 60
  const chunks = input.chunks.slice(0, cap)
  if (chunks.length === 0) return { samples: [] }

  const prompt = applyTemplate(STYLE_AGENT_PROMPT, {
    chunks: formatChunksForPrompt(chunks),
  })

  const response = await llm.complete(prompt, { temperature: 0, maxTokens: 4000 })
  const parsed = extractJson<{ samples?: RawStyleSample[] }>(response)
  const rawList = Array.isArray(parsed.samples) ? parsed.samples : []

  const samples: StyleSample[] = rawList.map((s) => {
    const sourceChunk = chunks.find((c) => c.contentRedacted.includes(s.original.slice(0, 80)))
    return {
      id: newSampleId(),
      contextLabel: s.contextLabel || "untitled-context",
      original: s.original,
      summary: s.summary,
      sourceChunkId: sourceChunk?.id ?? chunks[0].id,
      tone: Array.isArray(s.tone) ? s.tone : [],
      addedAt: Date.now(),
      addedBy: "distill",
    }
  })

  return { samples }
}
