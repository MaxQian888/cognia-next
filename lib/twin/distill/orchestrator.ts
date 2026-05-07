/**
 * Distill orchestrator — pipelines the five sub-agents over a chunk pool.
 *
 *   T1  KnowledgeAgent  (batched 100 chunks at a time)
 *   T2  StyleAgent      (one call over 60-chunk sample)
 *   T3  PlaybookAgent   (one call over 80-chunk sample)
 *   T4  Synthesizer     (one call w/ profile + 30 recent chunks)
 *   T5  Evaluator       (one call across synth output)
 *
 * Each agent is wrapped in `withTimeoutOrFallback` so a hung provider
 * call or a malformed response doesn't take down the whole run. The only
 * agent allowed to abort the run is the Synthesizer — without its output
 * there are no drafts to persist, and surfacing an empty distill as
 * "completed" would mislead the user.
 *
 * Returns the structured result shape; the caller (`job-runner.ts`)
 * persists everything to Dexie + flips the parent TwinJob.
 */

import type {
  Playbook,
  ProfileEntity,
  StyleSample,
  TwinChunk,
  TwinDraft,
  TwinDraftEvaluation,
  TwinDraftPayload,
  TwinProfile,
} from "@/types/twin"
import { runStyleAgent } from "./agents/style-agent"
import { runPlaybookAgent } from "./agents/playbook-agent"
import { runKnowledgeAgent } from "./agents/knowledge-agent"
import { runSynthesizer, type SynthDraft } from "./agents/synthesizer"
import { runEvaluator } from "./agents/evaluator"
import type { LlmClient } from "./llm"
import { DEFAULT_AGENT_TIMEOUT_MS, withTimeoutOrFallback } from "./with-timeout"

const KNOWLEDGE_BATCH_SIZE = 100

export interface OrchestratorInput {
  llm: LlmClient
  profile: TwinProfile
  chunks: TwinChunk[]
  /** Phase 5 progress hook — orchestrator pings phase + ratio updates. */
  onProgress?: (phase: string, progress: number) => Promise<void> | void
  /** Per-agent timeout. Defaults to DEFAULT_AGENT_TIMEOUT_MS (90 s). */
  agentTimeoutMs?: number
}

export interface OrchestratorOutput {
  /** Style samples to append to the profile. */
  styleSamples: StyleSample[]
  /** Playbooks to append to the profile. */
  playbooks: Playbook[]
  /** Entities to upsert onto the profile (deduped at write time). */
  entities: ProfileEntity[]
  /** chunkId → entity name array; persisted as `twinChunks.entityTags`. */
  chunkEntityTags: Record<string, string[]>
  /** Merged voice summary (synthesizer's output overrides if non-empty). */
  voiceSummary: string
  /** Synthesized drafts WITHOUT ids — caller stamps them at persist time. */
  synthesizedDrafts: SynthDraft[]
  /** Evaluator output keyed by the placeholder draftId provided to it. */
  evaluations: Record<string, TwinDraftEvaluation>
  /** Per-agent failure messages — empty on a clean run. */
  partialFailures: Record<string, string>
  /** Cumulative LLM tokens consumed across all agents (0 when client doesn't track). */
  llmTokensUsed: number
}

