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
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { getBus } from "@/lib/connectors/bus"
import { appendAudit } from "@/lib/connectors/audit"
import { parseConversationKey } from "@/types/connectors/event"
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

  // ── Badge tier ─────────────────────────────────────────────────────────
  if (config.mode === "badge" || config.mode === "both") {
    if (typeof adapter.setPresenceStatus === "function") {
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
      errors.push("badge: adapter does not implement setPresenceStatus")
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
  state.lastError = errors.length > 0 ? errors.join("; ") : undefined
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
  // error detail lives in presenceState.lastError + the audit trail.
  return {
    success: true,
    output: {
      tokens: snapshot.totalTokens,
      costUsd: snapshot.costUsd,
      errors: errors.length > 0 ? errors : undefined,
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
  const { platform } = parseConversationKey(conversationKey)

  // Resolve the card's platform message id from the creating job (the
  // outbound runner records `platformMessageId` on delivery).
  if (!state.cardMessageId && state.cardJobId) {
    const job = await getDb().outboundQueue.get(state.cardJobId)
    if (job?.platformMessageId) state.cardMessageId = job.platformMessageId
  }

  const segments = [{ type: "markdown" as const, md: buildUsageCardMarkdown(snapshot, { now }) }]

  const job = await enqueueOutbound({
    adapterId,
    conversationKey,
    request: {
      conversationRef: { platform, adapterId },
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
