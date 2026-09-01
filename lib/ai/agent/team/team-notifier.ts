/**
 * Three-channel notification router for agent-team runs.
 *
 * Per ADR-0022 §3.4. Routes notifications by level:
 *   - info:     event-log only
 *   - warn:     event-log + sonner toast
 *   - critical: event-log + sonner toast + Tauri OS notification
 *
 * `suspend()` (called by BudgetGuard onCritical=handoff_to_background) silences
 * toast + OS channels but keeps event-log emissions so the durable run record
 * remains complete.
 *
 * `dedupeKey` (5-minute sliding window) suppresses repeated notifications with
 * the same key — used to coalesce BudgetGuard cross-threshold events and
 * per-teammate quarantine notifications.
 */

import type { ApprovalKey } from "@/lib/runtime/approval-bus"
import { agentTeamExecutionRunId } from "@/lib/execution/agent-team-bridge"

export type TeamNotifyLevel = "info" | "warn" | "critical"

export interface TeamNotifyPayload {
  level: TeamNotifyLevel
  title: string
  body?: string
  runId: string
  teamId: string
  taskId?: string
  /** Only allowed at critical level. UI uses to open the matching gate modal. */
  openApproval?: ApprovalKey
  /** UI navigation target. */
  detailHref?: string
  /** Same key within 5min window → suppressed. */
  dedupeKey?: string
}

export interface TeamNotifier {
  notify(p: TeamNotifyPayload): void
  /** handoff_to_background → toast/OS off, log still fires. */
  suspend(): void
  resume(): void
}

export interface TeamNotifierDeps {
  /**
   * Unified delivery sink (ADR-0042). When provided, the notifier emits ONE
   * call per event and lets the Notification Center core route it to the
   * center/toast/OS channels by level — replacing the separate `toast` /
   * `osNotify` fan-out (which remain as a fallback for tests). The event-log,
   * dedupe, suspend, and `openGate` semantics are unchanged.
   */
  deliver?: (payload: TeamNotifyPayload) => void
  toast?: (msg: string, opts?: { description?: string }) => void
  osNotify?: (opts: { title: string; body?: string }) => Promise<void>
  log?: (level: "info" | "warn" | "error", message: string, payload?: unknown) => Promise<void>
  /**
   * Per ADR-0022 §3.4 — when a critical notification carries `openApproval`,
   * push it into a UI store so the team workspace can render a modal.
   * Optional so tests can omit it.
   */
  openGate?: (gate: {
    key: ApprovalKey
    title: string
    body?: string
    runId: string
    teamId: string
    taskId?: string
  }) => void
  now?: () => number
}

const DEDUPE_WINDOW_MS = 5 * 60 * 1000

export function createTeamNotifier(
  runCtx: { runId: string; teamId: string },
  deps: TeamNotifierDeps = {}
): TeamNotifier {
  const now = deps.now ?? (() => Date.now())
  const dedupeCache = new Map<string, number>()
  let suspended = false

  const isDuplicate = (key: string): boolean => {
    const last = dedupeCache.get(key)
    if (last === undefined) return false
    if (now() - last >= DEDUPE_WINDOW_MS) {
      // Window elapsed — evict so the cache can't grow unbounded over a
      // long-lived run with many distinct dedupe keys (e.g. per-task keys).
      dedupeCache.delete(key)
      return false
    }
    return true
  }

  const recordFire = (key: string): void => {
    dedupeCache.set(key, now())
  }

  const callSafely = (fn: () => void | Promise<void>, label: string): void => {
    try {
      const r = fn()
      if (r && typeof (r as Promise<void>).then === "function") {
        ;(r as Promise<void>).catch((err) => {
          console.warn(`TeamNotifier ${label} rejected:`, err)
        })
      }
    } catch (err) {
      console.warn(`TeamNotifier ${label} threw:`, err)
    }
  }

  return {
    notify: (payload) => {
      // Every Squad notification used to land in the centre unclickable.
      // `detailHref` is declared on the payload and forwarded to `notify({ href })`,
      // and a repo-wide search for the field found exactly two hits: the type
      // and the consumer. Nothing ever set it. A run that says "needs your
      // input" and cannot be opened is worse than one that says nothing.
      //
      // Defaulted here rather than at each of the ten call sites, so a
      // notification added later inherits it. The id convention is
      // `agentTeamExecutionRunId`, imported rather than spelled out: writing
      // the prefix twice is the drift that produced the duplicate run row.
      const p: TeamNotifyPayload = payload.detailHref
        ? payload
        : {
            ...payload,
            detailHref: `/agent-runs?run=${encodeURIComponent(agentTeamExecutionRunId(payload.runId))}`,
          }
      if (p.dedupeKey && isDuplicate(p.dedupeKey)) return
      if (p.dedupeKey) recordFire(p.dedupeKey)

      const logLevel = p.level === "info" ? "info" : p.level === "warn" ? "warn" : "error"

      // event-log always fires (suspend does not gate it)
      if (deps.log) {
        callSafely(
          () =>
            deps.log!(logLevel, p.title, {
              body: p.body,
              ...runCtx,
              taskId: p.taskId,
            }),
          "log"
        )
      }

      if (suspended) return

      // Unified delivery (ADR-0042): one emit per event, the core routes by
      // level. Falls back to the legacy per-channel deps when no `deliver` is
      // wired (tests). `openGate` (HITL modal) fires independently of channel.
      if (deps.deliver) {
        callSafely(() => deps.deliver!(p), "deliver")
      } else {
        if (p.level === "warn" || p.level === "critical") {
          if (deps.toast) {
            callSafely(
              () => deps.toast!(p.title, p.body ? { description: p.body } : undefined),
              "toast"
            )
          }
        }
        if (p.level === "critical" && deps.osNotify) {
          callSafely(() => deps.osNotify!({ title: p.title, body: p.body }), "osNotify")
        }
      }

      if (p.level === "critical" && p.openApproval && deps.openGate) {
        callSafely(
          () =>
            deps.openGate!({
              key: p.openApproval!,
              title: p.title,
              body: p.body,
              runId: p.runId,
              teamId: p.teamId,
              taskId: p.taskId,
            }),
          "openGate"
        )
      }
    },
    suspend: () => {
      suspended = true
    },
    resume: () => {
      suspended = false
    },
  }
}
