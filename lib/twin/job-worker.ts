/**
 * Job worker — drains queued `twinJobs` rows.
 *
 * Pairs `lib/db/twin-jobs.ts:claimNextQueuedJob` (FIFO, atomic) with the
 * ingest pipeline (`lib/twin/ingest/job-runner.ts`) and the distill
 * pipeline. Adds three reliability layers on top of the bare claim/run
 * loop:
 *
 *  • **Exponential-backoff retry** — transient failures requeue with
 *    `requeueJob` and a `nextAttemptAt` computed by `job-retry.backoffMs`,
 *    until the budget (`MAX_RETRIES`) is exhausted; then the job is
 *    dead-lettered with a sentinel-prefixed message.
 *  • **Concurrency caps** — independent budgets for `ingest` and `distill`
 *    so a long distill run can't starve faster ingest jobs (or vice versa).
 *  • **Pause / resume** — the workbench can suspend the loop without
 *    tearing down the worker; useful when the user wants to disable
 *    background work temporarily.
 */

import {
  completeJob,
  failJob,
  getTwinJob,
  pauseJob as pauseJobRow,
  releaseClaim,
  requeueJob,
  resumeJob as resumeJobRow,
} from "@/lib/db/twin-jobs"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import { createVectorStore, type IVectorStore, type VectorStoreConfig } from "@cognia/vector/store"
import { loggers } from "@/lib/logging"
import type { TwinJob, TwinJobKind, TwinSource, VectorBackend } from "@/types/twin"
import { type EmbeddingConfig } from "./ingest/embed"
import { type RawSource } from "./ingest/parse"
import { runIngestJob } from "./ingest/job-runner"
import { claimNextQueuedJob } from "@/lib/db/twin-jobs"
import { runDistillJob } from "./distill/job-runner"
import type { LlmClient } from "./distill/llm"
import { backoffMs, formatDeadLetter, shouldRetry } from "./job-retry"

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
  /** Concurrency budget for ingest jobs. Defaults to 1. */
  maxConcurrentIngest?: number
  /** Concurrency budget for distill / re-distill jobs. Defaults to 1. */
  maxConcurrentDistill?: number
  /**
   * Injectable clock + RNG — exposed so the unit suite can drive backoff
   * deterministically. Production callers leave them undefined.
   */
  now?: () => number
  random?: () => number
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
 *
 * Failures route through `handleJobFailure` which decides between requeue
 * (transient, budget remaining) and dead-letter (final, budget exhausted).
 */
