/**
 * `trigger.desktop.event` fan-out — bridges the Rust automation backend's
 * live UI events (v1: Windows focus-changed, `automation:uia-event`) to
 * subscribed workflows.
 *
 * Lifecycle: `initDesktopEventTrigger()` (mounted by
 * `WorkflowRuntimeProvider`, Tauri-only) opens a Dexie liveQuery over the
 * `workflows` table; while ≥1 workflow carries a `trigger.desktop.event`
 * node, ONE backend subscription is held (v1 only emits focus-changed, so
 * one covers everything); when the last node disappears the subscription is
 * released. Per-workflow kind filters are applied at match time via the
 * shared trigger-subscription cache.
 *
 * Safety gates:
 *  1. **PII red-line** — the focused element's `name` may carry user text
 *     (document titles, form contents); it is forwarded only when
 *     `hasNoLeakingPii` passes, else omitted.
 *  2. **Loop guard** — a workflow's own desktop actions (windowFocus /
 *     launchApp) cause focus events. Per-workflow `cooldownMs` (param,
 *     default 2000) plus an in-flight guard (skip while a run this trigger
 *     started is still executing) keep a workflow from re-triggering itself.
 *
 * Best-effort and never throws into the provider — a bridge failure only
 * means desktop-event workflows don't fire (logged once).
 */

import { liveQuery, type Subscription } from "dexie"

import { getDb } from "@/lib/db/schema"
import { loggers } from "@cognia/logging"
import type { WorkflowRow } from "@/types/workflow/visual"

const log = loggers.scheduler

const DEFAULT_COOLDOWN_MS = 2_000

export interface DesktopEventTriggerDeps {
  /** Subscribe the backend watcher; resolves the subscription id. */
  subscribe?: () => Promise<number>
  /** Release a backend subscription. */
  unsubscribe?: (sub: number) => Promise<void>
  /** Listen for `automation:uia-event`; resolves the unlisten fn. */
  listen?: (
    handler: (payload: { kind: string; name?: string; at: number }) => void
  ) => Promise<() => void>
  /** Injectable clock for the cooldown gate. */
  now?: () => number
}

interface RunnerState {
  workflowsSub?: Subscription
  uiaUnlisten?: (() => void) | null
  backendSub?: number | null
  /** Per-workflow last-fire timestamps (cooldown gate). */
  lastFired: Map<string, number>
  /** Workflows with an in-flight run started by this trigger. */
  inflight: Set<string>
  deps: Required<DesktopEventTriggerDeps>
  active: boolean
}

let state: RunnerState | null = null

async function defaultSubscribe(): Promise<number> {
  const { desktop } = await import("@/lib/automation/client")
  return desktop.subscribeEvents({ kinds: ["focus-changed"] })
}

async function defaultUnsubscribe(sub: number): Promise<void> {
  const { desktop } = await import("@/lib/automation/client")
  await desktop.unsubscribeEvents(sub)
}

async function defaultListen(
  handler: (payload: { kind: string; name?: string; at: number }) => void
): Promise<() => void> {
  const { listenUiaEvents } = await import("@/lib/automation/client")
  return listenUiaEvents(handler)
}

function hasDesktopEventNodes(rows: WorkflowRow[]): boolean {
  return rows.some((wf) => wf.nodes.some((n) => n.type === "trigger.desktop.event"))
}

