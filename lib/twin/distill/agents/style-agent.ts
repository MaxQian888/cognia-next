/**
 * StyleAgent — extract representative writing samples from a chunk pool.
 *
 * When the input pool is larger than `maxChunks`, the agent runs the MMR
 * (Maximum Marginal Relevance) prefilter first to shrink the pool down
 * to `prefilterTarget` chunks that balance informativeness and
 * source-diversity. This both cuts prompt cost and prevents the LLM from
 * seeing dozens of near-duplicates from the same long document.
 */

import { extractJson, type LlmClient } from "../llm"
import { selectStyleCandidates } from "../heuristics/style-prefilter"
import { applyTemplate, STYLE_AGENT_PROMPT } from "../prompts"
import type { StyleSample, TwinChunk } from "@/types/twin"

export interface StyleAgentInput {
  chunks: TwinChunk[]
  /** Cap the prompt size to ~N chunks. Defaults to 60. */
  maxChunks?: number
  /**
   * When the input pool exceeds `maxChunks`, MMR-select down to this size
   * instead of using the first `maxChunks` chunks in order. Defaults to 30.
   */
  prefilterTarget?: number
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
  const prefilterTarget = input.prefilterTarget ?? 30
  // When the pool exceeds the prompt cap, run MMR to pick a diverse
  // sub-pool of `prefilterTarget` chunks before formatting. If MMR
  // returns fewer chunks than the cap (the prefilter drops short /
  // low-signal chunks), fall back to the original head slice so the
  // agent still sees a meaningful pool.
  let filtered: TwinChunk[] = input.chunks
  if (input.chunks.length > cap) {
    const candidates = selectStyleCandidates(input.chunks, { target: prefilterTarget })
    filtered = candidates.length >= Math.min(cap, prefilterTarget) ? candidates : input.chunks
  }
  const chunks = filtered.slice(0, cap)
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
