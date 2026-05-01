/**
 * Distill orchestrator — pipelines the five sub-agents over a chunk pool.
 *
 *   T1  KnowledgeAgent  (batched 100 chunks at a time)
 *   T2  StyleAgent      (one call over 60-chunk sample)
 *   T3  PlaybookAgent   (one call over 80-chunk sample)
 *   T4  Synthesizer     (one call w/ profile + 30 recent chunks)
 *   T5  Evaluator       (one call across synth output)
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

const KNOWLEDGE_BATCH_SIZE = 100

export interface OrchestratorInput {
  llm: LlmClient
  profile: TwinProfile
  chunks: TwinChunk[]
  /** Phase 5 progress hook — orchestrator pings phase + ratio updates. */
  onProgress?: (phase: string, progress: number) => Promise<void> | void
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
}

export async function runOrchestrator(input: OrchestratorInput): Promise<OrchestratorOutput> {
  const { llm, profile, chunks, onProgress } = input

  // ───── Stage 1: KnowledgeAgent (chunk-level, batched) ─────
  const allEntities: ProfileEntity[] = []
  const chunkEntityTags: Record<string, string[]> = {}
  for (let i = 0; i < chunks.length; i += KNOWLEDGE_BATCH_SIZE) {
    const batch = chunks.slice(i, i + KNOWLEDGE_BATCH_SIZE)
    const result = await runKnowledgeAgent(llm, { chunks: batch })
    allEntities.push(...result.entities)
    Object.assign(chunkEntityTags, result.perChunk)
    if (onProgress) {
      await onProgress("knowledge-agent", (i + batch.length) / chunks.length / 5)
    }
  }
  await onProgress?.("knowledge-agent", 0.2)

  // ───── Stage 2: StyleAgent ─────
  const styleResult = await runStyleAgent(llm, { chunks })
  await onProgress?.("style-agent", 0.4)

  // ───── Stage 3: PlaybookAgent ─────
  const playbookResult = await runPlaybookAgent(llm, { chunks })
  await onProgress?.("playbook-agent", 0.6)

  // ───── Stage 4: Synthesizer ─────
  // Build a transient profile that already includes this run's distillation
  // so the synthesizer sees the latest data.
  const transientProfile: TwinProfile = {
    ...profile,
    styleSamples: [...profile.styleSamples, ...styleResult.samples],
    playbooks: [...profile.playbooks, ...playbookResult.playbooks],
    entities: dedupeEntitiesByName([...profile.entities, ...allEntities]),
    updatedAt: Date.now(),
  }
  const recent = chunks.slice(-30)
  const synthResult = await runSynthesizer(llm, {
    profile: transientProfile,
    recentChunks: recent,
  })
  await onProgress?.("synthesizer", 0.8)

  // ───── Stage 5: Evaluator ─────
  // The evaluator wants real `TwinDraft` rows; we synthesise placeholder ids
  // here so the orchestrator can return a stable mapping.
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
  const evalResult = await runEvaluator(llm, { drafts: placeholderDrafts })
  await onProgress?.("evaluator", 1.0)

  return {
    styleSamples: styleResult.samples,
    playbooks: playbookResult.playbooks,
    entities: dedupeEntitiesByName(allEntities),
    chunkEntityTags,
    voiceSummary: synthResult.voiceSummary,
    synthesizedDrafts: synthResult.drafts,
    evaluations: evalResult.evaluations,
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