/** Ensure/release the single backend subscription to match the node count. */
async function reconcile(wanted: boolean): Promise<void> {
  const s = state
  if (!s) return
  if (wanted && s.backendSub == null) {
    try {
      const sub = await s.deps.subscribe()
      // The runner may have been disposed while awaiting.
      if (!state || state !== s || !s.active) {
        await s.deps.unsubscribe(sub).catch(() => undefined)
        return
      }
      s.backendSub = sub
      s.uiaUnlisten = await s.deps.listen((payload) => void onUiaEvent(payload))
      log.info?.("desktop-event-trigger: backend subscription active", { sub })
    } catch (err) {
      // Backend unavailable (non-Windows / automation off) — log once and
      // leave backendSub null; a later workflow save retries.
      log.warn?.("desktop-event-trigger: subscribe failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } else if (!wanted && s.backendSub != null) {
    const sub = s.backendSub
    s.backendSub = null
    s.uiaUnlisten?.()
    s.uiaUnlisten = null
    await s.deps.unsubscribe(sub).catch(() => undefined)
  }
}

async function onUiaEvent(payload: { kind: string; name?: string; at: number }): Promise<void> {
  const s = state
  if (!s || !s.active) return
  try {
    const [{ dispatchTrigger }, { findMatchingWorkflows }, { hasNoLeakingPii }] = await Promise.all(
      [import("./trigger-bridge"), import("./trigger-subscriptions"), import("@cognia/redact")]
    )
    const matches = findMatchingWorkflows("trigger.desktop.event", {
      desktopEventKind: payload.kind,
    })
    if (matches.length === 0) return

    // PII red-line: element names carry user text (titles, form contents).
    const safeName = payload.name && hasNoLeakingPii(payload.name) ? payload.name : undefined
    const now = s.deps.now()

    await Promise.all(
      matches.map(async (match) => {
        // Loop guard 1 — a run this trigger started is still executing.
        if (s.inflight.has(match.workflowId)) return
        // Loop guard 2 — per-workflow cooldown.
        const cooldown =
          typeof match.params.cooldownMs === "number"
            ? match.params.cooldownMs
            : DEFAULT_COOLDOWN_MS
        const last = s.lastFired.get(match.workflowId) ?? 0
        if (now - last < cooldown) return
        s.lastFired.set(match.workflowId, now)
        s.inflight.add(match.workflowId)
        try {
          await dispatchTrigger({
            workflowId: match.workflowId,
            kind: "trigger.desktop.event",
            payload: {
              kind: payload.kind,
              ...(safeName ? { name: safeName } : {}),
              at: payload.at,
            },
            originAt: now,
          })
        } catch {
          // Per-match isolation — one bad workflow can't block the others.
        } finally {
          s.inflight.delete(match.workflowId)
        }
      })
    )
  } catch {
    // Workflow runtime unavailable — best-effort.
  }
}

/**
 * Open the liveQuery + (lazily) the backend subscription. Idempotent —
 * calling twice disposes the previous runner first.
 */
export function initDesktopEventTrigger(deps: DesktopEventTriggerDeps = {}): void {
  if (typeof window === "undefined") return
  disposeDesktopEventTrigger()
  const s: RunnerState = {
    lastFired: new Map(),
    inflight: new Set(),
    active: true,
    deps: {
      subscribe: deps.subscribe ?? defaultSubscribe,
      unsubscribe: deps.unsubscribe ?? defaultUnsubscribe,
      listen: deps.listen ?? defaultListen,
      now: deps.now ?? Date.now,
    },
  }
  state = s
  try {
    // Deterministic initial reconcile (liveQuery's first emission is
    // scheduler-dependent); reconcile is idempotent, so the liveQuery's own
    // initial emission is a harmless no-op afterwards.
    void getDb()
      .workflows.toArray()
      .then((rows) => reconcile(hasDesktopEventNodes(rows)))
      .catch(() => undefined)
    const observable = liveQuery(() => getDb().workflows.toArray())
    s.workflowsSub = observable.subscribe({
      next: (rows) => {
        void reconcile(hasDesktopEventNodes(rows))
      },
      error: (err) => {
        log.warn?.("desktop-event-trigger: liveQuery error", {
          error: err instanceof Error ? err.message : String(err),
        })
      },
    })
  } catch (err) {
    log.warn?.("desktop-event-trigger: subscribe failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Tear the runner down (unlisten + release the backend subscription). */
export function disposeDesktopEventTrigger(): void {
  const s = state
  if (!s) return
  s.active = false
  state = null
  try {
    s.workflowsSub?.unsubscribe()
  } catch {
    // best-effort
  }
  s.uiaUnlisten?.()
  s.uiaUnlisten = null
  if (s.backendSub != null) {
    const sub = s.backendSub
    s.backendSub = null
    void s.deps.unsubscribe(sub).catch(() => undefined)
  }
}

/** Test-only — drive one event through the runner without a Tauri bridge. */
export async function _injectUiaEventForTest(payload: {
  kind: string
  name?: string
  at: number
}): Promise<void> {
  await onUiaEvent(payload)
}
