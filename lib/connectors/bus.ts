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
  ConnectorCallbackEvent,
  NormalizedInboundEvent,
  PlatformAdapter,
  OutboundRequest,
  OutboundResult,
} from "@/types/connectors"
import type { StoredMessage } from "@/lib/claude/types"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { getCharacter } from "@/lib/db/characters"
import { getDb } from "@/lib/db/schema"
import { recordAndCheckInbound } from "./dedup"
import { resolveCallbackBinding } from "./adapters/_shared/a2ui-mapper"
import { appendAudit } from "./audit"
import { evaluatePolicy, type PolicyEvalState } from "./policy-eval"
import { resolveBinding, type ResolvedBinding } from "./policy-resolve"
import { routeInbound, type RouteDecision } from "./mode-router"
import { dispatchTrigger } from "@/lib/workflow/runtime/trigger-bridge"
import { findMatchingWorkflows } from "@/lib/workflow/runtime/trigger-subscriptions"
import { trackInboxEvent } from "@/lib/telemetry/inbox-events"

export interface BusInboundHandler {
  (event: NormalizedInboundEvent): Promise<void>
}

/** Called by the runtime (Task 37) to handle the final routing decision. */
export type RouteHandler = (
  event: NormalizedInboundEvent,
  decision: RouteDecision,
  resolved: ResolvedBinding
) => void | Promise<void>

/**
 * Called when a connector-side inbound callback (Slack block_actions /
 * Lark interactive card / Telegram callback_query / Discord component
 * interaction) lands and has passed dedup + binding lookup. Wired by
 * the connector runtime to the A2UI bridge MCP server's
 * `a2ui_handle_connector_action` tool, which injects an A2UI ActionEvent
 * onto the matching surface so the assistant's next turn sees the
 * interaction as if it had fired inside the renderer.
 *
 * `boundConversationKey` is whatever the connectorCallbackBindings row
 * resolved to — null when no binding exists (the callback's
 * `conversationKey` is the only hint). Handler decides whether to drop
 * orphan callbacks or treat them as raw action events.
 */
export type CallbackHandler = (
  event: ConnectorCallbackEvent,
  boundConversationKey: string | null
) => void | Promise<void>

export class ConnectorBus {
  private adapters = new Map<string, PlatformAdapter>()
  private inboundHandler: BusInboundHandler | null = null
  /** Optional: set by Task 37 runtime. */
  routeHandler: RouteHandler | null = null
  /**
   * Optional connector-callback handler. Wired in production to
   * `lib/a2ui/connector-callback-handler.ts`, which forwards the event
   * to the `builtin:a2ui-bridge` MCP server's
   * `a2ui_handle_connector_action` tool. Left null in tests until
   * explicitly assigned.
   */
  callbackHandler: CallbackHandler | null = null

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
   * resolve binding → evaluate policy → route → bookkeep → audit →
   * handler → workflow fan-out.
   *
   * Edit / delete / system events branch out at the very top: they don't
   * carry a fresh user message, so they bypass the full pipeline and get
   * applied to the existing StoredMessage directly. They still write an
   * audit row and (where relevant) fire workflow triggers.
   */
  async dispatchInboundFull(event: NormalizedInboundEvent): Promise<void> {
    const now = Date.now()

    // ── Edit / Delete / System short-circuit ─────────────────────────────────
    if (event.kind === "edit") {
      await this.applyMessageEdit(event, now)
      return
    }
    if (event.kind === "delete") {
      await this.applyMessageDelete(event, now)
      return
    }
    if (event.kind === "system") {
      await this.applySystemEvent(event, now)
      return
    }

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
    // v49 breadcrumb — fire after dedup passes so duplicate events do not
    // inflate the inbound counter. Best-effort: trackInboxEvent swallows
    // failures so a telemetry write never breaks the inbound pipeline.
    void trackInboxEvent("inbound.received", {
      adapterId: event.adapterId,
      conversationKey: event.conversationKey,
      fields: { platform: event.platform },
      at: now,
    })

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

    // ── Step 11: workflow fan-out ────────────────────────────────────────────
    // Workflows subscribed to `trigger.connector.inbound` get the event
    // payload regardless of the routing decision — a workflow may want
    // to react to a draft-mode message just as much as an ai-run one.
    // Fan-out is suppressed when the policy gate blocked the event so
    // we don't bypass the rate-limit / cooldown rules indirectly.
    //
    // We DO suppress fan-out for `decision === "drop"` because dropped
    // events leave no StoredMessage for the workflow to act on, and
    // every existing trigger expects a real conversation context.
    if (!evalResult.blocked && decision !== "drop") {
      await this.fanOutWorkflowTriggers(event)
    }
  }

