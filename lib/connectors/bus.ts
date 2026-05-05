/**
 * ConnectorBus singleton — Tasks 25 & 28.
 *
 * Task 25: registry + basic fan-in / fan-out.
 * Task 28: full dispatchInbound pipeline:
 *   1. Dedup (inbound ledger)
 *   2. Adapter instance lookup
 *   3. Conversation override lookup
 *   4. Character lookup (optional)
 *   5. Three-layer binding resolution
 *   6. Policy evaluation
 *   7. Mode routing
 *   8. Policy state bookkeeping
 *   9. Audit
 *   10. routeHandler callback (wired by Task 37 runtime)
 */

import type {
  NormalizedInboundEvent,
  PlatformAdapter,
  OutboundRequest,
  OutboundResult,
} from "@/types/connectors"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { getCharacter } from "@/lib/db/characters"
import { recordAndCheckInbound } from "./dedup"
import { appendAudit } from "./audit"
import { evaluatePolicy, type PolicyEvalState } from "./policy-eval"
import { resolveBinding, type ResolvedBinding } from "./policy-resolve"
import { routeInbound, type RouteDecision } from "./mode-router"

export interface BusInboundHandler {
  (event: NormalizedInboundEvent): Promise<void>
}

/** Called by the runtime (Task 37) to handle the final routing decision. */
export type RouteHandler = (
  event: NormalizedInboundEvent,
  decision: RouteDecision,
  resolved: ResolvedBinding
) => void | Promise<void>

class ConnectorBus {
  private adapters = new Map<string, PlatformAdapter>()
  private inboundHandler: BusInboundHandler | null = null
  /** Optional: set by Task 37 runtime. */
  routeHandler: RouteHandler | null = null

  /** In-memory policy state for rate-limit / cooldown bookkeeping. */
  private policyState: PolicyEvalState = {
    recentBotReplyAtByConversation: {},
    recentByUserAndChannel: {},
  }

  registerAdapter(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  unregisterAdapter(adapterId: string): void {
    this.adapters.delete(adapterId)
  }

  setInboundHandler(handler: BusInboundHandler): void {
    this.inboundHandler = handler
  }

  /**
   * Simple inbound dispatch — Task 25 interface.
   *
   * After Task 28 the bus pipeline supersedes this for real events. Kept so
   * Task 25 tests continue to pass without touching them.
   */
  async dispatchInbound(event: NormalizedInboundEvent): Promise<void> {
    if (!this.inboundHandler) throw new Error("ConnectorBus: inbound handler not set")
    await this.inboundHandler(event)
  }

  /**
   * Full inbound dispatch pipeline — Task 28.
   *
   * Runs dedup → adapter lookup → override lookup → character lookup →
   * resolve binding → evaluate policy → route → bookkeep → audit → handler.
   */
  async dispatchInboundFull(event: NormalizedInboundEvent): Promise<void> {
    const now = Date.now()

    // ── Step 1: dedup ────────────────────────────────────────────────────────
    const isNew = await recordAndCheckInbound(event.adapterId, event.messageId)
    if (!isNew) {
      await appendAudit({
        adapterId: event.adapterId,
        kind: "inbound.deduped",
        at: now,
        conversationKey: event.conversationKey,
      })
      return
    }

    // ── Step 2: adapter instance lookup ──────────────────────────────────────
    const adapterRow = await getAdapterInstance(event.adapterId)
    if (!adapterRow) {
      await appendAudit({
        adapterId: event.adapterId,
        kind: "adapter.error",
        at: now,
        reason: "missing_adapter_instance",
      })
      return
    }

    // ── Step 3: conversation override lookup ──────────────────────────────────
    const override = (await readForResolution(event.conversationKey)) ?? null

    // ── Step 4: character lookup ──────────────────────────────────────────────
    const charId = override?.characterId ?? adapterRow.defaultCharacterId
    const character = charId ? ((await getCharacter(charId)) ?? null) : null

    // ── Step 5: resolve binding ───────────────────────────────────────────────
    const resolved = resolveBinding({ adapter: adapterRow, character, override })

    // ── Step 6: evaluate policy ───────────────────────────────────────────────
    const evalResult = evaluatePolicy(resolved.trigger, event, this.policyState, now)

    // ── Step 7: route ─────────────────────────────────────────────────────────
    const decision = routeInbound(
      resolved.mode,
      evalResult,
      resolved.trigger.storeUnmatchedInDraftMode
    )

    // ── Step 8: policy state bookkeeping ──────────────────────────────────────
    if (evalResult.blocked) {
      // No-op for state — blocked events don't reset cooldowns
    } else {
      // Update rate-limit bucket
      const bucketKey = `${event.sender.id}:${event.channel.id}`
      const existing = this.policyState.recentByUserAndChannel[bucketKey] ?? []
      this.policyState.recentByUserAndChannel[bucketKey] = [...existing, now]
    }

    // ── Step 9: audit ─────────────────────────────────────────────────────────
    if (evalResult.blocked) {
      await appendAudit({
        adapterId: event.adapterId,
        kind: "inbound.policy_blocked",
        at: now,
        conversationKey: event.conversationKey,
        reason: evalResult.reason,
      })
    } else if (decision !== "drop") {
      await appendAudit({
        adapterId: event.adapterId,
        kind: "inbound.received",
        at: now,
        conversationKey: event.conversationKey,
      })
    }

    // ── Step 10: route handler ────────────────────────────────────────────────
    if (this.routeHandler && decision !== "drop") {
      await this.routeHandler(event, decision, resolved)
    }
  }

  async sendOutbound(adapterId: string, req: OutboundRequest): Promise<OutboundResult> {
    const a = this.adapters.get(adapterId)
    if (!a) {
      return {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
    }
    return a.send(req)
  }

  listAdapters(): PlatformAdapter[] {
    return Array.from(this.adapters.values())
  }

  /** Test-only: inspect or reset policy state. */
  __getPolicyStateForTesting(): PolicyEvalState {
    return this.policyState
  }

  __resetPolicyStateForTesting(): void {
    this.policyState = {
      recentBotReplyAtByConversation: {},
      recentByUserAndChannel: {},
    }
  }
}

let _bus: ConnectorBus | null = null

export function getBus(): ConnectorBus {
  if (!_bus) _bus = new ConnectorBus()
  return _bus
}

/** Test-only reset. */
export function __resetBusForTesting(): void {
  _bus = null
}
