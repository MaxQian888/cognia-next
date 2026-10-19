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
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { definePrompt } from "@/lib/prompts/types"

/**
 * The distiller's identity (ADR-0236). Account scope only: the distill step
 * receives the redacted transcript and nothing that names its workspace.
 */
export const EPISODIC_DISTILL_SYSTEM_PROMPT = definePrompt({
  id: "knowledge.memory.episodic-distill",
  contractVersion: 1,
  kind: "feature-template",
  group: "knowledge",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  // The reply is parsed as JSON; a reply that is not JSON yields no memories.
  risk: "protocol",
  hosts: ["app"],
  maxChars: 4_000,
  requiredFragments: ["JSON"],
  outputContract:
    "Sent as the system prompt of the idle-time episodic distill; the reply is parsed as JSON and a parse failure distills nothing.",
  consumers: ["lib/memory/write/run-episodic-distill.ts"],
  defaultBody:
    "You distill a finished conversation into a few EPISODIC memories — discrete " +
    "decisions, outcomes, or events worth recalling in a later session " +
    "(e.g. 'Decided to use X for Y', 'Fixed the Z bug by …'). Return STRICT JSON only.",
})

/**
 * The distill request around the transcript. `{{conversation}}` is the
 * already-redacted transcript, one `role: text` line per message.
 */
export const EPISODIC_DISTILL_REQUEST_PROMPT = definePrompt({
  id: "knowledge.memory.episodic-distill.request",
  contractVersion: 1,
  kind: "feature-template",
  group: "knowledge",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app"],
  maxChars: 4_000,
  variables: [{ name: "conversation", required: true, maxChars: 1_000_000 }],
  requiredFragments: ['"episodes"', '"text"', '"importance"'],
  outputContract:
    'One JSON object {"episodes": [{"text", "importance"}]}; empty texts are dropped, importance is rounded and clamped to 1–10 (default 5), and every text passes the PII gate before consolidation.',
  consumers: ["lib/memory/write/run-episodic-distill.ts"],
  defaultBody: [
    `Conversation:\n{{conversation}}`,
    ``,
    `Distill 0–3 episodic memories. Skip anything trivial; return {"episodes":[]}`,
    `if nothing notable. Each: a single self-contained sentence in the user's`,
    `language, importance 1–10.`,
    `Return JSON: {"episodes":[{"text","importance"}]}.`,
  ].join("\n"),
})

interface RawEpisodes {
  episodes?: Array<{ text?: unknown; importance?: unknown }>
}

async function buildPrompt(transcript: { role: string; text: string }[]): Promise<string> {
  const conversation = transcript.map((m) => `${m.role}: ${m.text}`).join("\n")
  return (await resolvePromptAsync(EPISODIC_DISTILL_REQUEST_PROMPT, { values: { conversation } }))
    .text
}

/** Pure LLM step: transcript → episodic candidates. Returns [] on failure. */
export async function distillEpisodes(
  transcript: { role: string; text: string }[],
  client: LlmClient
): Promise<MemoryCandidate[]> {
  if (transcript.length === 0) return []
  try {
    const prompt = await buildPrompt(transcript)
    const system = (await resolvePromptAsync(EPISODIC_DISTILL_SYSTEM_PROMPT)).text
    const raw = await client.complete(prompt, {
      system,
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
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  provenance: MemoryProvenance
  source?: { sessionId?: string }
  config: MemoryConfig
}

export interface RunEpisodicDistillDeps {
  distill: (transcript: { role: string; text: string }[]) => Promise<MemoryCandidate[]>
  consolidate: (input: ConsolidateInput) => Promise<{ applied: ConsolidationOp[] }>
  redact?: (text: string) => string
  isPiiSafe?: (text: string) => boolean
}

export async function runEpisodicDistill(
  input: RunEpisodicDistillInput,
  deps: RunEpisodicDistillDeps
): Promise<{ applied: ConsolidationOp[] }> {
  const empty = { applied: [] as ConsolidationOp[] }
  try {
    const { config } = input
    if (!config.enabled || !config.learnFromChats || config.temporary) return empty
    if (input.provenance === "inbound") return empty
    if (input.transcript.length === 0) return empty

    const redact = deps.redact ?? ((text: string) => redactText(text).redacted)
    const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
    const safeTranscript = input.transcript.map((message) => ({
      ...message,
      text: redact(message.text),
    }))
    if (safeTranscript.some((message) => !isPiiSafe(message.text))) return empty

    const candidates = await deps.distill(safeTranscript)
    if (candidates.length === 0) return empty

    const safe = candidates.filter((c) => isPiiSafe(c.text))
    if (safe.length === 0) return empty

    return await deps.consolidate({
      candidates: safe,
      scope: input.scope,
      characterId: input.characterId,
      projectId: input.projectId,
      agentId: input.agentId,
      branch: input.branch,
      pathPattern: input.pathPattern,
      provenance: input.provenance,
      source: input.source,
    })
  } catch {
    return empty
  }
}