  /**
   * Apply a `kind === "edit"` event to the matching StoredMessage. The
   * lookup keys off `metadata.platformMessage.messageId === replacesMessageId`
   * so we can update in place without a Dexie schema change. When no row
   * matches (race / dedup window expiry / never-stored direction), we just
   * audit and move on — the platform side already shows the edit.
   */
  private async applyMessageEdit(event: NormalizedInboundEvent, now: number): Promise<void> {
    const replaces = event.replacesMessageId
    if (!replaces) {
      await appendAudit({
        adapterId: event.adapterId,
        kind: "adapter.error",
        at: now,
        conversationKey: event.conversationKey,
        reason: "edit_event_missing_replaces_id",
      })
      return
    }
    // Use the v49 `platformMessageId` index for O(log n) lookup. The
    // platform safety filter scopes by adapter+platform so a Telegram
    // `12345` edit cannot accidentally match a Discord row with the same
    // numeric id. Legacy rows were backfilled by the v49 upgrade hook.
    const db = getDb()
    const target = await db.messages
      .where("platformMessageId")
      .equals(replaces)
      .filter((m) => m.metadata?.platformMessage?.platform === event.platform)
      .first()
    if (target) {
      // Map the new segments → parts the same way insertInboundMessage does.
      const parts: StoredMessage["parts"] = event.segments
        .map((seg) => {
          if (seg.type === "text" || seg.type === "markdown") {
            return {
              type: "text" as const,
              text: seg.type === "text" ? seg.text : seg.md,
            }
          }
          if (seg.type === "image") {
            return { type: "text" as const, text: `[image: ${seg.url}]` }
          }
          return { type: "text" as const, text: event.plainText }
        })
        .filter((p, i, arr) => {
          if (i === 0) return true
          const prev = arr[i - 1]
          return !(prev.type === "text" && p.type === "text" && prev.text === p.text)
        })
      const finalParts =
        parts.length > 0 ? parts : [{ type: "text" as const, text: event.plainText }]
      const editedMetadata: StoredMessage["metadata"] = {
        ...target.metadata,
        editedAt: now,
        editCount: ((target.metadata?.editCount as number | undefined) ?? 0) + 1,
      }
      await db.messages.update(target.id, {
        parts: finalParts,
        metadata: editedMetadata,
      })
    }
    await appendAudit({
      adapterId: event.adapterId,
      kind: "inbound.edited",
      at: now,
      conversationKey: event.conversationKey,
      message: replaces,
      fields: { matched: !!target },
    })
    // Edits do not fan out to workflows — most subscribers expect new
    // messages, and re-firing on every keystroke would amplify noise.
  }

  /**
   * Apply a `kind === "delete"` event by soft-deleting the matching
   * StoredMessage (set `metadata.deletedAt` + clear `parts`). Audit fires
   * regardless of whether a matching row was found.
   */
  private async applyMessageDelete(event: NormalizedInboundEvent, now: number): Promise<void> {
    const replaces = event.replacesMessageId
    if (!replaces) {
      await appendAudit({
        adapterId: event.adapterId,
        kind: "adapter.error",
        at: now,
        conversationKey: event.conversationKey,
        reason: "delete_event_missing_replaces_id",
      })
      return
    }
    // Indexed lookup via v49 `platformMessageId`. See `applyMessageEdit`
    // for the rationale on the platform safety filter.
    const db = getDb()
    const target = await db.messages
      .where("platformMessageId")
      .equals(replaces)
      .filter((m) => m.metadata?.platformMessage?.platform === event.platform)
      .first()
    if (target) {
      const deletedMetadata: StoredMessage["metadata"] = {
        ...target.metadata,
        deletedAt: now,
      }
      await db.messages.update(target.id, {
        parts: [{ type: "text" as const, text: "[deleted]" }],
        metadata: deletedMetadata,
      })
    }
    await appendAudit({
      adapterId: event.adapterId,
      kind: "inbound.deleted",
      at: now,
      conversationKey: event.conversationKey,
      message: replaces,
      fields: { matched: !!target },
    })
  }