export async function processJob(jobId: string, config: JobWorkerConfig): Promise<void> {
  const job = await getTwinJob(jobId)
  if (!job) {
    log.warn("twin job-worker: job vanished mid-claim", { jobId })
    return
  }
  if (job.status === "completed" || job.status === "paused") return

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
      // When every source in the batch failed, upgrade to a job-level failure
      // so the workbench surfaces the run as broken instead of "completed
      // with zero outputs".
      if (result.failureSummary.allFailed) {
        const summary = summarizeFailures(result.failureSummary.failures)
        await handleJobFailure(job, `all-sources-failed: ${summary}`, config)
        return
      }
      await completeJob(job.id, {
        llmTokensUsed: 0,
        embeddingTokensUsed: result.totalEmbeddingTokens,
      })
      log.info("twin job-worker: ingest complete", {
        jobId: job.id,
        twinId: job.twinId,
        sources: result.parsedSourceIds.length,
        chunks: result.totalChunks,
        failedSources: result.failureSummary.failureCount,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error("twin job-worker: ingest failed", err)
      await handleJobFailure(job, message, config)
    }
    return
  }

  if (job.kind === "distill" || job.kind === "re-distill") {
    if (!config.llm) {
      // Configuration error — no point retrying.
      await failJob(job.id, "Distill job queued but no LLM client configured on the worker")
      return
    }
    try {
      const result = await runDistillJob({
        job,
        llm: config.llm,
        maxChunks: config.distillMaxChunks,
        // Forward the worker's embedding config so distill can populate
        // `StyleSample.embedding` inline — runtime few-shot then scores
        // by cosine instead of the token-overlap fallback.
        embedding: config.embedding,
      })
      await completeJob(job.id, {
        outputDraftIds: result.draftIds,
        llmTokensUsed: result.llmTokensUsed,
        // Persist sub-agent fallbacks so the Jobs tab can warn that a
        // "completed" run produced a partial profile. Omit the field on a
        // clean run to keep the row tidy.
        ...(Object.keys(result.partialFailures).length > 0
          ? { partialFailures: result.partialFailures }
          : {}),
      })
      log.info("twin job-worker: distill complete", {
        jobId: job.id,
        twinId: job.twinId,
        drafts: result.draftIds.length,
        styleSamples: result.styleSampleCount,
        playbooks: result.playbookCount,
        entities: result.entityCount,
        llmTokens: result.llmTokensUsed,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error("twin job-worker: distill failed", err)
      await handleJobFailure(job, message, config)
    }
    return
  }

  await failJob(job.id, `Worker received unknown job kind: ${String(job.kind)}`)
}

function summarizeFailures(
  failures: Array<{ filename: string; message: string }>,
  max: number = 3
): string {
  if (failures.length === 0) return ""
  const head = failures.slice(0, max).map((f) => `${f.filename}: ${f.message}`)
  const tail = failures.length > max ? ` …+${failures.length - max} more` : ""
  return head.join("; ") + tail
}

/**
 * Decide whether a transient failure should be requeued with backoff or
 * dead-lettered. The `nextAttemptAt` is computed before the row is
 * mutated so callers can observe a deterministic clock for tests.
 */
async function handleJobFailure(
  job: TwinJob,
  message: string,
  config: JobWorkerConfig
): Promise<void> {
  const now = (config.now ?? Date.now)()
  const random = config.random ?? Math.random
  // `job.retryCount` is the count *before* this failure. The worker has
  // performed `retryCount` retries already; this latest attempt is
  // attempt #(retryCount+1).
  if (shouldRetry(job.retryCount)) {
    const wait = backoffMs(job.retryCount + 1, random)
    await requeueJob(job.id, now + wait)
    log.warn("twin job-worker: requeued for retry", {
      jobId: job.id,
      attempt: job.retryCount + 1,
      backoffMs: wait,
      message,
    })
    return
  }
  const deadLetter = formatDeadLetter(message, job.retryCount + 1)
  await failJob(job.id, deadLetter)
  log.error("twin job-worker: dead-lettered", new Error(deadLetter))
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
 * empty. Concurrency tracking is the caller's responsibility — see
 * `startJobWorker` for the full loop.
 */
export async function runNextQueuedJob(
  config: JobWorkerConfig,
  twinId?: string
): Promise<string | null> {
  const job = await claimNextQueuedJob(twinId, (config.now ?? Date.now)())
  if (!job) return null
  await processJob(job.id, config)
  return job.id
}

export interface JobWorkerHandle {
  /** True while the loop is active and not paused. */
  isRunning(): boolean
  /** True when the loop is paused (still alive, not claiming). */
  isPaused(): boolean
  /** Suspend claiming new jobs; in-flight jobs run to completion. */
  pause(): void
  /** Resume a paused loop. */
  resume(): void
  /** Suspend a single queued/running job by id. */
  pauseJob(jobId: string): Promise<void>
  /** Resume a paused job by id. */
  resumeJob(jobId: string): Promise<void>
  /** Stop the loop (drains the in-flight job before returning). */
  stop(): Promise<void>
}

/**
 * Start a polling worker. The returned handle exposes lifecycle controls
 * so the workbench can pause / resume / stop without tearing down the
 * worker. Concurrency is enforced per-kind via the in-flight bookkeeping
 * Sets (`inflightIngest`, `inflightDistill`) so a slow distill can't
 * block fast ingest claims, even on a single tab.
 */
export function startJobWorker(config: JobWorkerConfig, twinId?: string): JobWorkerHandle {
  const interval = Math.max(500, config.pollIntervalMs ?? 2000)
  const maxIngest = Math.max(1, config.maxConcurrentIngest ?? 1)
  const maxDistill = Math.max(1, config.maxConcurrentDistill ?? 1)

  let running = true
  let paused = false
  const inflightIngest = new Set<string>()
  const inflightDistill = new Set<string>()
  const inflightAll = new Set<Promise<unknown>>()

  const seatsOpen = (kind: TwinJobKind): boolean => {
    if (kind === "ingest") return inflightIngest.size < maxIngest
    return inflightDistill.size < maxDistill
  }

  const tickOnce = async () => {
    if (paused) return
    // Don't claim anything when neither kind has a free seat — avoids churn
    // and avoids claiming a job we'd only have to release.
    if (!seatsOpen("ingest") && !seatsOpen("distill")) return
    const job = await claimNextQueuedJob(twinId, (config.now ?? Date.now)())
    if (!job) return
    if (!seatsOpen(job.kind)) {
      // Claimed a job whose kind has no free seat — release it WITHOUT burning
      // the retry budget. Seat contention is not a failure, so this must not go
      // through `requeueJob` (which increments retryCount and could dead-letter
      // a perfectly healthy job after a few bounces).
      await releaseClaim(job.id)
      return
    }
    const tracker = job.kind === "ingest" ? inflightIngest : inflightDistill
    tracker.add(job.id)
    const promise = processJob(job.id, config)
      .catch((err) => {
        log.error("twin job-worker: tick error", err)
      })
      .finally(() => {
        tracker.delete(job.id)
        inflightAll.delete(promise)
      })
    inflightAll.add(promise)
  }

  const loop = async () => {
    while (running) {
      try {
        await tickOnce()
      } catch (err) {
        log.error("twin job-worker loop error", err)
      }
      // Sleep regardless of whether work was found; the loop is paced by
      // pollIntervalMs to avoid tight DB polling.
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
  }

  void loop()

  return {
    isRunning: () => running && !paused,
    isPaused: () => paused,
    pause: () => {
      paused = true
    },
    resume: () => {
      paused = false
    },
    async pauseJob(jobId: string) {
      await pauseJobRow(jobId)
    },
    async resumeJob(jobId: string) {
      await resumeJobRow(jobId)
    },
    async stop() {
      running = false
      // Drain in-flight work so callers (workbench unmount) see a clean exit.
      const pending = Array.from(inflightAll)
      for (const p of pending) {
        try {
          await p
        } catch {
          /* swallowed by individual catches in tickOnce */
        }
      }
    },
  }
}
