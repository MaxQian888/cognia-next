/**
 * Signed, durable delivery of observation batches to
 * `POST <apiBase>/observations` (plan §4.7, §8).
 *
 * - The body is serialised once and stored in the spool; every retry sends
 *   those exact bytes under the same run ID, so the server can treat a
 *   repeat as the no-op it is (200 duplicate) and a different body under the
 *   same ID as a conflict (409).
 * - Each attempt is signed fresh: the signature covers a *current* request
 *   timestamp (±120 s window), while the observation times stay as observed.
 * - 2xx is done. 409 is a conflicting replay: logged and dropped. 408/429
 *   are transient (429 honours Retry-After). Any other 4xx means the server
 *   will never accept this body: dropped with an operator alert. 5xx and
 *   network errors retry with exponential backoff and jitter until the entry
 *   ages out of the 10-minute late-acceptance window.
 */

import { signProbeRequest } from "../../../../../lib/status/signing"
import type { ObservationBatch } from "../../../../../lib/status/contract"

import type { AlertSink } from "./alerts"
import type { FetchLike } from "./http"
import type { Logger } from "./logger"
import type { LossReason, Spool, SpoolEntry } from "./spool"

export const INGEST_FAILING_ALERT_MS = 3 * 60_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 4 * 1024

export interface BackoffPolicy {
  baseMs: number
  maxMs: number
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 2_000, maxMs: 60_000 }

export interface IngestStats {
  accepted: number
  duplicates: number
  conflicts: number
  rejected: number
  retries: number
  lost: number
}

export interface IngestionQueueOptions {
  apiBase: string
  keyId: string
  secret: Uint8Array
  spool: Spool
  logger: Logger
  alerts: AlertSink
  fetchImpl?: FetchLike
  now?: () => number
  random?: () => number
  backoff?: BackoffPolicy
  requestTimeoutMs?: number
}

/** "Equal jitter": half the exponential delay fixed, half random. */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number): number {
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1))
  return Math.round(exponential / 2 + random() * (exponential / 2))
}

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1_000
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

interface Pending {
  entry: SpoolEntry
  attempts: number
  nextAttemptAtMs: number
}

export class IngestionQueue {
  readonly stats: IngestStats = {
    accepted: 0,
    duplicates: 0,
    conflicts: 0,
    rejected: 0,
    retries: 0,
    lost: 0,
  }
  private readonly pending = new Map<string, Pending>()
  private readonly url: string
  private readonly path: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly random: () => number
  private readonly backoff: BackoffPolicy
  private readonly encoder = new TextEncoder()
  private firstFailureAtMs: number | null = null
  private stopped = false
  private readonly stopController = new AbortController()
  private wake: (() => void) | null = null
  private loop: Promise<void> | null = null

  constructor(private readonly options: IngestionQueueOptions) {
    this.url = `${options.apiBase.replace(/\/+$/, "")}/observations`
    this.path = new URL(this.url).pathname
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.backoff = options.backoff ?? DEFAULT_BACKOFF
  }

