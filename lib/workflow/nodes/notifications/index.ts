/**
 * Notification-centre action nodes: `action.notify.{send,list,resolve}`
 * (ADR-0042).
 *
 * Three notification paths already existed and none of them is this one:
 *
 *  - `action.mobile.notify` is a hub-side proxy. It picks one paired device
 *    with `push-display` and dispatches through the remote-step broker, so it
 *    is addressed at a phone and leaves no centre row behind.
 *  - `approval-notify.ts` / `human-input-notify.ts` are blocking gates. Their
 *    notifications carry registered commands and a waitpoint, and the run stops
 *    until a human answers.
 *  - This is neither: a durable row on the executing Host, fanned out by the
 *    user's own preferences, that nothing waits for.
 *
 * Built on `notify()` from `lib/notifications/runtime.ts`, the single entry
 * point, exactly as `approval-notify.ts` does. NOT on
 * `createNotificationCenterAPI`, which is a per-plugin in-memory Map plus a
 * toast dispatcher that `lib/notifications/plugin-bridge.ts` forwards into the
 * real `notify()` anyway.
 *
 * No `requires`. Declaring `["push-display"]` would fail the run at t=0 on the
 * cloud brain, and the brain is precisely where the durable row matters most:
 * its `toast` and `push` both collapse into the events-plane broadcast that
 * connected companions ingest into their own centres, where local preferences
 * and DND still apply. What actually happened is reported as `deliveredVia`
 * instead of predicted by a capability.
 */

import {
  getBadgeCounts,
  getNotification,
  listNotifications,
  patchNotification,
  type NotificationListFilter,
} from "@/lib/db/notifications"
import { notify } from "@/lib/notifications/runtime"
import { cascadeReadState } from "@/lib/notifications/read-state"
import { snoozeUntil } from "@/lib/notifications/snooze"
import type {
  NotificationLevel,
  NotificationReadState,
  NotificationSource,
} from "@/types/notifications"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { registerNodeExecutor } from "../registry"
import { nonRetryable } from "../shared/executor-support"

const LEVELS: readonly NotificationLevel[] = ["info", "success", "warning", "error", "critical"]
const READ_STATES: readonly NotificationReadState[] = ["unseen", "seen", "read", "done"]

function params(ctx: StepExecutionContext): Record<string, unknown> {
  return ctx.params as Record<string, unknown>
}

function str(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key]
  if (typeof v !== "string") return undefined
  const t = v.trim()
  return t.length > 0 ? t : undefined
}

function bool(p: Record<string, unknown>, key: string): boolean | undefined {
  return typeof p[key] === "boolean" ? (p[key] as boolean) : undefined
}

function int(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key]
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined
}

registerNodeExecutor({
  kind: "action.notify.send",
  typeVersion: 1,
  // A retry would raise a second notification for one event. The dedupe key
  // below makes that a bump rather than a duplicate, but not raising it twice
  // is better than coalescing it twice.
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const title = str(p, "title")
    if (!title) throw nonRetryable("action.notify.send requires 'title'")

    const rawLevel = str(p, "level")
    const level: NotificationLevel =
      rawLevel && (LEVELS as readonly string[]).includes(rawLevel)
        ? (rawLevel as NotificationLevel)
        : "info"

    // `actions` is deliberately not authorable. `NotificationAction.command` is
    // resolved at click time through `lib/notifications/action-registry.ts`,
    // and an unregistered command logs a warning and does nothing, so an
    // authored button would be a button that does not work. A flow that needs
    // a decision has `action.approval.request`, which owns a registered
    // command and a waitpoint.
    const id = await notify({
      source: "workflow",
      level,
      title,
      body: str(p, "body"),
      href: str(p, "href"),
      icon: str(p, "icon"),
      directed: bool(p, "directed") ?? false,
      groupKey: str(p, "groupKey") ?? ctx.workflowId,
      // A retry of the same step is the same event. Coalescing on the step
      // bumps the existing row's count instead of stacking duplicates.
      dedupeKey: str(p, "dedupeKey") ?? `${ctx.runId}:${ctx.stepId}`,
      ttlMs: int(p, "ttlMs"),
      // ADR-0144 attribution: a notification that cannot name its workspace
      // makes the user click through to find out which one it came from.
      projectId: ctx.projectId,
      sourceRef: { kind: "workflow-run", id: ctx.runId },
    })

    const record = await getNotification(id)
    return {
      output: {
        notificationId: id,
        title,
        level,
        // What the fan-out actually did, rather than what a capability
        // predicted it would do.
        deliveredVia: record?.deliveredVia ?? [],
        count: record?.count ?? 1,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.notify.list",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const now = Date.now()
    const filter: NotificationListFilter = {}

    const source = str(p, "source")
    if (source) filter.source = source as NotificationSource
    const readStates = Array.isArray(p.readStates)
      ? (p.readStates as unknown[]).filter(
          (s): s is NotificationReadState =>
            typeof s === "string" && (READ_STATES as readonly string[]).includes(s)
        )
      : undefined
    if (readStates && readStates.length > 0) filter.readStates = readStates
    const includeDone = bool(p, "includeDone")
    if (includeDone !== undefined) filter.includeDone = includeDone
    if (bool(p, "hideSnoozed") ?? true) filter.hideSnoozedAfter = now
    filter.limit = Math.min(Math.max(int(p, "limit") ?? 20, 1), 200)

    const [records, badges] = await Promise.all([listNotifications(filter), getBadgeCounts(now)])
    return {
      output: {
        // Projected rather than passed through: a centre record carries the
        // author's `actions` and the fan-out diagnostics, neither of which
        // means anything to a downstream node.
        notifications: records.map((r) => ({
          id: r.id,
          source: r.source,
          level: r.level,
          title: r.title,
          body: r.body,
          readState: r.readState,
          directed: r.directed,
          groupKey: r.groupKey,
          href: r.href,
          projectId: r.projectId,
          createdAt: r.createdAt,
          count: r.count,
        })),
        notificationCount: records.length,
        ...badges,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.notify.resolve",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const notificationId = str(p, "notificationId")
    if (!notificationId) throw nonRetryable("action.notify.resolve requires 'notificationId'")
    const record = await getNotification(notificationId)
    if (!record) {
      throw nonRetryable(`action.notify.resolve: no notification ${notificationId}`)
    }

    const now = Date.now()
    const snoozeMs = int(p, "snoozeMs")
    if (snoozeMs !== undefined && snoozeMs > 0) {
      const until = snoozeUntil(now, snoozeMs)
      await patchNotification(notificationId, { snoozedUntil: until })
      return { output: { notificationId, snoozedUntil: until, readState: record.readState } }
    }

    const target = str(p, "state") ?? "read"
    if (target === "unseen" || !(READ_STATES as readonly string[]).includes(target)) {
      throw nonRetryable(
        `action.notify.resolve: 'state' must be seen, read or done (the lifecycle only moves forward)`
      )
    }
    // The cascade is what keeps the lifecycle monotonic: read implies seen,
    // done implies both, and a target below the current state is a no-op patch
    // rather than a regression.
    const patch = cascadeReadState(record, target as Exclude<NotificationReadState, "unseen">, now)
    if (Object.keys(patch).length > 0) await patchNotification(notificationId, patch)
    return {
      output: {
        notificationId,
        readState: patch.readState ?? record.readState,
        changed: Object.keys(patch).length > 0,
      },
    }
  },
})
