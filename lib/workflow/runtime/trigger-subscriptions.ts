/**
 * Trigger subscription cache — keeps an in-memory index of every workflow's
 * TS-hook trigger nodes so callers along the chat-send, inbound-bus,
 * terminal-command, and goal-completion paths can route to matching workflows
 * in a single map lookup instead of scanning Dexie on every event.
 *
 * The cache is rebuilt from a Dexie `liveQuery` over the `workflows` table —
 * any save / delete in any tab is reflected in the cache within one tick.
 * `WorkflowRuntimeProvider` calls `initTriggerSubscriptions()` once on app
 * boot; `disposeTriggerSubscriptions()` unwinds the subscription on
 * unmount.
 *
 * The cache is intentionally only used for triggers that ride existing TS
 * hooks. `trigger.cron` and webhook triggers go through the Rust router, so
 * they don't need this lookup table.
 */

import { liveQuery, type Subscription } from "dexie"
import { getDb } from "@/lib/db/schema"
import type { WorkflowNodeKind, WorkflowRow } from "@/types/workflow/visual"
import { loggers } from "@/lib/logging"

const log = loggers.scheduler

export interface SubscribedTrigger {
  workflowId: string
  nodeId: string
  params: Record<string, unknown>
}

/** Kinds we actually index — cron/webhook triggers go through the Rust router. */
const INDEXED_KINDS: readonly WorkflowNodeKind[] = [
  "trigger.connector.inbound",
  "trigger.chat.message",
  "trigger.goal.completed",
  "trigger.terminal.command",
  "trigger.team",
]

interface SubscriptionState {
  byKind: Map<WorkflowNodeKind, SubscribedTrigger[]>
  subscription?: Subscription
}

const state: SubscriptionState = { byKind: new Map() }

function rebuildIndex(rows: WorkflowRow[]): void {
  const next = new Map<WorkflowNodeKind, SubscribedTrigger[]>()
  for (const kind of INDEXED_KINDS) next.set(kind, [])
  for (const wf of rows) {
    for (const node of wf.nodes) {
      if (!INDEXED_KINDS.includes(node.type)) continue
      const params = (node.data?.params ?? {}) as Record<string, unknown>
      next.get(node.type)!.push({
        workflowId: wf.id,
        nodeId: node.id,
        params,
      })
    }
  }
  state.byKind = next
}

/**
 * Open the liveQuery. Idempotent — calling twice closes the previous
 * subscription before opening a new one.
 */
export function initTriggerSubscriptions(): void {
  if (typeof window === "undefined") return
  disposeTriggerSubscriptions()
  try {
    const observable = liveQuery(() => getDb().workflows.toArray())
    state.subscription = observable.subscribe({
      next: (rows) => {
        rebuildIndex(rows)
      },
      error: (err) => {
        log.warn?.("trigger-subscriptions: liveQuery error", {
          error: err instanceof Error ? err.message : String(err),
        })
      },
    })
  } catch (err) {
    log.warn?.("trigger-subscriptions: subscribe failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Close the liveQuery and reset the cache. */
export function disposeTriggerSubscriptions(): void {
  if (state.subscription) {
    try {
      state.subscription.unsubscribe()
    } catch {
      // best-effort
    }
    state.subscription = undefined
  }
  state.byKind = new Map()
}

/**
 * Context passed by the inbound bus / chat send pipeline. Each property is
 * matched against the corresponding trigger node's params with these rules:
 *
 *   • `adapterId` (connector.inbound) — required match
 *   • `conversationKey` (connector.inbound) — optional match. If the
 *     trigger node didn't specify one, it matches any conversation.
 *   • `characterId` (chat.message) — required match
 *   • `sessionId` (chat.message) — optional. Trigger may scope to a single
 *     session; if unspecified, matches all sessions for the character.
 */
export interface TriggerMatchContext {
  adapterId?: string
  conversationKey?: string
  characterId?: string
  sessionId?: string
  /** Goal id (goal.completed) — optional match; unspecified node matches any goal. */
  goalId?: string
  /**
   * Outcome status — goal.completed sends the terminal goal status (e.g.
   * "completed"); terminal.command sends "success" / "failure". Optional
   * equality match against the node's `status` param.
   */
  status?: string
  /** Project id (terminal.command) — optional equality match. */
  projectId?: string
  /** Team id (trigger.team) — optional; unspecified node matches any team. */
  teamId?: string
  /**
   * Command line (terminal.command) — matched as a *substring* against the
   * node's `commandContains` param. Already PII-gated by the dispatcher;
   * an empty string only matches nodes without a `commandContains` filter.
   */
  command?: string
}

/**
 * Return the list of triggers that match `kind + ctx`. Synchronous — reads
 * the in-memory cache. Returns an empty array when nothing matches or the
 * cache hasn't been populated yet.
 */
export function findMatchingWorkflows(
  kind: WorkflowNodeKind,
  ctx: TriggerMatchContext = {}
): SubscribedTrigger[] {
  const list = state.byKind.get(kind) ?? []
  if (list.length === 0) return []
  return list.filter((entry) => matches(entry, ctx))
}

function matches(entry: SubscribedTrigger, ctx: TriggerMatchContext): boolean {
  const p = entry.params
  if (typeof p.adapterId === "string" && p.adapterId.length > 0) {
    if (ctx.adapterId !== p.adapterId) return false
  }
  if (typeof p.conversationKey === "string" && p.conversationKey.length > 0) {
    if (ctx.conversationKey !== p.conversationKey) return false
  }
  if (typeof p.characterId === "string" && p.characterId.length > 0) {
    if (ctx.characterId !== p.characterId) return false
  }
  if (typeof p.sessionId === "string" && p.sessionId.length > 0) {
    if (ctx.sessionId !== p.sessionId) return false
  }
  if (typeof p.goalId === "string" && p.goalId.length > 0) {
    if (ctx.goalId !== p.goalId) return false
  }
  if (typeof p.status === "string" && p.status.length > 0) {
    if (ctx.status !== p.status) return false
  }
  if (typeof p.projectId === "string" && p.projectId.length > 0) {
    if (ctx.projectId !== p.projectId) return false
  }
  if (typeof p.teamId === "string" && p.teamId.length > 0) {
    if (ctx.teamId !== p.teamId) return false
  }
  if (typeof p.commandContains === "string" && p.commandContains.length > 0) {
    if (typeof ctx.command !== "string" || !ctx.command.includes(p.commandContains)) return false
  }
  return true
}

/** Test-only — directly seed the cache without going through Dexie. */
export function _seedTriggerSubscriptionsForTest(rows: WorkflowRow[]): void {
  rebuildIndex(rows)
}

/** Test-only — peek at the current cache. */
export function _peekTriggerSubscriptions(): ReadonlyMap<WorkflowNodeKind, SubscribedTrigger[]> {
  return state.byKind
}
