/**
 * Episodic distillation — runs once per session at an idle moment (NOT per
 * turn: a mid-conversation turn has no complete "episode"). Summarizes the
 * whole transcript into 0–3 episodic memories (notable decisions / outcomes)
 * and feeds them through the SAME consolidator as everything else.
 *
 * Reuses the shared `LlmClient` + `extractJson`. Dependency-injected; the
 * orchestrator is fail-open. Connector-inbound sessions are excluded.
 */

import { extractJson, type LlmClient } from "@/lib/twin/distill/llm"
import type { MemoryConfig, MemoryProvenance, MemoryScope } from "@/types/memory/memory"
import type { ConsolidateInput, ConsolidationOp } from "@/lib/memory/consolidate/consolidator"
import type { MemoryCandidate } from "@/lib/memory/extract/extractor"
import { hasNoLeakingPii } from "@cognia/redact"

const DISTILL_SYSTEM =
  "You distill a finished conversation into a few EPISODIC memories — discrete " +
  "decisions, outcomes, or events worth recalling in a later session " +
  "(e.g. 'Decided to use X for Y', 'Fixed the Z bug by …'). Return STRICT JSON only."

interface RawEpisodes {
  episodes?: Array<{ text?: unknown; importance?: unknown }>
}

function buildPrompt(transcript: { role: string; text: string }[]): string {
  const body = transcript.map((m) => `${m.role}: ${m.text}`).join("\n")
  return [
    `Conversation:\n${body}`,
    ``,
    `Distill 0–3 episodic memories. Skip anything trivial; return {"episodes":[]}`,
    `if nothing notable. Each: a single self-contained sentence in the user's`,
    `language, importance 1–10.`,
    `Return JSON: {"episodes":[{"text","importance"}]}.`,
  ].join("\n")
}

/** Pure LLM step: transcript → episodic candidates. Returns [] on failure. */
export async function distillEpisodes(
  transcript: { role: string; text: string }[],
  client: LlmClient
): Promise<MemoryCandidate[]> {
  if (transcript.length === 0) return []
  try {
    const raw = await client.complete(buildPrompt(transcript), {
      system: DISTILL_SYSTEM,
      temperature: 0,
      maxTokens: 512,
    })
    const parsed = extractJson<RawEpisodes>(raw)
    const out: MemoryCandidate[] = []
    for (const e of parsed.episodes ?? []) {
      const text = typeof e.text === "string" ? e.text.trim() : ""
      if (!text) continue
      const importanceRaw = typeof e.importance === "number" ? e.importance : 5
      out.push({
        type: "episodic",
        text,
        importance: Math.min(10, Math.max(1, Math.round(importanceRaw))),
      })
    }
    return out
  } catch {
    return []
  }
}

export interface RunEpisodicDistillInput {
  transcript: { role: string; text: string }[]
  scope: MemoryScope
  characterId?: string
  provenance: MemoryProvenance
  source?: { sessionId?: string }
  config: MemoryConfig
}

export interface RunEpisodicDistillDeps {
  distill: (transcript: { role: string; text: string }[]) => Promise<MemoryCandidate[]>
  consolidate: (input: ConsolidateInput) => Promise<{ applied: ConsolidationOp[] }>
  isPiiSafe?: (text: string) => boolean
}

export async function runEpisodicDistill(
  input: RunEpisodicDistillInput,
  deps: RunEpisodicDistillDeps
): Promise<{ applied: ConsolidationOp[] }> {
  const empty = { applied: [] as ConsolidationOp[] }
  try {
    const { config } = input
    if (!config.enabled || !config.autoExtract || config.temporary) return empty
    if (input.provenance === "inbound") return empty
    if (input.transcript.length === 0) return empty

    const candidates = await deps.distill(input.transcript)
    if (candidates.length === 0) return empty

    const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
    const safe = candidates.filter((c) => isPiiSafe(c.text))
    if (safe.length === 0) return empty

    return await deps.consolidate({
      candidates: safe,
      scope: input.scope,
      characterId: input.characterId,
      provenance: input.provenance,
      source: input.source,
    })
  } catch {
    return empty
  }
}
