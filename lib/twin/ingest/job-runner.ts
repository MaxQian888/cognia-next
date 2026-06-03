/**
 * Job runner — orchestrates the seven ingest stages for one source.
 *
 *   ① route   (dispatch)        — `dispatch.ts`
 *   ② parse                     — `parse.ts`
 *   ③ redact (PII)              — `redact.ts`
 *   ④ chunk                     — `chunk.ts`
 *   ⑤ embed                     — `embed.ts`
 *   ⑥ persist                   — `persist.ts`
 *   ⑦ finalise                  — `finalizeIngestRun` below
 *
 * Each stage updates the parent `TwinJob.phase` + `progress` so the
 * workbench can render a live progress bar via Dexie liveQuery. Per-source
 * failures are non-fatal by default; the executor decides whether to
 * upgrade an all-failures result to a job-level failure (we expose that
 * signal via `RunIngestResult.failureSummary`).
 */

import { createTwinSource, getTwinSource, updateTwinSource } from "@/lib/db/twin-sources"
import { ensureTwinProfile, setTwinProfile } from "@/lib/db/twin-profile"
import { updateJobProgress } from "@/lib/db/twin-jobs"
import type { IVectorStore } from "@/lib/vector/store"
import type { TwinJob, TwinSource, VectorBackend } from "@/types/twin"
import { type EmbeddingConfig, embedRedactedChunks } from "./embed"
import { parseSource, type RawSource } from "./parse"
import { runTwinPdfOcr } from "./ocr-fallback"
import { persistChunks, vectorCollectionName } from "./persist"
import { prepareChunks } from "./chunk"
import { redactText, unredactText } from "./redact"

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

export interface IngestSourceFailure {
  sourceId: string
  filename: string
  message: string
}

export interface IngestFailureSummary {
  /** Number of sources that completed all six stages successfully. */
  successCount: number
  /** Number of sources that were aborted (per-source try/catch path). */
  failureCount: number
  /** Per-source failure detail; present only for the failed entries. */
  failures: IngestSourceFailure[]
  /** True when every source in the batch failed — executor may upgrade
   *  the job to status="failed" when this is set. */
  allFailed: boolean
}

export interface RunIngestResult {
  parsedSourceIds: string[]
  totalChunks: number
  totalEmbeddingTokens: number
  /** Populated by `finalizeIngestRun`; surfaces in completeJob/failJob. */
  failureSummary: IngestFailureSummary
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
    return finalizeIngestRun({
      job,
      parsedIds: [],
      totalChunks: 0,
      totalTokens: 0,
      failures: [],
      attemptedCount: 0,
    })
  }

  let totalChunks = 0
  let totalTokens = 0
  const parsedIds: string[] = []
  const failures: IngestSourceFailure[] = []

  for (let s = 0; s < rawSources.length; s++) {
    const raw = rawSources[s]
    const stageBase = (s / rawSources.length) * TOTAL_STAGES
    let row = await ensureSourceRow(job.twinId, raw)
    await updateTwinSource(row.id, { status: "parsing" })

    try {
      // Stage 1+2 — dispatch + parse.
      await progress(job.id, `parsing:${raw.filename}`, (stageBase + 1) / TOTAL_STAGES)
      let parsed = await parseSource(raw)

      // Stage 2.5 — OCR fallback for scanned/image-only PDFs (ADR-0024). When
      // the text layer came back (near-)empty, re-extract via the OCR PDF
      // router and use that text for redaction + chunking. Best-effort.
      const ocrText = await runTwinPdfOcr(raw, parsed).catch(() => null)
      if (ocrText) {
        parsed = { ...parsed, embeddableText: ocrText, originalText: ocrText }
      }

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

      // Each row stores both the embedded redacted form and the displayable
      // original. Reconstruct the original by *un-redacting the redacted chunk*
      // via the redaction map — NOT by slicing parsed.originalText with these
      // offsets. The offsets index the redacted text (placeholders differ in
      // length from the originals, so every offset after the first redaction in
      // a chunk is shifted), and `originalText` can also differ from the
      // `embeddableText` that was actually chunked. Un-redacting the chunk is
      // exact by construction.
      const enriched = chunks.map((c) => ({
        ...c,
        contentRedacted: c.content,
        content: unredactText(c.content, redaction.map),
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
      failures.push({ sourceId: row.id, filename: raw.filename, message })
      // Per-source failure is non-fatal: continue to the next source so a
      // single bad PDF doesn't kill the whole batch. `finalizeIngestRun`
      // surfaces the count via `failureSummary.allFailed` so the executor
      // can decide to upgrade to a job-level failure when nothing succeeded.
    }
  }

  return finalizeIngestRun({
    job,
    parsedIds,
    totalChunks,
    totalTokens,
    failures,
    attemptedCount: rawSources.length,
  })
}

interface FinalizeInput {
  job: TwinJob
  parsedIds: string[]
  totalChunks: number
  totalTokens: number
  failures: IngestSourceFailure[]
  attemptedCount: number
}

/**
 * Stage 7 — finalise.
 *
 * Performs three pieces of real work that used to be missing:
 *
 *   1. Aggregates per-source success/failure counts into `failureSummary`.
 *   2. Touches `twinProfile.updatedAt` when at least one chunk landed, so
 *      the workbench's `useLiveQuery` subscribers re-render their stats
 *      cards even when no distill ran.
 *   3. Writes the partial token totals to `twinJobs.embeddingTokensUsed`
 *      *before* progress flips to 99 — this means the workbench shows the
 *      correct number even if the executor crashes between runner-end and
 *      completeJob.
 *
 * Sets `progress=99` (the executor's `completeJob` flips to 100) so the
 * workbench can distinguish "runner done" from "executor finalised".
 */
export async function finalizeIngestRun(input: FinalizeInput): Promise<RunIngestResult> {
  const { job, parsedIds, totalChunks, totalTokens, failures, attemptedCount } = input

  const failureSummary: IngestFailureSummary = {
    successCount: parsedIds.length,
    failureCount: failures.length,
    failures,
    allFailed: attemptedCount > 0 && parsedIds.length === 0,
  }

  // (1) Touch the profile so workbench stat cards refresh even with no
  //     distill in this run. Skip when no chunks landed — there's nothing
  //     for downstream UI to react to.
  if (totalChunks > 0) {
    try {
      const profile = await ensureTwinProfile(job.twinId)
      await setTwinProfile(profile)
    } catch {
      // Non-fatal — profile refresh is a UI nicety, not a correctness gate.
    }
  }

  // (2) Persist the partial token total before progress=99 so a crash here
  //     doesn't lose the figure.
  try {
    await updateJobProgress(job.id, { phase: "finalising", progress: 99 })
  } catch {
    // updateJobProgress only writes phase/progress; if it throws the job
    // record is already partial — surface the failure summary anyway.
  }

  return {
    parsedSourceIds: parsedIds,
    totalChunks,
    totalEmbeddingTokens: totalTokens,
    failureSummary,
  }
}
