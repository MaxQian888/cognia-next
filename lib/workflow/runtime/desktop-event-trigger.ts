/**
 * `trigger.desktop.event` fan-out — bridges the Rust automation backend's
 * native Windows UIA focus/structure/property events (`automation:uia-event`) to
 * subscribed workflows.
 *
 * Lifecycle: `initDesktopEventTrigger()` (mounted by
 * `WorkflowRuntimeProvider`, Tauri-only) opens a Dexie liveQuery over the
 * `workflows` table; active nodes are grouped by their exact `{kinds, scope}`
 * filter and each distinct group owns one backend subscription. Incoming
 * subscription ids route events back to only the trigger nodes in that group.
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

import Dexie, { type Subscription } from "dexie"

import { getDb } from "@/lib/db/schema"
import { elementRef, type EventFilter, type EventKind } from "@/lib/automation/types"
import { loggers } from "@cognia/logging"
import type { WorkflowRow } from "@/types/workflow/visual"

const log = loggers.scheduler

const DEFAULT_COOLDOWN_MS = 2_000

export interface DesktopEventTriggerDeps {
  /** Subscribe the backend watcher; resolves the subscription id. */
  subscribe?: (filter: EventFilter) => Promise<number>
  /** Release a backend subscription. */
  unsubscribe?: (sub: number) => Promise<void>
  /** Listen for `automation:uia-event`; resolves the unlisten fn. */
  listen?: (handler: (payload: DesktopUiaEvent) => void) => Promise<() => void>
  /** Injectable clock for the cooldown gate. */
  now?: () => number
}

export interface DesktopUiaEvent {
  subscriptionId?: number
  kind: string
  name?: string
  controlType?: string
  processId?: number
  property?: string
  structureChangeType?: string
  runtimeId?: number[]
  at: number
}

interface BackendSubscription {
  id: number
  nodeIds: Set<string>
}

interface RunnerState {
  workflowsSub?: Subscription
  uiaUnlisten?: (() => void) | null
  backendSubs: Map<string, BackendSubscription>
  subscriptionsById: Map<number, BackendSubscription>
  reconcileChain: Promise<void>
  /** Per-workflow last-fire timestamps (cooldown gate). */
  lastFired: Map<string, number>
  /** Workflows with an in-flight run started by this trigger. */
  inflight: Set<string>
  deps: Required<DesktopEventTriggerDeps>
  active: boolean
}

let state: RunnerState | null = null

async function defaultSubscribe(filter: EventFilter): Promise<number> {
  const { desktop } = await import("@/lib/automation/client")
  return desktop.subscribeEvents(filter)
}

async function defaultUnsubscribe(sub: number): Promise<void> {
  const { desktop } = await import("@/lib/automation/client")
  await desktop.unsubscribeEvents(sub)
}

async function defaultListen(handler: (payload: DesktopUiaEvent) => void): Promise<() => void> {
  const { listenUiaEvents } = await import("@/lib/automation/client")
  return listenUiaEvents(handler)
}

const ALL_EVENT_KINDS: EventKind[] = ["focus-changed", "structure-changed", "property-changed"]

interface DesiredBackendSubscription {
  filter: EventFilter
  nodeIds: Set<string>
}

function desiredSubscriptions(rows: WorkflowRow[]): Map<string, DesiredBackendSubscription> {
  const desired = new Map<string, DesiredBackendSubscription>()
  for (const workflow of rows) {
    if (workflow.isTemplate || workflow.isBuiltIn) continue
    for (const node of workflow.nodes) {
      if (node.type !== "trigger.desktop.event" || node.data.disabled) continue
      const rawKinds = Array.isArray(node.data.params.kinds)
        ? node.data.params.kinds.filter((kind): kind is EventKind =>
            ALL_EVENT_KINDS.includes(kind as EventKind)
          )
        : []
      const kinds = [...new Set(rawKinds.length > 0 ? rawKinds : ALL_EVENT_KINDS)].sort()
      const rawScope = node.data.params.scope
      const scopeValue =
        typeof rawScope === "string"
          ? rawScope
          : Array.isArray(rawScope) && typeof rawScope[0] === "string"
            ? rawScope[0]
            : undefined
      const key = JSON.stringify({ kinds, scope: scopeValue ?? null })
      const existing = desired.get(key)
      if (existing) {
        existing.nodeIds.add(node.id)
      } else {
        desired.set(key, {
          filter: { kinds, ...(scopeValue ? { scope: elementRef(scopeValue) } : {}) },
          nodeIds: new Set([node.id]),
        })
      }
    }
  }
  return desired
}

