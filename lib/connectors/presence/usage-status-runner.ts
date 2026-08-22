/**
 * Usage-presence refresh runner — periodically surfaces the local token-usage
 * snapshot on IM platforms.
 *
 * Two tiers, per-adapter opt-in via `AdapterInstanceRow.presence`:
 *
 *   badge — `adapter.setPresenceStatus()` (Lark 系统状态 patch→close→open
 *           cycle, Slack `users.profile.set`, Discord gateway Custom Status).
 *   card  — a markdown card kept fresh in ONE conversation via the durable
 *           outbound queue: first tick sends it (and best-effort pins it),
 *           later ticks edit in place through `editTargetMessageId` — the
 *           same in-place-refresh contract the workflow progress runner uses.
 *
 * Scheduling rides the existing task scheduler: `installUsagePresenceHandlers()`
 * registers the `connection:presence:refresh` executor (payload
 * `{ adapterId }`); the settings UI creates/updates a recurring task per
 * adapter. No PII gate is needed — the payload is derived numeric aggregates
 * only (tokens / cost / model ids), never message content.
 */

import { registerTaskExecutor } from "@/lib/scheduler/task-scheduler"
import { getDb } from "@/lib/db/schema"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { getBus } from "@/lib/connectors/bus"
import { appendAudit } from "@/lib/connectors/audit"
import {
  effectiveCapabilitiesForRow,
  suppressionFor,
} from "@/lib/connectors/effective-capabilities"
import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import {
  buildUsageCardMarkdown,
  buildUsageStatusSnapshot,
  formatShortStatus,
} from "@/lib/usage/status-snapshot"
import {
  DEFAULT_USAGE_PRESENCE_CONFIG,
  type UsagePresenceConfig,
  type UsagePresenceState,
} from "@/types/connectors/presence"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { OutboundJobRow } from "@/lib/db/connector-types"

export const PRESENCE_REFRESH_TASK_TYPE = "connection:presence:refresh"

export interface PresenceRefreshResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

/** Resolve config with defaults; `undefined` ⇒ feature off. */
export function resolvePresenceConfig(
  raw: UsagePresenceConfig | undefined
): UsagePresenceConfig | null {
  if (!raw?.enabled) return null
  return {
    ...DEFAULT_USAGE_PRESENCE_CONFIG,
    ...raw,
    intervalMinutes: Math.max(1, raw.intervalMinutes ?? 5),
  }
}

/**
 * Run one refresh tick for one adapter. Exported for direct calls (settings
 * "refresh now" button, tests); the scheduler executor is a thin wrapper.
 */