  /**
   * Apply a `kind === "system"` event — read indicators, member joins /
   * leaves. These never produce a StoredMessage; the audit row is the
   * whole record. Map `systemKind` → audit kind so the timeline UI can
   * render them with semantic icons.
   */
  private async applySystemEvent(event: NormalizedInboundEvent, now: number): Promise<void> {
    const sk = event.systemKind
    let kind: "inbound.read_indicator" | "inbound.member_added" | "inbound.member_removed"
    if (sk === "read_indicator") kind = "inbound.read_indicator"
    else if (sk === "member_added") kind = "inbound.member_added"
    else if (sk === "member_removed") kind = "inbound.member_removed"
    else {
      // Unknown system variant — surface it as adapter.error so the
      // trail catches the schema gap on next deploy.
      await appendAudit({
        adapterId: event.adapterId,
        kind: "adapter.error",
        at: now,
        conversationKey: event.conversationKey,
        reason: `unknown_system_kind:${sk ?? "<absent>"}`,
      })
      return
    }
    await appendAudit({
      adapterId: event.adapterId,
      kind,
      at: now,
      conversationKey: event.conversationKey,
      fields: {
        actorOpenId: event.sender.remoteUserId,
        rawType: (event.raw as { header?: { event_type?: string } } | undefined)?.header
          ?.event_type,
      },
    })
  }

