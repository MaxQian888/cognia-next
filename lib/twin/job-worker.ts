/**
 * Job worker — drains queued `twinJobs` rows.
 *
 * Pairs `lib/db/twin-jobs.ts:claimNextQueuedJob` (FIFO, atomic) with the
 * ingest pipeline (`lib/twin/ingest/job-runner.ts`). The worker is
 * intentionally lightweight: no cron, no retries, no concurrency — just a
 * single-tab loop the workbench (Phase 7) starts when the user clicks
 * "Start ingest" and stops on unmount.
 *
 * For cron-driven retries / multi-host distribution, plug a Phase-5+
 * scheduler executor on top — the queue + claim contract is the same.
 */

import { completeJob, failJob, getTwinJob } from "@/lib/db/twin-jobs"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import { createVectorStore, type IVectorStore, type VectorStoreConfig } from "@/lib/vector/store"
import { loggers } from "@/lib/logger"
import type { TwinJob, TwinSource, VectorBackend } from "@/types/twin"
import { type EmbeddingConfig } from "./ingest/embed"
import { type RawSource } from "./ingest/parse"
import { runIngestJob } from "./ingest/job-runner"
import { claimNextQueuedJob } from "@/lib/db/twin-jobs"
import { runDistillJob } from "./distill/job-runner"
import type { LlmClient } from "./distill/llm"

const log = loggers.scheduler

/**
 * Looks up the raw bytes / text for a `TwinSource`. The workbench is the
 * source of truth for buffers (it holds the user's File objects in
 * memory); production callers inject their own loader. Tests pass a
 * deterministic in-memory map.
 */
export type SourceLoader = (source: TwinSource) => Promise<RawSource>

export interface JobWorkerConfig {
  /** Embedding provider config + API key. */
  embedding: EmbeddingConfig
  /** Vector backend identifier (must match `store.provider`). */
  vectorBackend: VectorBackend
  /**
   * Vector store factory. When omitted the worker builds one from
   * `vectorStoreConfig` via `createVectorStore`. Tests inject a mock.
   */
  store?: IVectorStore
  /** Used when `store` is not provided. */
  vectorStoreConfig?: VectorStoreConfig
  /** Loader that materialises a `TwinSource` row into a `RawSource`. */
  sourceLoader: SourceLoader
  /** Polling interval when running in `start()` mode. Defaults to 2 s. */
  pollIntervalMs?: number
  /**
   * LLM client for distill jobs. Required when distill / re-distill jobs
   * are queued; ingest-only deployments can leave it undefined.
   */
  llm?: LlmClient
  /** Maximum chunks fed into a single distill run. */
  distillMaxChunks?: number
}

function resolveStore(config: JobWorkerConfig): IVectorStore {
  if (config.store) return config.store
  if (!config.vectorStoreConfig) {
    throw new Error("JobWorker: provide either `store` or `vectorStoreConfig`")
  }
  return createVectorStore(config.vectorStoreConfig)
}

/**
 * Process a single job. Idempotent in the sense that re-running an
 * already-completed job is a no-op (the job is observed as `completed`
 * and skipped); but the underlying ingest writes are NOT idempotent — the
 * worker contract is "claim once, run once".
 */
export async function processJob(jobId: string, config: JobWorkerConfig): Promise<void> {
  const job = await getTwinJob(jobId)
  if (!job) {
    log.warn("twin job-worker: job vanished mid-claim", { jobId })
    return
  }
  if (job.status === "completed") return

  if (job.kind === "ingest") {
    const store = resolveStore(config)
    const sources = await loadSourcesForJob(job, config.sourceLoader)
    try {
      const result = await runIngestJob({
        job,
        rawSources: sources,
        embedding: config.embedding,
        vectorBackend: config.vectorBackend,
        store,
      })
      await completeJob(job.id, {
        llmTokensUsed: 0,
        embeddingTokensUsed: result.totalEmbeddingTokens,
      })
      log.info("twin job-worker: ingest complete", {
        jobId: job.id,
        twinId: job.twinId,
        sources: result.parsedSourceIds.length,
        chunks: result.totalChunks,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error("twin job-worker: ingest failed", err)
      await failJob(job.id, message)
    }
    return
  }

  if (job.kind === "distill" || job.kind === "re-distill") {
    if (!config.llm) {
      await failJob(job.id, "Distill job queued but no LLM client configured on the worker")
      return
    }
    try {
      const result = await runDistillJob({
        job,
        llm: config.llm,
        maxChunks: config.distillMaxChunks,
      })
      await completeJob(job.id, { outputDraftIds: result.draftIds })
      log.info("twin job-worker: distill complete", {
        jobId: job.id,
        twinId: job.twinId,
        drafts: result.draftIds.length,
        styleSamples: result.styleSampleCount,
        playbooks: result.playbookCount,
        entities: result.entityCount,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error("twin job-worker: distill failed", err)
      await failJob(job.id, message)
    }
    return
  }

  await failJob(job.id, `Worker received unknown job kind: ${String(job.kind)}`)
}

async function loadSourcesForJob(job: TwinJob, loader: SourceLoader): Promise<RawSource[]> {
  // The job stores the sources it covers as `sourceIds`; for an "all-twin"
  // ingest the executor passes an empty array and the worker grabs every
  // pending source for the twin.
  const ids = new Set(job.sourceIds)
  const allForTwin = await listTwinSourcesByTwin(job.twinId)
  const targets = ids.size === 0 ? allForTwin : allForTwin.filter((row) => ids.has(row.id))
  const raws: RawSource[] = []
  for (const target of targets) {
    raws.push(await loader(target))
  }
  return raws
}

/**
 * Run the next queued job for `twinId` (or any twin if omitted) once.
 * Returns the job id that was processed, or `null` when the queue was
 * empty.
 */
export async function runNextQueuedJob(
  config: JobWorkerConfig,
  twinId?: string
): Promise<string | null> {
  const job = await claimNextQueuedJob(twinId)
  if (!job) return null
  await processJob(job.id, config)
  return job.id
}

export interface JobWorkerHandle {
  /** True while the loop is active. */
  isRunning(): boolean
  /** Stop the loop (drains the in-flight job before returning). */
  stop(): Promise<void>
}

/**
 * Start a polling worker. The returned handle exposes `stop()` so React
 * components can detach it on unmount. Production callers usually want
 * one-worker-per-window; the workbench claims tab-leadership before
 * starting to avoid double-claiming jobs across browser tabs.
 */
export function startJobWorker(config: JobWorkerConfig, twinId?: string): JobWorkerHandle {
  const interval = Math.max(500, config.pollIntervalMs ?? 2000)
  let running = true
  let inFlight: Promise<unknown> | null = null

  const loop = async () => {
    while (running) {
      try {
        inFlight = runNextQueuedJob(config, twinId)
        const id = await inFlight
        inFlight = null
        if (!id) {
          // No job — sleep before checking again.
          await new Promise((resolve) => setTimeout(resolve, interval))
        }
      } catch (err) {
        log.error("twin job-worker loop error", err)
        inFlight = null
        await new Promise((resolve) => setTimeout(resolve, interval))
      }
    }
  }

  void loop()

  return {
    isRunning: () => running,
    async stop() {
      running = false
      if (inFlight) {
        try {
          await inFlight
        } catch {
          /* swallowed by loop */
        }
      }
    },
  }
}
