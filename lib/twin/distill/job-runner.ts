/**
 * Distill job runner — owns a `twinJobs` row of kind="distill" through its
 * lifecycle: claim → orchestrate → persist → complete.
 *
 * Symmetric to `lib/twin/ingest/job-runner.ts`: input is a TwinJob row +
 * the chunk pool; output is committed to Dexie via the CRUD modules.
 */

import { listTwinChunksByTwin, updateTwinChunk } from "@/lib/db/twin-chunks"
import { bulkCreateTwinDrafts } from "@/lib/db/twin-drafts"
import { updateJobProgress } from "@/lib/db/twin-jobs"
import { hasNoLeakingPii, redactText } from "@/lib/twin/ingest/redact"
import { loggers } from "@/lib/logger"
import {
  appendPlaybooks,
  appendStyleSamples,
  ensureTwinProfile,
  setVoiceSummary,
  upsertEntities,
} from "@/lib/db/twin-profile"
import { generateEmbedding } from "@/lib/ai/embedding/embedding"
import type { TwinDraft, TwinJob } from "@/types/twin"
import type { EmbeddingConfig } from "@/lib/twin/ingest/embed"
import type { LlmClient } from "./llm"
import { runOrchestrator } from "./orchestrator"

export interface RunDistillInput {
  job: TwinJob
  llm: LlmClient
  /** Maximum chunks pulled from the pool. Defaults to 200 — bigger pools
   *  are dropped down to the most-recent N to keep the prompt tractable. */
  maxChunks?: number
  /**
   * Optional embedding config. When supplied, the distill run computes a
   * cosine-space embedding for each new StyleSample's `summary` and
   * persists it onto the sample — runtime `selectFewShotSamples` then
   * scores by cosine instead of falling back to the token-overlap
   * heuristic. When omitted, samples are persisted without embeddings.
   */
  embedding?: EmbeddingConfig
}

export interface RunDistillResult {
  draftIds: string[]
  styleSampleCount: number
  playbookCount: number
  entityCount: number
  /** Total prompt + completion tokens consumed across the five agents. */
  llmTokensUsed: number
  /** Per-agent failure messages when isolation kicked in (empty on a clean run). */
  partialFailures: Record<string, string>
}

export async function runDistillJob(input: RunDistillInput): Promise<RunDistillResult> {
  const { job, llm } = input
  await updateJobProgress(job.id, { phase: "loading-chunks", progress: 5 })

  const allChunks = await listTwinChunksByTwin(job.twinId)
  if (allChunks.length === 0) {
    return {
      draftIds: [],
      styleSampleCount: 0,
      playbookCount: 0,
      entityCount: 0,
      llmTokensUsed: 0,
      partialFailures: {},
    }
  }
  const chunks =
    input.maxChunks && allChunks.length > input.maxChunks
      ? allChunks.slice(-input.maxChunks)
      : allChunks

  await updateJobProgress(job.id, { phase: "loading-profile", progress: 10 })
  const profile = await ensureTwinProfile(job.twinId)

  // ───── Orchestrate ─────
  const result = await runOrchestrator({
    llm,
    profile,
    chunks,
    onProgress: async (phase, ratio) => {
      // Stages 1-5 occupy 10% → 85% of the bar; the remainder (85% → 100%)
      // is reserved for persistence.
      const mapped = 10 + Math.round(ratio * 75)
      await updateJobProgress(job.id, { phase, progress: mapped })
    },
  })

  // ───── Persist profile updates ─────
  await updateJobProgress(job.id, { phase: "persisting-profile", progress: 87 })
  // Wrap `generateEmbedding` so `appendStyleSamples` can populate
  // `StyleSample.embedding` inline. Failures are swallowed per-sample —
  // the runtime falls back to token-overlap when the field is absent.
  const embeddingFn = input.embedding
    ? async (summary: string): Promise<number[]> => {
        const result = await generateEmbedding(summary, input.embedding!)
        return result.embedding
      }
    : undefined
  await appendStyleSamples(job.twinId, result.styleSamples, { embeddingFn })
  await appendPlaybooks(job.twinId, result.playbooks)
  if (result.entities.length > 0) {
    await upsertEntities(job.twinId, result.entities)
  }
  if (result.voiceSummary && result.voiceSummary !== profile.voiceSummary) {
    await setVoiceSummary(job.twinId, result.voiceSummary)
  }

  // ───── Persist per-chunk entity tags ─────
  await updateJobProgress(job.id, { phase: "tagging-chunks", progress: 92 })
  for (const [chunkId, names] of Object.entries(result.chunkEntityTags)) {
    if (names.length > 0) {
      await updateTwinChunk(chunkId, { entityTags: names })
    }
  }

  // ───── Persist drafts (with evaluations) ─────
  await updateJobProgress(job.id, { phase: "persisting-drafts", progress: 96 })
  // Post-flight PII check: even though we redact at ingest, the synthesizer
  // could in theory hallucinate a PII-shaped string back into a draft body.
  // Run hasNoLeakingPii on every draft and re-redact (in place) when it
  // fires, logging the event so the audit trail makes the cause clear.
  const sanitizedDrafts = result.synthesizedDrafts.map((draft) =>
    sanitizeDraftPayload(draft, job.id, job.twinId)
  )

  // The orchestrator returned drafts with placeholder ids ("tmp_0", "tmp_1").
  // Use the same placeholder index to look up the evaluation, then drop the
  // placeholder so Dexie mints the real id.
  const draftRows = await bulkCreateTwinDrafts(
    sanitizedDrafts.map(
      (draft, i): Omit<TwinDraft, "id" | "status" | "createdAt"> => ({
        twinId: job.twinId,
        jobId: job.id,
        kind: draft.payload.kind,
        payload: draft.payload,
        provenance: {
          chunkIds: chunks.slice(-10).map((c) => c.id),
          playbookIds: draft.sourcePlaybookId ? [draft.sourcePlaybookId] : undefined,
          rationale: draft.rationale,
        },
        evaluation: result.evaluations[`tmp_${i}`],
      })
    )
  )

  await updateJobProgress(job.id, { phase: "completed", progress: 99 })

  return {
    draftIds: draftRows.map((d) => d.id),
    styleSampleCount: result.styleSamples.length,
    playbookCount: result.playbooks.length,
    entityCount: result.entities.length,
    llmTokensUsed: result.llmTokensUsed ?? 0,
    partialFailures: result.partialFailures ?? {},
  }
}

/**
 * Run the no-leak gate on a single synthesized draft. Walks the draft's
 * `payload.data` and re-redacts any string field whose contents look like
 * recognised PII. Drafts come from the LLM, which doesn't have access to
 * the redaction map — so any PII that lands here is "hallucinated" and
 * worth recording.
 *
 * Mutates a *new* draft object (no in-place mutation of the orchestrator
 * output) so partial-failure code paths don't see surprises.
 */
function sanitizeDraftPayload<
  T extends { payload: { kind: string; data: Record<string, unknown> } },
>(draft: T, jobId: string, twinId: string): T {
  const data = draft.payload.data
  let mutated = false
  const sanitizedData: Record<string, unknown> = { ...data }
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string") continue
    if (hasNoLeakingPii(value)) continue
    mutated = true
    sanitizedData[key] = redactText(value).redacted
  }
  if (!mutated) return draft
  loggers.scheduler.warn("twin distill: re-redacted draft payload after PII leak", {
    jobId,
    twinId,
    kind: draft.payload.kind,
  })
  return {
    ...draft,
    payload: { ...draft.payload, data: sanitizedData },
  } as T
}