  /**
   * Fan a `trigger.connector.inbound` event out to every matching
   * workflow. Failures in one workflow don't break the others or the
   * bus — we collect rejections and log them once.
   */
  private async fanOutWorkflowTriggers(event: NormalizedInboundEvent): Promise<void> {
    let matches: Array<{ workflowId: string; nodeId: string; params: Record<string, unknown> }> = []
    try {
      matches = findMatchingWorkflows("trigger.connector.inbound", {
        adapterId: event.adapterId,
        conversationKey: event.conversationKey,
      })
    } catch {
      return
    }
    if (matches.length === 0) return

    const originAt = Date.now()
    const dispatches = matches.map(async (m) => {
      try {
        await dispatchTrigger({
          workflowId: m.workflowId,
          kind: "trigger.connector.inbound",
          payload: event,
          originAt,
          binding: {
            adapterId: event.adapterId,
            conversationKey: event.conversationKey,
          },
        })
      } catch (err) {
        // Per-workflow failure — never crash the bus. Audit so the
        // operator can see the breakage.
        await appendAudit({
          adapterId: event.adapterId,
          kind: "adapter.error",
          at: Date.now(),
          conversationKey: event.conversationKey,
          reason: "workflow_dispatch_failed",
          message: err instanceof Error ? err.message : String(err),
          fields: { workflowId: m.workflowId, nodeId: m.nodeId },
        })
      }
    })
    await Promise.all(dispatches)
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

  /**
   * Dispatch a connector-side callback (interactive button / select /
   * form submit / dismiss) into the A2UI Action channel.
   *
   * Pipeline:
   *   1. Dedup against `inboundLedger` with namespace `"callback"` so a
   *      redelivered event (Telegram retries, Slack rebroadcasts) is
   *      not re-processed.
   *   2. Recover the (surfaceId, componentId, conversationKey) binding
   *      from `connectorCallbackBindings` — written at outbound time by
   *      the per-platform A2UI mapper. The event's own `surfaceId` /
   *      `componentId` fields take precedence when the binding is
   *      absent (e.g., adapter computed them inline from the action_id).
   *   3. Write an audit row (`callback.received` or
   *      `callback.deduped` / `callback.unbound`).
   *   4. Hand off to `callbackHandler` if set. The handler is
   *      responsible for projecting the event into an A2UI ActionEvent
   *      and forwarding it through the `builtin:a2ui-bridge` MCP server.
   *
   * Errors thrown by the handler are caught and audited as
   * `callback.handler_failed` so a single bad callback doesn't kill the
   * transport loop.
   */
  async dispatchConnectorCallback(event: ConnectorCallbackEvent): Promise<void> {
    const now = Date.now()

    // ── Step 1: Dedup ───────────────────────────────────────────────
    const isNew = await recordAndCheckInbound(event.adapterId, event.triggerId, "callback")
    if (!isNew) {
      await appendAudit({
        adapterId: event.adapterId,
        kind: "callback.deduped",
        at: now,
        conversationKey: event.conversationKey,
        reason: "callback:duplicate",
        message: `triggerId=${event.triggerId}`,
        fields: { actionType: event.actionType },
      })
      return
    }

    // ── Step 2: Binding lookup (optional — event may already carry
    //            inline-derived surfaceId / componentId) ─────────────
    let resolvedSurfaceId = event.surfaceId
    let resolvedComponentId = event.componentId
    let resolvedConversationKey = event.conversationKey ?? null
    let bindingFound = false
    let resolvedBinding: Awaited<ReturnType<typeof resolveCallbackBinding>> = undefined
    try {
      // Pick the lookup key the adapter actually used at outbound time:
      // most adapters bake the action_id into the platform-side button
      // (`buildActionId(surfaceId, componentId, action)` formatted), so
      // `triggerId` (when assignable) lives in the `actionId` column.
      resolvedBinding = await resolveCallbackBinding(event.adapterId, event.triggerId)
      if (resolvedBinding) {
        bindingFound = true
        resolvedSurfaceId = resolvedBinding.surfaceId
        resolvedComponentId = resolvedBinding.componentId ?? resolvedComponentId
        resolvedConversationKey = resolvedBinding.conversationKey ?? resolvedConversationKey
      }
    } catch {
      // Binding lookup is best-effort — Dexie hiccups should not block
      // the callback. We fall through to whatever the event self-reported.
    }

    if (!resolvedSurfaceId) {
      // No anchoring surface at all — log and bail. We DON'T fire the
      // handler because A2UI ActionEvents require a target surface.
      await appendAudit({
        adapterId: event.adapterId,
        kind: "callback.unbound",
        at: now,
        conversationKey: resolvedConversationKey ?? undefined,
        reason: "no surfaceId binding",
        message: `triggerId=${event.triggerId}`,
        fields: {
          actionType: event.actionType,
          bindingFound,
        },
      })
      return
    }

    // ── Step 3: Audit reception ─────────────────────────────────────
    await appendAudit({
      adapterId: event.adapterId,
      kind: "callback.received",
      at: now,
      conversationKey: resolvedConversationKey ?? undefined,
      idempotencyKey: event.triggerId,
      message: `${event.actionType} on ${resolvedSurfaceId}${
        resolvedComponentId ? `/${resolvedComponentId}` : ""
      }`,
      fields: {
        actionType: event.actionType,
        value: event.value,
        bindingFound,
      },
    })

    // ── Step 4-pre-b: wf_fanout_approve / wf_fanout_cancel short-circuit ──
    //
    // Companion to wf_approve/wf_cancel below. The fan-out flow writes
    // a `workflowFanoutSubscriptions` row on Approve and a confirmation
    // outbound text. Cancel just drops the bindings + sends "已取消".
    if (
      resolvedBinding?.kind === "wf_fanout_approve" ||
      resolvedBinding?.kind === "wf_fanout_cancel"
    ) {
      const cancelled =
        resolvedBinding.kind === "wf_fanout_cancel" ||
        (event.value ?? "").toLowerCase() === "cancel" ||
        event.actionType === "dismiss"
      try {
        const { handleWorkflowFanoutCallback } = await import("@/lib/a2ui/workflow-fanout-handler")
        await handleWorkflowFanoutCallback({
          binding: resolvedBinding,
          cancelled,
          adapterId: event.adapterId,
          platform: event.platform,
          conversationKey: resolvedConversationKey ?? undefined,
        })
      } catch (err) {
        await appendAudit({
          adapterId: event.adapterId,
          kind: "workflow_fanout_failed",
          at: Date.now(),
          conversationKey: resolvedConversationKey ?? undefined,
          reason: err instanceof Error ? err.name : "unknown",
          message: err instanceof Error ? err.message : String(err),
          fields: { triggerId: event.triggerId, kind: resolvedBinding.kind },
        })
      }
      return
    }

    // ── Step 4-pre-a: wf_approve / wf_cancel short-circuit ───────────
    //
    // When the binding is an A2UI workflow approval card, drive the run
    // start (or cancellation acknowledgement) directly and enqueue the
    // outbound confirmation through the standard outbound queue. The
    // bus DOES NOT call `runConnectorDigestTurn` — IM users expect a
    // tight "✅ Started" reply, not a synthesised model turn that says
    // the same thing in three paragraphs. Subsequent progress + final
    // surfaces are emitted by `workflow-progress-runner` via the same
    // outbound queue.
    if (resolvedBinding?.kind === "wf_approve" || resolvedBinding?.kind === "wf_cancel") {
      const cancelled =
        resolvedBinding.kind === "wf_cancel" ||
        (event.value ?? "").toLowerCase() === "cancel" ||
        event.actionType === "dismiss"
      try {
        const { handleWorkflowApprovalCallback } =
          await import("@/lib/a2ui/workflow-approval-handler")
        await handleWorkflowApprovalCallback({
          binding: resolvedBinding,
          cancelled,
          adapterId: event.adapterId,
          platform: event.platform,
          conversationKey: resolvedConversationKey ?? undefined,
        })
      } catch (err) {
        await appendAudit({
          adapterId: event.adapterId,
          kind: "workflow_approval_failed",
          at: Date.now(),
          conversationKey: resolvedConversationKey ?? undefined,
          reason: err instanceof Error ? err.name : "unknown",
          message: err instanceof Error ? err.message : String(err),
          fields: { triggerId: event.triggerId, kind: resolvedBinding.kind },
        })
      }
      return
    }

    // ── Step 4a: skill_invoke short-circuit (ADR-0026) ───────────────
    //
    // When the binding is a deferred built-in-skill invocation, route
    // straight to the dispatcher with `hitlBypass: true` (user confirmed)
    // or audit a rejection (user cancelled). Bypasses the standard digest
    // turn so the assistant doesn't see a synthetic "user clicked button"
    // turn — the dispatcher will surface the skill result through the
    // normal chat-loop on its own.
    if (resolvedBinding?.kind === "skill_invoke") {
      const skillId = String(resolvedBinding.payload?.["skillId"] ?? "")
      const skillArgs = resolvedBinding.payload?.["args"]
      const value = (event.value ?? "").toLowerCase()
      const cancelled = value === "cancel" || event.actionType === "dismiss"
      if (cancelled || !skillId) {
        await appendAudit({
          adapterId: event.adapterId,
          kind: "builtin_skill_hitl_rejected",
          at: Date.now(),
          conversationKey: resolvedConversationKey ?? undefined,
          reason: cancelled ? "user_cancelled" : "binding_missing_skill_id",
          message: `Skill HITL rejected for binding ${event.triggerId}`,
          fields: { triggerId: event.triggerId, skillId },
        })
        return
      }
      try {
        // Lazy import to avoid pulling the skill registry into adapter
        // bundles that don't need it (mobile lite shells, for instance).
        const { runBuiltInSkill } = await import("@/lib/skills/built-in/dispatcher")
        await runBuiltInSkill(skillId, skillArgs, {
          sessionId: resolvedConversationKey ?? "",
          imBinding: {
            adapterId: event.adapterId,
            platform: event.platform,
            conversationKey: resolvedConversationKey ?? event.adapterId,
          },
          hitlBypass: true,
        })
      } catch (err) {
        await appendAudit({
          adapterId: event.adapterId,
          kind: "builtin_skill_failed",
          at: Date.now(),
          conversationKey: resolvedConversationKey ?? undefined,
          reason: err instanceof Error ? err.name : "unknown",
          message: err instanceof Error ? err.message : String(err),
          fields: { triggerId: event.triggerId, skillId },
        })
      }
      return
    }

    // ── Step 4b: Hand off to the bridge ──────────────────────────────
    if (!this.callbackHandler) return
    const projected: ConnectorCallbackEvent = {
      ...event,
      surfaceId: resolvedSurfaceId,
      componentId: resolvedComponentId,
      conversationKey: resolvedConversationKey ?? undefined,
    }
    try {
      await this.callbackHandler(projected, resolvedConversationKey)
    } catch (err) {
      await appendAudit({
        adapterId: event.adapterId,
        kind: "callback.handler_failed",
        at: Date.now(),
        conversationKey: resolvedConversationKey ?? undefined,
        reason: err instanceof Error ? err.name : "unknown",
        message: err instanceof Error ? err.message : String(err),
        fields: { triggerId: event.triggerId, surfaceId: resolvedSurfaceId },
      })
    }
  }

  listAdapters(): PlatformAdapter[] {
    return Array.from(this.adapters.values())
  }

  /**
   * Look up a registered adapter instance by id. Returns `undefined` when
   * no adapter with that id is registered. Used by the runtime to detect
   * optional adapter capabilities (e.g. `streamReply`) before driving an
   * AI turn so it can wire incremental platform-side streaming.
   */
  getAdapter(adapterId: string): PlatformAdapter | undefined {
    return this.adapters.get(adapterId)
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