  /** Spool loss callback: wire this into the Spool's `onLoss`. */
  recordLoss(entry: Pick<SpoolEntry, "runId" | "scheduledAtMs">, reason: LossReason): void {
    this.pending.delete(entry.runId)
    this.stats.lost += 1
    this.options.logger.warn("observer_loss", {
      runId: entry.runId,
      scheduledAt: entry.scheduledAtMs > 0 ? new Date(entry.scheduledAtMs).toISOString() : null,
      reason,
    })
    if (reason === "overflow") {
      void this.options.alerts.raise(
        "spool_overflow",
        "ingestion spool exceeded 1 MiB; oldest observations dropped"
      )
    }
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /** Adopt what the spool loaded from disk and start the delivery loop. */
  start(): void {
    for (const entry of this.options.spool.entries()) {
      if (!this.pending.has(entry.runId)) {
        this.pending.set(entry.runId, { entry, attempts: 0, nextAttemptAtMs: this.now() })
      }
    }
    if (!this.loop) this.loop = this.run()
  }

  /** Persist then queue a batch. Returns false when it could not be kept. */
  async enqueue(batch: ObservationBatch): Promise<boolean> {
    const body = JSON.stringify(batch)
    const entry = await this.options.spool.add({
      runId: batch.runId,
      scheduledAtMs: Date.parse(batch.scheduledAt),
      body,
    })
    if (!entry || !this.options.spool.has(entry.runId)) return false
    if (!this.pending.has(entry.runId)) {
      this.pending.set(entry.runId, { entry, attempts: 0, nextAttemptAtMs: this.now() })
    }
    this.wake?.()
    return true
  }

  /** Stop retrying and abort an in-flight POST. Spooled entries stay on disk. */
  async stop(): Promise<void> {
    this.stopped = true
    this.stopController.abort()
    this.wake?.()
    await this.loop
  }

  /** Deliver every due entry once (exposed for tests and the loop). */
  async drainDue(): Promise<void> {
    await this.options.spool.expire()
    const now = this.now()
    const due = [...this.pending.values()]
      .filter((item) => item.nextAttemptAtMs <= now)
      .sort((a, b) => a.entry.scheduledAtMs - b.entry.scheduledAtMs)
    for (const item of due) {
      if (this.stopped) return
      if (!this.pending.has(item.entry.runId)) continue
      await this.attempt(item)
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.drainDue()
      } catch (error) {
        // Disk trouble must not kill delivery; log and keep going.
        this.options.logger.error("ingest_loop_error", {
          error: error instanceof Error ? error.name : "unknown",
        })
      }
      if (this.stopped) break
      const next = Math.min(...[...this.pending.values()].map((item) => item.nextAttemptAtMs))
      const delay = Number.isFinite(next) ? Math.max(50, next - this.now()) : 60_000
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, delay)
        timer.unref?.()
        this.wake = done
        function done() {
          clearTimeout(timer)
          resolve()
        }
      })
      this.wake = null
    }
  }

  private async attempt(item: Pending): Promise<void> {
    const { entry } = item
    const body = this.encoder.encode(entry.body)
    item.attempts += 1
    if (item.attempts > 1) this.stats.retries += 1
    let status: number
    let retryAfter: string | null = null
    try {
      const headers = await signProbeRequest({
        keyId: this.options.keyId,
        secret: this.options.secret,
        method: "POST",
        path: this.path,
        runId: entry.runId,
        body,
        nowMs: this.now(),
      })
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.any([
          this.stopController.signal,
          AbortSignal.timeout(this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
        ]),
      })
      status = response.status
      retryAfter = response.headers.get("retry-after")
      await this.readResponse(response, entry, status)
    } catch {
      if (this.stopped) return
      this.scheduleRetry(item, null, "network")
      return
    }
    if (status >= 200 && status < 300) {
      this.firstFailureAtMs = null
      await this.options.spool.remove(entry.runId)
      this.pending.delete(entry.runId)
      return
    }
    if (status === 409) {
      this.stats.conflicts += 1
      this.options.logger.error("ingest_conflict", { runId: entry.runId, status })
      await this.drop(entry)
      return
    }
    if (status === 408 || status === 429) {
      this.scheduleRetry(item, retryAfterMs(retryAfter, this.now()), `http_${status}`)
      return
    }
    if (status >= 400 && status < 500) {
      this.stats.rejected += 1
      this.options.logger.error("ingest_rejected", { runId: entry.runId, status })
      await this.drop(entry)
      this.noteFailure()
      void this.options.alerts.raise(
        "ingestion_rejected",
        `status API rejected an observation batch with HTTP ${status}`,
        {
          status,
        }
      )
      return
    }
    this.scheduleRetry(item, null, `http_${status}`)
  }

  private async readResponse(response: Response, entry: SpoolEntry, status: number): Promise<void> {
    // Only the success shape is interesting; error bodies are not logged.
    if (status < 200 || status >= 300) {
      await response.body?.cancel().catch(() => undefined)
      return
    }
    const text = await response.text().catch(() => "")
    let outcome = "accepted"
    if (text.length <= MAX_RESPONSE_BYTES) {
      try {
        const parsed = JSON.parse(text) as { status?: unknown }
        if (parsed.status === "duplicate") outcome = "duplicate"
      } catch {
        // A 2xx without the documented body is still a definitive acceptance.
      }
    }
    if (outcome === "duplicate") this.stats.duplicates += 1
    else this.stats.accepted += 1
    this.options.logger.info("ingest_ok", { runId: entry.runId, status, outcome })
  }

  private async drop(entry: SpoolEntry): Promise<void> {
    await this.options.spool.remove(entry.runId)
    this.pending.delete(entry.runId)
  }

  private noteFailure(): void {
    const now = this.now()
    this.firstFailureAtMs ??= now
    if (now - this.firstFailureAtMs > INGEST_FAILING_ALERT_MS) {
      void this.options.alerts.raise(
        "ingestion_failing",
        "observation ingestion has been failing for over 3 minutes",
        {
          pending: this.pending.size,
        }
      )
    }
  }

  private scheduleRetry(item: Pending, minDelayMs: number | null, cause: string): void {
    const delay = Math.max(backoffDelay(item.attempts, this.backoff, this.random), minDelayMs ?? 0)
    item.nextAttemptAtMs = this.now() + delay
    this.options.logger.warn("ingest_retry", {
      runId: item.entry.runId,
      attempt: item.attempts,
      cause,
      delayMs: delay,
    })
    this.noteFailure()
  }
}
