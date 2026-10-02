/**
 * The long-running `run` command: scheduler → probe run → batch → spool →
 * signed ingestion, plus self-alerting and an optional co-hosted mirror.
 */

import type { CheckObservation } from "../../../../../lib/status/contract"

import { buildObservationBatch, newRunId, runProbeChecks, type ProbeTransport } from "../core"
import { AlertSink } from "./alerts"
import type { ProbeConfig, ProfileConfig } from "./config"
import type { FetchLike } from "./http"
import { IngestionQueue, type BackoffPolicy } from "./ingest"
import type { Logger } from "./logger"
import { runMonitoringChecks } from "./monitoring"
import { MinuteScheduler, type DueChecks } from "./scheduler"
import { Spool } from "./spool"

/** Consecutive failing statusApi minutes before the operator is alerted. */
export const STATUS_API_ALERT_AFTER = 3
/** How long shutdown waits for aborted runs to finish their cleanup. */
const SHUTDOWN_GRACE_MS = 5_000

export interface ProbeRunnerDeps {
  config: ProbeConfig
  secret: Uint8Array
  transport: ProbeTransport
  logger: Logger
  fetchImpl?: FetchLike
  now?: () => number
  backoff?: BackoffPolicy
  userAgent?: string
}

export class ProbeRunner {
  readonly spool: Spool
  readonly ingestion: IngestionQueue
  readonly alerts: AlertSink
  readonly scheduler: MinuteScheduler
  private readonly shutdown = new AbortController()
  private statusApiFailures = 0
  private readonly now: () => number

  constructor(private readonly deps: ProbeRunnerDeps) {
    const { config, logger } = deps
    this.now = deps.now ?? Date.now
    this.alerts = new AlertSink({
      webhook: config.alertWebhook,
      probeId: config.probeId,
      logger,
      fetchImpl: deps.fetchImpl,
      now: this.now,
    })
    // The queue is created right below; the closure only runs later.
    this.spool = new Spool(config.spoolDir, {
      now: this.now,
      onLoss: (entry, reason) => this.ingestion.recordLoss(entry, reason),
    })
    this.ingestion = new IngestionQueue({
      apiBase: config.apiBase,
      keyId: config.keyId,
      secret: deps.secret,
      spool: this.spool,
      logger,
      alerts: this.alerts,
      fetchImpl: deps.fetchImpl,
      now: this.now,
      backoff: deps.backoff,
    })
    this.scheduler = new MinuteScheduler({
      profiles: config.profiles,
      now: this.now,
      onRun: (profile, scheduledAtMs, due) => this.runOnce(profile, scheduledAtMs, due),
      onSkip: (profile, scheduledAtMs) =>
        logger.warn("observer_gap", {
          profileId: profile.id,
          scheduledAt: new Date(scheduledAtMs).toISOString(),
          reason: "overlap_skipped",
        }),
      onMissed: (fromMs, count) =>
        logger.warn("observer_gap", {
          scheduledAt: new Date(fromMs).toISOString(),
          missedMinutes: count,
          reason: "missing",
        }),
    })
  }

  async start(): Promise<void> {
    const recovered = await this.spool.init()
    this.deps.logger.info("probe_start", {
      probeId: this.deps.config.probeId,
      profiles: this.deps.config.profiles.map((profile) => profile.id).join(","),
      recoveredBatches: recovered.length,
    })
    this.ingestion.start()
    this.scheduler.start()
  }

  /** SIGTERM/SIGINT: stop scheduling, abort runs, keep pending batches spooled. */
  async stop(): Promise<void> {
    this.scheduler.stop()
    this.shutdown.abort()
    await Promise.race([
      this.scheduler.idle(),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref()),
    ])
    await this.ingestion.stop()
    this.deps.logger.info("probe_stop", {
      pendingBatches: this.spool.entries().length,
      lost: this.ingestion.stats.lost,
    })
  }

  /** One scheduled run for one profile (exposed for tests). */
  async runOnce(profile: ProfileConfig, scheduledAtMs: number, due: DueChecks): Promise<void> {
    const { config, logger } = this.deps
    const signal = this.shutdown.signal
    if (signal.aborted) return
    const runId = newRunId(this.now())
    const includeMonitoring = profile.id === "native"
    let result
    let extraChecks: CheckObservation[] = []
    try {
      ;[result, extraChecks] = await Promise.all([
        runProbeChecks({
          signalingUrl: config.signalingUrl,
          profile: { id: profile.id, origin: profile.origin },
          runHttp: due.runHttp,
          runProtocol: due.runProtocol,
          transport: this.deps.transport,
          now: this.now,
          signal,
        }),
        includeMonitoring
          ? runMonitoringChecks({
              statusPageUrl: config.statusPageUrl,
              apiBase: config.apiBase,
              signal,
              fetchImpl: this.deps.fetchImpl,
              now: this.now,
              userAgent: this.deps.userAgent,
            })
          : Promise.resolve([] as CheckObservation[]),
      ])
    } catch {
      logger.error("run_failed", { profileId: profile.id, runId })
      return
    }
    if (result.aborted || signal.aborted) {
      // Shutdown interrupted the run: an observer gap, not evidence.
      logger.warn("observer_gap", {
        profileId: profile.id,
        runId,
        scheduledAt: new Date(scheduledAtMs).toISOString(),
        reason: "aborted",
      })
      return
    }
    let batch
    try {
      batch = buildObservationBatch({
        probeId: config.probeId,
        runId,
        registryRevision: config.registryRevision,
        scheduledAtMs,
        profileId: profile.id,
        result,
        extraChecks,
      })
    } catch {
      // A body our own validator rejects is a runner bug; never send it.
      logger.error("batch_invalid", { profileId: profile.id, runId })
      return
    }
    logger.info("run_complete", {
      profileId: profile.id,
      runId,
      scheduledAt: batch.scheduledAt,
      durationMs: result.finishedAtMs - result.startedAtMs,
      checks: batch.checks
        .map((check) => `${check.checkId}=${check.result}${check.reason ? `:${check.reason}` : ""}`)
        .join(","),
    })
    if (includeMonitoring) await this.trackStatusApi(extraChecks)
    const kept = await this.ingestion.enqueue(batch)
    if (!kept) logger.warn("observer_loss", { runId, reason: "not_spooled" })
  }

  private async trackStatusApi(checks: CheckObservation[]): Promise<void> {
    const api = checks.find((check) => check.checkId === "statusApi")
    if (!api) return
    if (api.result === "pass") {
      this.statusApiFailures = 0
      return
    }
    this.statusApiFailures += 1
    if (this.statusApiFailures >= STATUS_API_ALERT_AFTER) {
      await this.alerts.raise(
        "status_api_failing",
        "primary status API failed 3 consecutive minutes",
        {
          reason: api.reason ?? "unknown",
          consecutive: this.statusApiFailures,
        }
      )
    }
  }
}