export async function runOrchestrator(input: OrchestratorInput): Promise<OrchestratorOutput> {
  const { llm, profile, chunks, onProgress } = input
  const agentTimeoutMs = input.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS
  const partialFailures: Record<string, string> = {}

  const recordFailure = (label: string, message: string) => {
    partialFailures[label] = message
  }

  // ───── Stage 1: KnowledgeAgent (chunk-level, batched) ─────
  const allEntities: ProfileEntity[] = []
  const chunkEntityTags: Record<string, string[]> = {}
  for (let i = 0; i < chunks.length; i += KNOWLEDGE_BATCH_SIZE) {
    const batch = chunks.slice(i, i + KNOWLEDGE_BATCH_SIZE)
    const batchLabel = `knowledge-agent#${Math.floor(i / KNOWLEDGE_BATCH_SIZE)}`
    const { value, error } = await withTimeoutOrFallback(
      () => runKnowledgeAgent(llm, { chunks: batch }),
      batchLabel,
      {
        timeoutMs: agentTimeoutMs,
        fallback: { entities: [] as ProfileEntity[], perChunk: {} as Record<string, string[]> },
        onError: recordFailure,
      }
    )
    allEntities.push(...value.entities)
    Object.assign(chunkEntityTags, value.perChunk)
    if (onProgress) {
      await onProgress("knowledge-agent", (i + batch.length) / chunks.length / 5)
    }
    void error // already captured into partialFailures via onError
  }
  await onProgress?.("knowledge-agent", 0.2)

  // ───── Stage 2: StyleAgent ─────
  const styleResult = await withTimeoutOrFallback(
    () => runStyleAgent(llm, { chunks }),
    "style-agent",
    {
      timeoutMs: agentTimeoutMs,
      fallback: { samples: [] as StyleSample[] },
      onError: recordFailure,
    }
  )
  await onProgress?.("style-agent", 0.4)

  // ───── Stage 3: PlaybookAgent ─────
  const playbookResult = await withTimeoutOrFallback(
    () => runPlaybookAgent(llm, { chunks }),
    "playbook-agent",
    {
      timeoutMs: agentTimeoutMs,
      fallback: { playbooks: [] as Playbook[] },
      onError: recordFailure,
    }
  )
  await onProgress?.("playbook-agent", 0.6)

  // ───── Stage 4: Synthesizer (load-bearing — failure aborts the run) ─────
  // Build a transient profile that already includes this run's distillation
  // so the synthesizer sees the latest data, even when partial agents
  // contributed empty arrays.
  const transientProfile: TwinProfile = {
    ...profile,
    styleSamples: [...profile.styleSamples, ...styleResult.value.samples],
    playbooks: [...profile.playbooks, ...playbookResult.value.playbooks],
    entities: dedupeEntitiesByName([...profile.entities, ...allEntities]),
    updatedAt: Date.now(),
  }
  const recent = chunks.slice(-30)
  const synthResult = await runSynthesizer(llm, {
    profile: transientProfile,
    recentChunks: recent,
  })
  await onProgress?.("synthesizer", 0.8)

  // ───── Stage 5: Evaluator (best-effort) ─────
  const placeholderDrafts: TwinDraft[] = synthResult.drafts.map((draft, i) => ({
    id: `tmp_${i}`,
    twinId: profile.twinId,
    jobId: "tmp_job",
    kind: draft.payload.kind,
    payload: draft.payload as TwinDraftPayload,
    provenance: { chunkIds: [], rationale: draft.rationale },
    status: "pending",
    createdAt: Date.now(),
  }))
  const evalResult = await withTimeoutOrFallback(
    () => runEvaluator(llm, { drafts: placeholderDrafts }),
    "evaluator",
    {
      timeoutMs: agentTimeoutMs,
      fallback: { evaluations: {} as Record<string, TwinDraftEvaluation> },
      onError: recordFailure,
    }
  )
  await onProgress?.("evaluator", 1.0)

  const usage = llm.getUsageSnapshot?.() ?? { totalTokens: 0 }

  return {
    styleSamples: styleResult.value.samples,
    playbooks: playbookResult.value.playbooks,
    entities: dedupeEntitiesByName(allEntities),
    chunkEntityTags,
    voiceSummary: synthResult.voiceSummary,
    synthesizedDrafts: synthResult.drafts,
    evaluations: evalResult.value.evaluations,
    partialFailures,
    llmTokensUsed: usage.totalTokens ?? 0,
  }
}

function dedupeEntitiesByName(entities: ProfileEntity[]): ProfileEntity[] {
  const map = new Map<string, ProfileEntity>()
  for (const entity of entities) {
    const key = entity.name.toLowerCase()
    const existing = map.get(key)
    if (!existing) {
      map.set(key, entity)
    } else {
      const aliases = new Set([...existing.aliases, ...entity.aliases])
      map.set(key, {
        ...existing,
        aliases: Array.from(aliases),
        relation: existing.relation ?? entity.relation,
      })
    }
  }
  return Array.from(map.values())
}