export async function runUsagePresenceRefresh(args: {
  adapterId: string
  now?: number
}): Promise<PresenceRefreshResult> {
  const { adapterId } = args
  const now = args.now ?? Date.now()

  const row = await getAdapterInstance(adapterId)
  if (!row) return { success: false, error: `Adapter ${adapterId} not found` }
  const config = resolvePresenceConfig(row.presence)
  if (!config) return { success: true, output: { skipped: "disabled" } }

  const adapter = getBus().getAdapter(adapterId)
  if (!adapter) {
    return { success: false, error: `Adapter ${adapterId} not running` }
  }

  // Snapshot over the whole billing table — bounded (≤ low thousands of
  // rows, 90-day retention prune) and identical to the usage tab's read.
  const rows: SessionUsageRow[] = await getDb().sessionUsage.toArray()
  const snapshot = buildUsageStatusSnapshot(rows, { window: config.window, now })

  const state: UsagePresenceState = { ...row.presenceState }
  const errors: string[] = []
  /**
   * Errors that are a permanent property of how this bot is configured rather
   * than something that went wrong on this tick. They belong in `lastError`
   * (the operator should see them) but NOT in the audit log, which would
   * otherwise take a new `adapter.error` row every interval, forever, for a
   * condition no retry can change.
   */
  const configurationGaps: string[] = []

  // ── Badge tier ─────────────────────────────────────────────────────────
  if (config.mode === "badge" || config.mode === "both") {
    // A method-presence check is not the same question. A webhook-mode Discord
    // adapter DOES implement `setPresenceStatus` — it just throws "gateway not
    // connected" every time, because presence is a gateway op. Ask what this
    // instance can actually serve.
    const suppression = suppressionFor(effectiveCapabilitiesForRow(row), "presence.status")
    if (suppression) {
      configurationGaps.push(`badge: unavailable (${suppression.reason}: ${suppression.detail})`)
    } else if (typeof adapter.setPresenceStatus === "function") {
      try {
        await adapter.setPresenceStatus({
          text: formatShortStatus(snapshot),
          // Expire shortly after the next expected tick so a stopped runner
          // doesn't leave a stale badge forever.
          expiresAt: now + config.intervalMinutes * 60_000 * 2,
          targetUserIds: config.targetUserIds,
        })
      } catch (err) {
        errors.push(`badge: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      configurationGaps.push("badge: adapter does not implement setPresenceStatus")
    }
  }

  // ── Card tier ──────────────────────────────────────────────────────────
  if ((config.mode === "card" || config.mode === "both") && config.cardConversationKey) {
    try {
      await refreshCard({ adapterId, config, state, snapshot, now })
    } catch (err) {
      errors.push(`card: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  state.lastRefreshAt = now
  const surfaced = [...configurationGaps, ...errors]
  state.lastError = surfaced.length > 0 ? surfaced.join("; ") : undefined
  await updateAdapterInstance(adapterId, { presenceState: state }).catch(() => {})

  if (errors.length > 0) {
    await appendAudit({
      adapterId,
      kind: "adapter.error",
      at: now,
      reason: "presence_refresh_partial",
      message: state.lastError ?? "",
    }).catch(() => {})
  }

  // Partial failure still returns success — the next tick retries; the
  // error detail lives in presenceState.lastError + the audit trail. A
  // configuration gap rides along here because this run genuinely did not do
  // what it was asked to; only the AUDIT is spared the repetition.
  return {
    success: true,
    output: {
      tokens: snapshot.totalTokens,
      costUsd: snapshot.costUsd,
      errors: surfaced.length > 0 ? surfaced : undefined,
    },
  }
}

async function refreshCard(args: {
  adapterId: string
  config: UsagePresenceConfig
  state: UsagePresenceState
  snapshot: ReturnType<typeof buildUsageStatusSnapshot>
  now: number
}): Promise<void> {
  const { adapterId, config, state, snapshot, now } = args
  const conversationKey = config.cardConversationKey!
  const deliveryTarget = (await getConnectorConversationState(conversationKey))?.deliveryTarget
  if (!deliveryTarget || deliveryTarget.address.adapterId !== adapterId) {
    throw new Error("Usage status card has no persisted delivery target")
  }

  // Resolve the card's platform message id from the creating job (the
  // outbound runner records `platformMessageId` on delivery). Mirrors
  // `waitForOutboundTerminal` semantics: follow a rerouted dead-letter to
  // the sibling that actually carries the delivery, and CLEAR `cardJobId`
  // when the job is gone or terminally failed — a dangling pointer at a
  // dead job would otherwise make every subsequent tick send a brand-new,
  // never-tracked card.
  if (!state.cardMessageId && state.cardJobId) {
    let jobId: string | undefined = state.cardJobId
    for (let hop = 0; hop < 3 && jobId; hop++) {
      const job: OutboundJobRow | undefined = await getDb().outboundQueue.get(jobId)
      if (!job || (job.status === "deadlettered" && !job.reroutedToJobId)) {
        // Cancelled or terminally failed: forget it so THIS tick re-creates
        // the card cleanly and tracks the new creating job.
        jobId = undefined
        break
      }
      if (job.platformMessageId) {
        state.cardMessageId = job.platformMessageId
        break
      }
      if (job.status === "deadlettered" && job.reroutedToJobId !== jobId) {
        jobId = job.reroutedToJobId
        continue
      }
      break // pending / failed / sending — keep waiting on this job
    }
    state.cardJobId = jobId
  }

  const segments = [{ type: "markdown" as const, md: buildUsageCardMarkdown(snapshot, { now }) }]

  const job = await enqueueOutbound({
    adapterId,
    conversationKey,
    request: {
      conversationRef: deliveryTarget.conversationRef,
      deliveryTarget,
      segments,
      metadata: { idempotencyKey: `usage-presence:${adapterId}:${now}` },
      ...(state.cardMessageId ? { editTargetMessageId: state.cardMessageId } : {}),
    },
    source: "manual",
  })
  if (!state.cardMessageId && !state.cardJobId) state.cardJobId = job.id

  // Pin once, best-effort, as soon as we know the platform message id.
  if (state.cardMessageId && !state.cardPinned) {
    const adapter = getBus().getAdapter(adapterId)
    if (typeof adapter?.pinMessage === "function") {
      try {
        await adapter.pinMessage(conversationKey, state.cardMessageId)
        state.cardPinned = true
      } catch {
        // Pin is cosmetic; retry next tick.
      }
    }
  }
}

async function handlePresenceRefresh(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<PresenceRefreshResult> {
  if (signal?.aborted) return { success: false, error: "Presence refresh aborted" }
  const payload = (execution.input ?? task.payload) as { adapterId?: unknown } | undefined
  if (!payload || typeof payload.adapterId !== "string") {
    return { success: false, error: "Invalid connection:presence:refresh payload" }
  }
  return runUsagePresenceRefresh({ adapterId: payload.adapterId })
}

/**
 * Register the presence scheduler executor. Safe to call multiple times
 * (registerTaskExecutor overwrites). Installed alongside
 * `installScheduledOutboundHandlers()` in `ConnectorBusProvider`.
 */
export function installUsagePresenceHandlers(): void {
  registerTaskExecutor(PRESENCE_REFRESH_TASK_TYPE, handlePresenceRefresh)
}

/** Stable tag identifying the schedule row owned by one adapter's presence config. */
export function presenceScheduleTag(adapterId: string): string {
  return `usage-presence:${adapterId}`
}

/**
 * Reconcile the recurring scheduler task with the saved presence config —
 * called by the settings form after every save. Enabled ⇒ ensure one
 * interval task exists with the configured cadence; disabled ⇒ delete it.
 * Lazy scheduler import keeps the scheduler graph out of adapter bundles.
 */
export async function syncUsagePresenceSchedule(
  adapterId: string,
  config: UsagePresenceConfig | undefined
): Promise<void> {
  const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
  const scheduler = getTaskScheduler()
  const tag = presenceScheduleTag(adapterId)
  const all = await scheduler.getAllTasks()
  const existing = all.find(
    (t) => t.type === PRESENCE_REFRESH_TASK_TYPE && (t.tags ?? []).includes(tag)
  )
  const resolved = resolvePresenceConfig(config)

  if (!resolved) {
    if (existing) await scheduler.deleteTask(existing.id)
    return
  }

  const intervalMs = resolved.intervalMinutes * 60_000
  if (existing) {
    if (existing.trigger.intervalMs !== intervalMs || existing.status !== "active") {
      await scheduler.updateTask(existing.id, {
        trigger: { type: "interval", intervalMs },
        status: "active",
      })
    }
    return
  }

  await scheduler.createTask({
    name: `Usage presence · ${adapterId}`,
    type: PRESENCE_REFRESH_TASK_TYPE,
    trigger: { type: "interval", intervalMs },
    payload: { adapterId },
    tags: [tag],
  })
}
