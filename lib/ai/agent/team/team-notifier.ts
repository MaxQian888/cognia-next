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
  toast?: (msg: string, opts?: { description?: string }) => void
  osNotify?: (opts: { title: string; body?: string }) => Promise<void>
  log?: (level: "info" | "warn" | "error", message: string, payload?: unknown) => Promise<void>
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
    return now() - last < DEDUPE_WINDOW_MS
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
    notify: (p) => {
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

      if (p.level === "warn" || p.level === "critical") {
        if (deps.toast) {
          callSafely(
            () => deps.toast!(p.title, p.body ? { description: p.body } : undefined),
            "toast"
          )
        }
      }
      if (p.level === "critical") {
        if (deps.osNotify) {
          callSafely(() => deps.osNotify!({ title: p.title, body: p.body }), "osNotify")
        }
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
