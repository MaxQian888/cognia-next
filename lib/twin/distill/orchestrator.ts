/**
 * Distill orchestrator — pipelines the five sub-agents over a chunk pool.
 *
 *   T1  KnowledgeAgent  (batched 100 chunks at a time)
 *   T2  StyleAgent      (one call over 60-chunk sample)
 *   T3  PlaybookAgent   (one call over 80-chunk sample)
 *   T4  Synthesizer     (one call w/ profile + 30 recent chunks)
 *   T5  Evaluator       (one call across synth output)
 *
 * Every best-effort agent (T1/T2/T3/T5) is wrapped in `withTimeoutOrFallback`
 * so a hung provider call or a malformed response degrades to an empty result
 * instead of taking down the whole run. The Synthesizer (T4) is load-bearing —
 * without its output there are no drafts to persist — so it runs under a hard
 * `withTimeout` deadline and any timeout/failure is rethrown as a
 * `SynthesizerError` that intentionally fails the job (surfacing an empty
 * distill as "completed", or hanging forever on a stalled provider, would both
 * mislead the user).
 *
 * Returns the structured result shape; the caller (`job-runner.ts`)
 * persists everything to Dexie + flips the parent TwinJob.
 */

import type {
  EntityRole,
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
import { runEntityMergeAgent } from "./agents/entity-merge-agent"
import { runSynthesizer, type SynthDraft } from "./agents/synthesizer"
import { runEvaluator } from "./agents/evaluator"
import type { LlmClient } from "./llm"
import { DEFAULT_AGENT_TIMEOUT_MS, withTimeout, withTimeoutOrFallback } from "./with-timeout"
import { runWithConcurrency } from "@/lib/plugin/core/concurrency"

/**
 * Thrown when the load-bearing Synthesizer stage times out or fails to produce
 * usable output. It propagates out of {@link runOrchestrator} so the job worker
 * marks the distill job failed (with a clear message) instead of completing it
 * with no drafts — and, critically, instead of hanging forever on a stalled
 * provider call (the Synthesizer previously ran with no deadline at all).
 */
export class SynthesizerError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(`Distill synthesizer failed: ${message}`)
    this.name = "SynthesizerError"
    this.cause = cause
  }
}

