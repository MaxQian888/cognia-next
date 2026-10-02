/**
 * The one-minute schedule.
 *
 * 1. Cloudflare Cron observer runs its due profiles (outside any lease: an
 *    observation is immutable and idempotent by run ID).
 * 2. Under the `aggregate` lease: maintenance transitions, dirty rollups,
 *    component evaluation, incident reconciliation, snapshot publication —
 *    in that order, so the published snapshot reflects this minute's
 *    incidents and windows.
 * 3. Under the `delivery` lease: the notification outbox.
 * 4. Hourly, under the `retention` lease: bounded retention of every table.
 *
 * Each step is isolated: a failure is logged and the next step still runs,
 * so a broken mail provider never stops the public snapshot.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS, type ComponentId } from "../../../../lib/status/contract"
import { minuteOf } from "../../../../lib/status/derive"
import { loadRecentEvidence } from "./aggregate/evidence"
import { evaluateComponents } from "./aggregate/evaluate"
import { summarizeProbes } from "./aggregate/probes"
import { mergeExclusions, parseRollup, rebuildDirtyHours, type Rollup } from "./aggregate/rollup"
import { publishSnapshots } from "./aggregate/snapshot"
import type { Env } from "./env"
import { logEvent } from "./platform/http"
import { withLease } from "./platform/lease"
import type { ProbeTransport } from "../../probe/src/core/index"
import { runCloudflareProbe } from "./probe/cron-probe"
import { loadRegistry, observationStartMinute, referenceForMinute } from "./registry/registry"
import { runCoreRetention } from "./retention"
import type {
  IncidentsModule,
  JobContext,
  MaintenanceModule,
  NotificationsModule,
  SubscriptionsModule,
} from "./seams"

export interface CronModules {
  incidents: Pick<IncidentsModule, "reconcileIncidents" | "loadIncidentsForSnapshot">
  maintenance: MaintenanceModule
  notifications: Pick<NotificationsModule, "runDelivery" | "runNotificationRetention">
  subscriptions: Pick<SubscriptionsModule, "emailCapability" | "runSubscriptionRetention">
}

/** Minute of the hour at which retention runs (off the hour boundary). */
export const RETENTION_MINUTE = 17

async function step(name: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    logEvent("cron.step_failed", {
      step: name,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    })
  }
}

async function loadRollups(db: D1Database, nowMs: number) {
  const fromHour = Math.floor((nowMs - 7 * DAY_MS) / HOUR_MS)
  const fromDay = Math.floor(nowMs / DAY_MS) - 90
  const [hourlyRows, dailyRows] = await db.batch([
    db.prepare("SELECT hour, rollup_json FROM hourly_rollups WHERE hour >= ?").bind(fromHour),
    db.prepare("SELECT day, rollup_json FROM daily_rollups WHERE day >= ?").bind(fromDay),
  ])
  const hourly = new Map<number, Rollup>()
  for (const row of (hourlyRows.results ?? []) as Array<{ hour: number; rollup_json: string }>) {
    const parsed = parseRollup(row.rollup_json)
    if (parsed) hourly.set(row.hour, parsed)
  }
  const daily = new Map<number, Rollup>()
  for (const row of (dailyRows.results ?? []) as Array<{ day: number; rollup_json: string }>) {
    const parsed = parseRollup(row.rollup_json)
    if (parsed) daily.set(row.day, parsed)
  }
  return { hourly, daily }
}

/** Aggregate, reconcile and publish. Exported for tests. */
export async function runAggregation(
  job: JobContext,
  modules: CronModules
): Promise<number | null> {
  const { env, nowMs } = job
  const db = env.DB
  await step("maintenance", () => modules.maintenance.advanceMaintenance(job))
  await step("rollups", () => rebuildDirtyHours(job, modules.maintenance))

  const registry = await loadRegistry(db)
  const [evidence, rollups, windows, maintenanceComponents] = await Promise.all([
    loadRecentEvidence(db, nowMs),
    loadRollups(db, nowMs),
    modules.maintenance.loadExclusionWindows(env, nowMs - 91 * DAY_MS, nowMs + MINUTE_MS),
    modules.maintenance.activeMaintenanceComponents(env, nowMs),
  ])
  const probes = await summarizeProbes(db, registry, nowMs, evidence)
  const evaluated = evaluateComponents({
    registry,
    evidence,
    hourly: rollups.hourly,
    maintenanceComponents: maintenanceComponents as ReadonlySet<ComponentId>,
    nowMs,
  })
  const epoch = referenceForMinute(registry, minuteOf(nowMs))
  const referenceSummary = probes.find((probe) => probe.id === epoch?.probeId)
  const lastSlotMinute = Math.max(-1, ...evidence.slots.keys())
  await step("reconcile", () =>
    modules.incidents.reconcileIncidents(job, {
      evaluations: evaluated.map((item) => item.evaluation),
      observer: {
        referenceProbeId: epoch?.probeId ?? null,
        referenceHealthy: referenceSummary?.health === "healthy",
        lastReferenceAtMs: lastSlotMinute < 0 ? null : lastSlotMinute * MINUTE_MS,
      },
    })
  )
  const [incidents, maintenance] = await Promise.all([
    modules.incidents.loadIncidentsForSnapshot(env, nowMs),
    modules.maintenance.loadMaintenanceForSnapshot(env, nowMs),
  ])
  return publishSnapshots(job, {
    nowMs,
    observationStartMinute: observationStartMinute(registry),
    hourly: rollups.hourly,
    daily: rollups.daily,
    exclusions: mergeExclusions(windows),
    evaluated,
    probes,
    incidents,
    maintenance,
    capabilities: {
      email: modules.subscriptions.emailCapability(env),
      feeds: true,
      locales: ["en", "zh-CN"],
      historyRanges: ["24h", "7d", "30d", "90d"],
      mirrorUrl: env.MIRROR_URL ? env.MIRROR_URL : null,
      primaryUrl: env.PUBLIC_PAGE_URL,
    },
  })
}

export async function runScheduled(
  env: Env,
  scheduledTimeMs: number,
  modules: CronModules,
  options: { now?: () => number; transport?: ProbeTransport } = {}
): Promise<void> {
  const now = options.now ?? (() => Date.now())
  await step("cron_probe", async () => {
    const registry = await loadRegistry(env.DB)
    await runCloudflareProbe({ env, registry, scheduledTimeMs, now, transport: options.transport })
  })

  await step("aggregate", () =>
    withLease(env.DB, "aggregate", now(), (lease) =>
      runAggregation({ env, lease, nowMs: now() }, modules)
    )
  )

  await step("delivery", () =>
    withLease(env.DB, "delivery", now(), (lease) =>
      modules.notifications.runDelivery({ env, lease, nowMs: now() })
    )
  )

  if (minuteOf(scheduledTimeMs) % 60 === RETENTION_MINUTE) {
    await step("retention", () =>
      withLease(env.DB, "retention", now(), async (lease) => {
        const job = { env, lease, nowMs: now() }
        const removed = await runCoreRetention(job)
        logEvent("retention.core", removed)
        await modules.subscriptions.runSubscriptionRetention(job)
        await modules.notifications.runNotificationRetention(job)
      })
    )
  }
}