async function reconcileNow(s: RunnerState, rows: WorkflowRow[]): Promise<void> {
  if (!s.active || state !== s) return
  const desired = desiredSubscriptions(rows)

  for (const [key, current] of [...s.backendSubs]) {
    if (desired.has(key)) continue
    s.backendSubs.delete(key)
    s.subscriptionsById.delete(current.id)
    await s.deps.unsubscribe(current.id).catch(() => undefined)
  }

  if (desired.size > 0 && !s.uiaUnlisten) {
    s.uiaUnlisten = await s.deps.listen((payload) => void onUiaEvent(payload))
  }

  for (const [key, wanted] of desired) {
    const current = s.backendSubs.get(key)
    if (current) {
      current.nodeIds = wanted.nodeIds
      continue
    }
    try {
      const id = await s.deps.subscribe(wanted.filter)
      if (!s.active || state !== s) {
        await s.deps.unsubscribe(id).catch(() => undefined)
        return
      }
      const registered = { id, nodeIds: wanted.nodeIds }
      s.backendSubs.set(key, registered)
      s.subscriptionsById.set(id, registered)
      log.info?.("desktop-event-trigger: backend subscription active", {
        id,
        filter: wanted.filter,
      })
    } catch (err) {
      log.warn?.("desktop-event-trigger: subscribe failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (desired.size === 0 && s.uiaUnlisten) {
    s.uiaUnlisten()
    s.uiaUnlisten = null
  }
}

function queueReconcile(rows: WorkflowRow[]): void {
  const s = state
  if (!s) return
  s.reconcileChain = s.reconcileChain
    .then(() => reconcileNow(s, rows))
    .catch((err) =>
      log.warn?.("desktop-event-trigger: reconcile failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    )
}

async function onUiaEvent(payload: DesktopUiaEvent): Promise<void> {
  const s = state
  if (!s || !s.active) return
  try {
    const [{ dispatchTrigger }, { findMatchingWorkflows }, { hasNoLeakingPii }] = await Promise.all(
      [import("./trigger-bridge"), import("./trigger-subscriptions"), import("@cognia/redact")]
    )
    const routedNodeIds =
      payload.subscriptionId === undefined
        ? undefined
        : s.subscriptionsById.get(payload.subscriptionId)?.nodeIds
    if (payload.subscriptionId !== undefined && !routedNodeIds) return
    const matches = findMatchingWorkflows("trigger.desktop.event", {
      desktopEventKind: payload.kind,
    }).filter((match) => !routedNodeIds || routedNodeIds.has(match.nodeId))
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
            triggerId: match.nodeId,
            payload: {
              kind: payload.kind,
              ...(safeName ? { name: safeName } : {}),
              ...(payload.controlType ? { controlType: payload.controlType } : {}),
              ...(payload.processId !== undefined ? { processId: payload.processId } : {}),
              ...(payload.property ? { property: payload.property } : {}),
              ...(payload.structureChangeType
                ? { structureChangeType: payload.structureChangeType }
                : {}),
              ...(payload.runtimeId ? { runtimeId: payload.runtimeId } : {}),
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
    backendSubs: new Map(),
    subscriptionsById: new Map(),
    reconcileChain: Promise.resolve(),
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
      .then((rows) => queueReconcile(rows))
      .catch(() => undefined)
    // `Dexie.liveQuery`, not a named `liveQuery` import. Dexie's CJS build (what
    // Jest resolves) defines `liveQuery` as a NON-ENUMERABLE property of
    // `module.exports` and sets no `__esModule` marker. Importing the `Dexie`
    // default alongside it, as this module now does, routes the module through
    // SWC's `_interop_require_wildcard`, which copies enumerable keys only, so a
    // named `liveQuery` binding would silently be `undefined`. The static is the
    // same function (`Dexie.liveQuery === liveQuery` under real ESM) and is
    // correct through either path.
    const observable = Dexie.liveQuery(() => getDb().workflows.toArray())
    s.workflowsSub = observable.subscribe({
      next: (rows) => {
        queueReconcile(rows)
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
  for (const subscription of s.backendSubs.values()) {
    void s.deps.unsubscribe(subscription.id).catch(() => undefined)
  }
  s.backendSubs.clear()
  s.subscriptionsById.clear()
}

/** Test-only — drive one event through the runner without a Tauri bridge. */
export async function _injectUiaEventForTest(payload: {
  subscriptionId?: number
  kind: string
  name?: string
  controlType?: string
  processId?: number
  property?: string
  structureChangeType?: string
  runtimeId?: number[]
  at: number
}): Promise<void> {
  await onUiaEvent(payload)
}