const KNOWLEDGE_BATCH_SIZE = 100
// Knowledge batches are independent (results accumulate order-free), so run a
// few concurrently instead of strictly serially — bounded to avoid a
// thundering-herd of provider calls.
const KNOWLEDGE_CONCURRENCY = 4

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

  // ───── Stage 1: KnowledgeAgent (chunk-level, batched, bounded-concurrent) ─────
  const allEntities: ProfileEntity[] = []
  const chunkEntityTags: Record<string, string[]> = {}
  const knowledgeBatches: { batch: TwinChunk[]; label: string }[] = []
  for (let i = 0; i < chunks.length; i += KNOWLEDGE_BATCH_SIZE) {
    knowledgeBatches.push({
      batch: chunks.slice(i, i + KNOWLEDGE_BATCH_SIZE),
      label: `knowledge-agent#${Math.floor(i / KNOWLEDGE_BATCH_SIZE)}`,
    })
  }
  // Collect per-batch results by index so the merged order stays deterministic
  // regardless of completion order.
  const batchResults: { entities: ProfileEntity[]; perChunk: Record<string, string[]> }[] =
    new Array(knowledgeBatches.length)
  let processedChunks = 0
  await runWithConcurrency(knowledgeBatches, KNOWLEDGE_CONCURRENCY, async (b, idx) => {
    const { value } = await withTimeoutOrFallback(
      () => runKnowledgeAgent(llm, { chunks: b.batch }),
      b.label,
      {
        timeoutMs: agentTimeoutMs,
        fallback: { entities: [] as ProfileEntity[], perChunk: {} as Record<string, string[]> },
        onError: recordFailure, // captured into partialFailures
      }
    )
    batchResults[idx] = value
    processedChunks += b.batch.length
    if (onProgress) {
      await onProgress("knowledge-agent", processedChunks / chunks.length / 5)
    }
  })
  for (const r of batchResults) {
    if (!r) continue
    allEntities.push(...r.entities)
    Object.assign(chunkEntityTags, r.perChunk)
  }
  await onProgress?.("knowledge-agent", 0.2)

  // ───── Stage 1.5: EntityMergeAgent (cross-batch alias folding) ─────
  // Knowledge batches see different name variants in different windows
  // ("Alice" vs "Alice Wang" vs "alice"). The merge agent buckets the
  // entities by role, asks the LLM "which of these are the same?", and
  // returns a canonical-name → aliases mapping. Falls back to
  // `dedupeEntitiesByName` (lowercased-name match) on timeout or error.
  const lowercaseDeduped = dedupeEntitiesByName(allEntities)
  const mergeResult = await withTimeoutOrFallback(
    () => runEntityMergeAgent(llm, { entities: lowercaseDeduped }),
    "entity-merge-agent",
    {
      timeoutMs: agentTimeoutMs,
      fallback: {
        merged: lowercaseDeduped,
        collapsed: {} as Partial<Record<EntityRole, number>>,
      },
      onError: recordFailure,
    }
  )
  const mergedEntities = mergeResult.value.merged
  // Build a name → canonical-name map (lowercased keys) so we can remap
  // chunkEntityTags. Every alias on the merged entity points back to its
  // canonical name.
  const canonicalOf = new Map<string, string>()
  for (const entity of mergedEntities) {
    canonicalOf.set(entity.name.toLowerCase(), entity.name)
    for (const alias of entity.aliases) {
      canonicalOf.set(alias.toLowerCase(), entity.name)
    }
  }
  const mergedTags: Record<string, string[]> = {}
  for (const [chunkId, names] of Object.entries(chunkEntityTags)) {
    const remapped = new Set<string>()
    for (const name of names) {
      remapped.add(canonicalOf.get(name.toLowerCase()) ?? name)
    }
    mergedTags[chunkId] = Array.from(remapped)
  }
  await onProgress?.("entity-merge-agent", 0.3)

  // ───── Stages 2 + 3: StyleAgent ‖ PlaybookAgent (independent — run together) ─────
  // Neither depends on the other's output (they join only at the synthesizer),
  // so run them concurrently. Each keeps its own timeout + fallback + failure
  // capture, so one degrading doesn't affect the other.
  const [styleResult, playbookResult] = await Promise.all([
    withTimeoutOrFallback(() => runStyleAgent(llm, { chunks }), "style-agent", {
      timeoutMs: agentTimeoutMs,
      fallback: { samples: [] as StyleSample[] },
      onError: recordFailure,
    }),
    withTimeoutOrFallback(() => runPlaybookAgent(llm, { chunks }), "playbook-agent", {
      timeoutMs: agentTimeoutMs,
      fallback: { playbooks: [] as Playbook[] },
      onError: recordFailure,
    }),
  ])
  await onProgress?.("style-agent", 0.4)
  await onProgress?.("playbook-agent", 0.6)

  // ───── Stage 4: Synthesizer (load-bearing — failure aborts the run) ─────
  // Build a transient profile that already includes this run's distillation
  // so the synthesizer sees the latest data, even when partial agents
  // contributed empty arrays.
  const transientProfile: TwinProfile = {
    ...profile,
    styleSamples: [...profile.styleSamples, ...styleResult.value.samples],
    playbooks: [...profile.playbooks, ...playbookResult.value.playbooks],
    entities: dedupeEntitiesByName([...profile.entities, ...mergedEntities]),
    updatedAt: Date.now(),
  }
  const recent = chunks.slice(-30)
  let synthResult: Awaited<ReturnType<typeof runSynthesizer>>
  try {
    // Hard deadline (no fallback): the Synthesizer is load-bearing, so on a
    // timeout or parse failure we fail the job loudly rather than hang or
    // complete empty.
    synthResult = await withTimeout(
      runSynthesizer(llm, { profile: transientProfile, recentChunks: recent }),
      agentTimeoutMs,
      "synthesizer"
    )
  } catch (err) {
    throw new SynthesizerError(err instanceof Error ? err.message : String(err), err)
  }
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
    entities: mergedEntities,
    chunkEntityTags: mergedTags,
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
    // Key by name AND role so a person and a project that happen to share a
    // name aren't collapsed into one entity with an arbitrary role.
    const key = `${entity.name.toLowerCase()}::${entity.role}`
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
