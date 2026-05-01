/**
 * Job runner — orchestrates the seven ingest stages for one source.
 *
 *   ① route   (dispatch)        — `dispatch.ts`
 *   ② parse                     — `parse.ts`
 *   ③ redact (PII)              — `redact.ts`
 *   ④ chunk                     — `chunk.ts`
 *   ⑤ embed                     — `embed.ts`
 *   ⑥ persist                   — `persist.ts`
 *   ⑦ finalise                  — inline below
 *
 * Each stage updates the parent `TwinJob.phase` + `progress` so the
 * workbench (Phase 7) can render a live progress bar via Dexie liveQuery.
 * Failures bubble out of the runner; the executor (`twin-distill-executor.ts`)
 * is responsible for marking the job failed and the source `failed`.
 */

import { createTwinSource, getTwinSource, updateTwinSource } from "@/lib/db/twin-sources"
import { failJob, updateJobProgress } from "@/lib/db/twin-jobs"
import type { IVectorStore } from "@/lib/vector/store"
import type { TwinJob, TwinSource, VectorBackend } from "@/types/twin"
import { type EmbeddingConfig, embedRedactedChunks } from "./embed"
import { parseSource, type RawSource } from "./parse"
import { persistChunks, vectorCollectionName } from "./persist"
import { prepareChunks } from "./chunk"
import { redactText } from "./redact"

export interface RunIngestInput {
  job: TwinJob
  /**
   * The raw sources this job covers. Length should equal
   * `job.sourceIds.length` — the executor preloads buffers/text up front
   * so the runner has no IO of its own.
   */
  rawSources: RawSource[]
  embedding: EmbeddingConfig
  vectorBackend: VectorBackend
  store: IVectorStore
  /** Optional override; defaults to `cognia_twin_{twinId}`. */
  vectorCollection?: string
  /** Hints fed to the redactor (per-source speakers / authors / …). */
  nameHints?: string[]
}

export interface RunIngestResult {
  parsedSourceIds: string[]
  totalChunks: number
  totalEmbeddingTokens: number
}

const TOTAL_STAGES = 6 // route+parse counted as one progress step

async function progress(jobId: string, phase: string, ratio: number) {
  await updateJobProgress(jobId, {
    phase,
    progress: Math.min(99, Math.round(ratio * 100)),
  })
}

/**
 * Ensure a `twinSources` row exists for the raw input. The executor may
 * pre-create the row (Phase 7 source-uploader does this) — when that
 * happens we just look it up. Otherwise we mint one in `parsing` state.
 */
async function ensureSourceRow(twinId: string, raw: RawSource): Promise<TwinSource> {
  const existing = await getTwinSource(raw.id)
  if (existing) return existing
  return createTwinSource({
    id: raw.id,
    twinId,
    kind: "document", // overwritten by parse below if needed
    format: raw.format,
    source: raw.filename,
    title: raw.filename,
    bytes: raw.text?.length ?? raw.binary?.byteLength ?? 0,
    fingerprint: `auto_${raw.id}`,
    redacted: false,
    status: "parsing",
  })
}

export async function runIngestJob(input: RunIngestInput): Promise<RunIngestResult> {
  const { job, rawSources, embedding, vectorBackend, store } = input
  const collection = input.vectorCollection ?? vectorCollectionName(job.twinId)

  if (rawSources.length === 0) {
    return { parsedSourceIds: [], totalChunks: 0, totalEmbeddingTokens: 0 }
  }

  let totalChunks = 0
  let totalTokens = 0
  const parsedIds: string[] = []

  for (let s = 0; s < rawSources.length; s++) {
    const raw = rawSources[s]
    const stageBase = (s / rawSources.length) * TOTAL_STAGES
    let row = await ensureSourceRow(job.twinId, raw)
    await updateTwinSource(row.id, { status: "parsing" })

    try {
      // Stage 1+2 — dispatch + parse.
      await progress(job.id, `parsing:${raw.filename}`, (stageBase + 1) / TOTAL_STAGES)
      const parsed = await parseSource(raw)

      // Stage 3 — redact PII.
      await progress(job.id, `redacting:${raw.filename}`, (stageBase + 2) / TOTAL_STAGES)
      const redaction = redactText(parsed.embeddableText, input.nameHints ?? [])

      await updateTwinSource(row.id, {
        kind: parsed.kind,
        title: parsed.title,
        bytes: parsed.bytes,
        redacted: true,
      })
      row = (await getTwinSource(row.id)) as TwinSource

      // Stage 4 — chunk.
      await progress(job.id, `chunking:${raw.filename}`, (stageBase + 3) / TOTAL_STAGES)
      const chunks = prepareChunks({
        redactedText: redaction.redacted,
        originalText: parsed.originalText,
        format: parsed.format,
        baseMetadata: parsed.baseMetadata,
      })
      if (chunks.length === 0) {
        await updateTwinSource(row.id, { status: "parsed", chunkCount: 0, parsedAt: Date.now() })
        parsedIds.push(row.id)
        continue
      }

      // Slice originals back out of the parsed text so each row stores both
      // the displayable original and the embedded redacted form.
      const enriched = chunks.map((c) => ({
        ...c,
        contentRedacted: c.content,
        content: parsed.originalText.slice(c.charStart, c.charEnd) || c.content,
      }))

      // Stage 5 — embed.
      await progress(job.id, `embedding:${raw.filename}`, (stageBase + 4) / TOTAL_STAGES)
      const embeddingResult = await embedRedactedChunks(
        enriched.map((c) => c.contentRedacted),
        embedding
      )
      totalTokens += embeddingResult.tokensUsed ?? 0

      // Stage 6 — persist (Dexie + remote double write).
      await progress(job.id, `persisting:${raw.filename}`, (stageBase + 5) / TOTAL_STAGES)
      const persisted = await persistChunks({
        twinId: job.twinId,
        sourceId: row.id,
        vectorBackend,
        vectorCollection: collection,
        store,
        chunks: enriched,
        embeddings: embeddingResult.embeddings,
      })
      totalChunks += persisted.rows.length
      parsedIds.push(row.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await updateTwinSource(row.id, { status: "failed", errorMessage: message })
      // Per-source failure is non-fatal: continue to the next source so a
      // single bad PDF doesn't kill the whole batch. The job-level failure
      // path (`failJob`) is reserved for systemic issues (auth, network).
      // If the executor wants strict-fail semantics it can opt in via
      // `runIngestJobStrict` (TODO Phase 5).
      void failJob
    }
  }

  // Stage 7 — finalise. Marked at 99 here; the executor flips to 100 on
  // `completeJob` so the workbench distinguishes "runner done" from
  // "executor finalised".
  await progress(job.id, "finalising", 0.99)

  return {
    parsedSourceIds: parsedIds,
    totalChunks,
    totalEmbeddingTokens: totalTokens,
  }
}
