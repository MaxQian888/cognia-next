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

import Dexie, { type Subscription } from "dexie"
import { getDb } from "@/lib/db/schema"
import type { WorkflowNodeKind, WorkflowRow } from "@/types/workflow/visual"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

export interface SubscribedTrigger {
  workflowId: string
  nodeId: string
  params: Record<string, unknown>
}

/** Kinds we actually index — cron/webhook triggers go through the Rust router. */
const INDEXED_KINDS: readonly WorkflowNodeKind[] = [
  "trigger.connector.inbound",
  "trigger.connector.system",
  "trigger.chat.message",
  "trigger.goal.completed",
  "trigger.terminal.command",
  "trigger.team",
  "trigger.desktop.event",
  "trigger.pet.event",
  "trigger.workflow.completed",
  "trigger.integration.event",
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
    if (wf.isTemplate || wf.isBuiltIn) continue
    for (const node of wf.nodes) {
      if (node.data.disabled || !INDEXED_KINDS.includes(node.type)) continue
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
    // `Dexie.liveQuery`, not a named `liveQuery` import. Dexie's CJS build (what
    // Jest resolves) defines `liveQuery` as a NON-ENUMERABLE property of
    // `module.exports` and sets no `__esModule` marker. Importing the `Dexie`
    // default alongside it, as this module now does, routes the module through
    // SWC's `_interop_require_wildcard`, which copies enumerable keys only, so a
    // named `liveQuery` binding would silently be `undefined`. The static is the
    // same function (`Dexie.liveQuery === liveQuery` under real ESM) and is
    // correct through either path.
    const observable = Dexie.liveQuery(() => getDb().workflows.toArray())
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
   * Source workflow id (workflow.completed) — matched against the node's
   * `workflowId` param. A node without the filter matches EVERY workflow's
   * terminal run (self-triggering is still rejected by the fanout emitter).
   */
  sourceWorkflowId?: string
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
   * Desktop UI event kind (trigger.desktop.event) — matched against the
   * node's `kinds` array param ("focus-changed" / …). A node without a
   * `kinds` filter matches every event kind.
   */
  desktopEventKind?: string
  /**
   * Pet lifecycle event kind (trigger.pet.event) — matched against the
   * node's `kinds` array param (levelUp / evolved / achievementUnlocked /
   * unwell). A node without a `kinds` filter matches every lifecycle kind.
   */
  petEventKind?: string
  /**
   * Platform system-event kind (trigger.connector.system) — reaction_added /
   * reaction_removed / poke / request / lifecycle, matched against the node's
   * `kinds` array param. A node without a `kinds` filter matches every kind.
   */
  connectorSystemKind?: string
  /**
   * Whether the system event's target message was delivered by the bot
   * (trigger.connector.system) — a node with `targetSelfOnly: true` only
   * fires when this is true.
   */
  targetDeliveredByUs?: boolean
  /**
   * Command line (terminal.command) — matched as a *substring* against the
   * node's `commandContains` param. Already PII-gated by the dispatcher;
   * an empty string only matches nodes without a `commandContains` filter.
   */
  command?: string
  /**
   * Platform sender id (connector.inbound) — matched against the node's
   * `senderIds` array param (OR). A node without the filter matches any
   * sender.
   */
  senderId?: string
  /**
   * Channel kind (connector.inbound) — private / group / channel / thread,
   * matched against the node's `channelKinds` array param.
   */
  channelKind?: string
  /**
   * Message plain text (connector.inbound) — matched case-insensitively as
   * a substring against the node's `keywords` array param (OR).
   */
  plainText?: string
  /**
   * Whether the bot itself was @-mentioned (connector.inbound) — a node
   * with `requireMention: true` only fires when this is true.
   */
  selfMentioned?: boolean
  /** Marketplace integration identifiers and normalized event filters. */
  pluginId?: string
  integrationId?: string
  accountId?: string
  eventType?: string
  resourceKind?: string
  resourceId?: string
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
  // workflow.completed: the node's `workflowId` param scopes to ONE source
  // workflow; entries are partitioned per kind so this never collides with
  // other kinds' params.
  if (typeof p.workflowId === "string" && p.workflowId.length > 0) {
    if (ctx.sourceWorkflowId !== p.workflowId) return false
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
  if (Array.isArray(p.kinds) && p.kinds.length > 0) {
    // Shared `kinds` filter shape — desktop and pet triggers each pass their
    // own ctx field, and entries are already partitioned per trigger kind.
    const eventKind = ctx.desktopEventKind ?? ctx.petEventKind ?? ctx.connectorSystemKind
    if (typeof eventKind !== "string" || !p.kinds.includes(eventKind)) {
      return false
    }
  }
  if (typeof p.commandContains === "string" && p.commandContains.length > 0) {
    if (typeof ctx.command !== "string" || !ctx.command.includes(p.commandContains)) return false
  }
  // connector.inbound fine-grained filters (all optional).
  if (Array.isArray(p.senderIds) && p.senderIds.length > 0) {
    if (typeof ctx.senderId !== "string" || !p.senderIds.includes(ctx.senderId)) return false
  }
  if (Array.isArray(p.channelKinds) && p.channelKinds.length > 0) {
    if (typeof ctx.channelKind !== "string" || !p.channelKinds.includes(ctx.channelKind)) {
      return false
    }
  }
  if (Array.isArray(p.keywords) && p.keywords.length > 0) {
    const text = (ctx.plainText ?? "").toLowerCase()
    const hit = p.keywords.some(
      (k) => typeof k === "string" && k.length > 0 && text.includes(k.toLowerCase())
    )
    if (!hit) return false
  }
  if (p.requireMention === true && ctx.selfMentioned !== true) return false
  if (p.targetSelfOnly === true && ctx.targetDeliveredByUs !== true) return false
  if (typeof p.pluginId === "string" && p.pluginId.length > 0 && ctx.pluginId !== p.pluginId) {
    return false
  }
  if (
    typeof p.integrationId === "string" &&
    p.integrationId.length > 0 &&
    ctx.integrationId !== p.integrationId
  ) {
    return false
  }
  if (typeof p.accountId === "string" && p.accountId.length > 0 && ctx.accountId !== p.accountId) {
    return false
  }
  if (Array.isArray(p.eventTypes) && p.eventTypes.length > 0) {
    if (typeof ctx.eventType !== "string" || !p.eventTypes.includes(ctx.eventType)) return false
  }
  if (
    typeof p.resourceKind === "string" &&
    p.resourceKind.length > 0 &&
    ctx.resourceKind !== p.resourceKind
  ) {
    return false
  }
  if (
    typeof p.resourceId === "string" &&
    p.resourceId.length > 0 &&
    ctx.resourceId !== p.resourceId
  ) {
    return false
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
