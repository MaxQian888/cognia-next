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
  AttachmentDescriptor,
  AdapterAttachmentRef,
  HistoryFetchOpts,
  StreamReplyRequest,
  A2UICapabilityMatrix,
} from "@/types/connectors"
import type { PlatformSkillCapability } from "@/types/connectors/skill-capability"
import type { StoredMessage } from "@/lib/claude/types"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { readForResolution, setStatus, setSlaDue } from "@/lib/db/conversation-overrides"
import { computeDueAt } from "@/lib/connectors/sla"
import { upsertIdentity } from "@/lib/db/platform-identities"
import { getCharacter } from "@/lib/db/characters"
import { getDb } from "@/lib/db/schema"
import { recordAndCheckInbound } from "./dedup"
import { resolveCallbackBinding } from "./adapters/_shared/a2ui-mapper"
import { appendAudit } from "./audit"
import { runInboundOcr } from "./inbound-ocr"
import { evaluatePolicy, type PolicyEvalState } from "./policy-eval"
import { resolveBinding, type ResolvedBinding } from "./policy-resolve"
import { routeInbound, type RouteDecision } from "./mode-router"
import { dispatchTrigger } from "@/lib/workflow/runtime/trigger-bridge"
import { findMatchingWorkflows } from "@/lib/workflow/runtime/trigger-subscriptions"
import { trackInboxEvent } from "@/lib/telemetry/inbox-events"
import { maybeHandleHelpCommand, maybeSendWelcome } from "./help/help-dispatch"
import { maybeHandleControlCommand } from "./commands/dispatch"
import { parseConversationKey } from "@/types/connectors/event"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { hasNoLeakingPiiDeep } from "@/lib/twin/ingest/redact"
import { segmentsToPlainText, type MessageSegment } from "@/types/connectors/segment"

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
  /**
   * Passive inbound observers (plugin `ctx.connectors.onInbound`). Notified
   * for every event the bus processes, BEFORE the routing pipeline. Purely
   * read-only — a throwing observer is swallowed and never affects routing.
   * Distinct from `inboundHandler`/`routeHandler`, which own the single
   * authoritative routing decision.
   */
  private inboundObservers = new Set<(event: NormalizedInboundEvent) => void>()
  /**
   * Passive interactive-callback observers (plugin
   * `ctx.connectors.onCallback`). Notified for every callback that passes
   * dedup + binding resolution, with the resolved `boundConversationKey`,
   * BEFORE any kind-specific short-circuit or the authoritative
   * `callbackHandler`. Purely read-only — a throwing observer is swallowed
   * and never affects callback routing. The plugin parallel of
   * `inboundObservers` for the interactive (button / select / form) channel,
   * which `dispatchInbound`/`subscribeInbound` never sees.
   */
  private callbackObservers = new Set<
    (event: ConnectorCallbackEvent, boundConversationKey: string | null) => void
  >()
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
   * Subscribe a passive observer to every inbound event the bus processes.
   * Returns a disposer. Used by plugins via `ctx.connectors.onInbound`.
   * Observers run synchronously before routing and must not throw (errors
   * are caught); they cannot alter the routing decision.
   */
  subscribeInbound(observer: (event: NormalizedInboundEvent) => void): () => void {
    this.inboundObservers.add(observer)
    return () => {
      this.inboundObservers.delete(observer)
    }
  }

  private notifyInboundObservers(event: NormalizedInboundEvent): void {
    for (const observer of this.inboundObservers) {
      try {
        observer(event)
      } catch {
        // A throwing plugin observer must never break inbound routing.
      }
    }
  }

  /**
   * Subscribe a passive observer to every interactive callback the bus
   * resolves (button / select / form submit / dismiss). Returns a disposer.
   * Used by plugins via `ctx.connectors.onCallback`. Observers run
   * synchronously after binding resolution and before the authoritative
   * `callbackHandler`; they must not throw (errors are caught) and cannot
   * alter the callback routing decision.
   */
  subscribeCallback(
    observer: (event: ConnectorCallbackEvent, boundConversationKey: string | null) => void
  ): () => void {
    this.callbackObservers.add(observer)
    return () => {
      this.callbackObservers.delete(observer)
    }
  }

  private notifyCallbackObservers(
    event: ConnectorCallbackEvent,
    boundConversationKey: string | null
  ): void {
    for (const observer of this.callbackObservers) {
      try {
        observer(event, boundConversationKey)
      } catch {
        // A throwing plugin observer must never break callback routing.
      }
    }
  }

  /**
   * Simple inbound dispatch — Task 25 interface.
   *
   * After Task 28 the bus pipeline supersedes this for real events. Kept so
   * Task 25 tests continue to pass without touching them.
   */
  async dispatchInbound(event: NormalizedInboundEvent): Promise<void> {
    this.notifyInboundObservers(event)
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

    // Passive plugin observers see every event up front (read-only tap).
    this.notifyInboundObservers(event)

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

    // ── Step 1.5: eager OCR of inbound images (ADR-0024) ─────────────────────
    // Attaches `ocrText` to image segments that carry inline bytes, so trigger
    // matching (Step 6), the stored message, the agent prompt, and the digest
    // all see the image's text. Best-effort — never blocks delivery.
    await runInboundOcr(event).catch(() => undefined)

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

    // ── Step 3.5: lifecycle auto-reopen (CRM, schema v83) ─────────────────────
    // A fresh inbound on a resolved or snoozed conversation reopens it
    // (Chatwoot behaviour). Only `create` events reach this point (edit /
    // delete / system short-circuited above), so this is genuinely a new
    // message. STRICT no-op for open / pending / absent status, so existing
    // routing for every adapter is unchanged. Best-effort — a lifecycle write
    // failure must never break the inbound pipeline.
    if (override && (override.status === "resolved" || override.status === "snoozed")) {
      await setStatus(event.conversationKey, "open", { sessionId: override.sessionId }).catch(
        () => undefined
      )
    }

    // ── Step 3.6: response-SLA deadline (CRM, schema v83) ─────────────────────
    // When the operator has set a per-conversation SLA target, stamp the
    // next-response deadline so the inbox SlaBadge can count down. A fresh
    // inbound always means a reply is now due — Step 3.5 has already reopened a
    // resolved/snoozed conversation — so there's no status guard: an SLA is
    // stamped whenever one is configured. Quiet hours are excluded from the
    // budget (computeDueAt reuses the outbound-runner quiet-hours math).
    // Best-effort: an SLA write failure must never break the inbound pipeline.
    // No-op when no SLA is configured.
    if (override?.slaResponseMinutes && override.slaResponseMinutes > 0) {
      const dueAt = computeDueAt(now, override.slaResponseMinutes, override.quietHours ?? null)
      await setSlaDue(
        event.conversationKey,
        { nextResponseDueAt: dueAt },
        override.sessionId
      ).catch(() => undefined)
    }

    // ── Step 3.7: platform-identity directory (CRM, schema v83) ───────────────
    // Record the sender so the contact-profile drawer has a directory to show
    // and cross-platform identity merge has rows to work with. Best-effort — an
    // identity write failure must never break inbound routing.
    await upsertIdentity({
      platform: event.platform,
      adapterId: event.adapterId,
      remoteUserId: event.sender.remoteUserId,
      displayName: event.sender.displayName,
      avatarUrl: event.sender.avatarUrl,
    }).catch(() => undefined)

    // ── Step 4: character lookup ──────────────────────────────────────────────
    const charId = override?.characterId ?? adapterRow.defaultCharacterId
    const character = charId ? ((await getCharacter(charId)) ?? null) : null

    // ── Step 4.5: plugin onConnectorInbound (observe + veto + transform) ──────
    // A subscribed plugin may block this inbound (stop the turn) or rewrite its
    // segments before binding / policy / routing see it. A transform is
    // re-checked through the PII gate (fail-closed): a rewrite that would leak
    // PII is rejected and the original kept — a plugin can never smuggle PII
    // past the redaction line. Plugin errors are treated as allow upstream.
    try {
      const decision = await getPluginEventHooks().dispatchConnectorDecision("onConnectorInbound", {
        adapterId: event.adapterId,
        conversationKey: event.conversationKey,
        platform: event.platform,
        segments: event.segments,
        plainText: event.plainText,
        messageId: event.messageId,
      })
      if (decision.action === "block") {
        await appendAudit({
          adapterId: event.adapterId,
          kind: "plugin.inbound_blocked",
          at: now,
          conversationKey: event.conversationKey,
          reason: decision.reason ?? "plugin_blocked",
        })
        return
      }
      if (decision.action === "transform") {
        const segments = decision.segments as MessageSegment[]
        if (hasNoLeakingPiiDeep(segments)) {
          event = { ...event, segments, plainText: segmentsToPlainText(segments) }
          await appendAudit({
            adapterId: event.adapterId,
            kind: "plugin.inbound_transformed",
            at: now,
            conversationKey: event.conversationKey,
          })
        } else {
          await appendAudit({
            adapterId: event.adapterId,
            kind: "plugin.transform_pii_blocked",
            at: now,
            conversationKey: event.conversationKey,
            reason: "inbound_transform_pii",
          })
        }
      }
    } catch (err) {
      // Hook dispatch must never break the inbound pipeline.
      console.error("[connector-bus] onConnectorInbound dispatch failed", err)
    }

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

    // ── Step 9.5: help / welcome short-circuit (cross-provider) ──────────────
    // A help-trigger message serves a help card and skips the AI turn +
    // workflow fan-out entirely. Otherwise, the first inbound on a fresh
    // conversation gets a one-time welcome card (deduped per conversation)
    // BEFORE the normal reply, so onboarding lands ahead of the answer.
    // Both are best-effort: a help/welcome failure must never break the
    // inbound pipeline.
    if (decision !== "drop" && !evalResult.blocked) {
      try {
        // Control commands (`/model`, `/mode`, `/new`, …) are intercepted
        // before help so they short-circuit the AI turn + workflow fan-out
        // and never become a stored user message. More specific than the
        // generic help trigger, so it runs first.
        if (await maybeHandleControlCommand(event, adapterRow, override ?? undefined, resolved)) {
          return
        }
        if (await maybeHandleHelpCommand(event, adapterRow)) return
      } catch (err) {
        await appendAudit({
          adapterId: event.adapterId,
          kind: "adapter.error",
          at: Date.now(),
          conversationKey: event.conversationKey,
          reason: "help_dispatch_failed",
          message: err instanceof Error ? err.message : String(err),
        })
      }
      await maybeSendWelcome(event, adapterRow).catch(() => undefined)
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

    // Bot joined a chat → push a one-time welcome card (cross-provider).
    // Deduped per conversation by `maybeSendWelcome`; gated on the
    // adapter's `welcomeCardEnabled`. Best-effort — a missing adapter row
    // or enqueue failure must not break system-event bookkeeping.
    if (kind === "inbound.member_added") {
      try {
        const adapterRow = await getAdapterInstance(event.adapterId)
        if (adapterRow) await maybeSendWelcome(event, adapterRow)
      } catch {
        // swallow — welcome is best-effort
      }
    }
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
   * Edit an already-sent message in place through an adapter that supports it
   * (`PlatformAdapter.edit`). Mirrors {@link sendOutbound}: returns a failed
   * {@link OutboundResult} (rather than throwing) when the adapter is not
   * registered or the platform does not support editing, so callers get a
   * uniform result shape.
   */
  async editOutbound(
    adapterId: string,
    messageId: string,
    patch: OutboundRequest
  ): Promise<OutboundResult> {
    const a = this.adapters.get(adapterId)
    if (!a) {
      return {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
    }
    if (!a.edit) {
      return {
        ok: false,
        error: { code: "unsupported", message: "adapter cannot edit messages", retryable: false },
      }
    }
    return a.edit(messageId, patch)
  }

  /**
   * Delete an already-sent message through an adapter that supports it
   * (`PlatformAdapter.delete`). Returns an `{ ok }` result; `adapter.delete`
   * itself returns void, so success is reported as `{ ok: true }`.
   */
  async deleteOutbound(adapterId: string, messageId: string): Promise<OutboundResult> {
    const a = this.adapters.get(adapterId)
    if (!a) {
      return {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
    }
    if (!a.delete) {
      return {
        ok: false,
        error: { code: "unsupported", message: "adapter cannot delete messages", retryable: false },
      }
    }
    await a.delete(messageId)
    return { ok: true }
  }

  /**
   * Toggle a typing indicator in a conversation through an adapter that
   * supports it (`PlatformAdapter.setTyping`). Best-effort: silently no-ops
   * when the adapter is missing or the platform has no typing surface.
   * Returns whether the call was actually delivered.
   */
  async setTypingOutbound(
    adapterId: string,
    conversationKey: string,
    on: boolean
  ): Promise<boolean> {
    const a = this.adapters.get(adapterId)
    if (!a || !a.setTyping) return false
    await a.setTyping(conversationKey, on)
    return true
  }

  /**
   * Upload an attachment through an adapter that supports it
   * (`PlatformAdapter.uploadFile`), returning the platform reference. Returns
   * `null` when the adapter is missing or the platform has no upload surface.
   */
  async uploadFileOutbound(
    adapterId: string,
    file: AttachmentDescriptor
  ): Promise<AdapterAttachmentRef | null> {
    const a = this.adapters.get(adapterId)
    if (!a || !a.uploadFile) return null
    return a.uploadFile(file)
  }

  /**
   * Push an incremental assistant reply through an adapter that supports
   * platform-side streaming (`PlatformAdapter.streamReply`, e.g. WeCom's
   * `stream`-framed responses). Best-effort, mirroring {@link setTypingOutbound}:
   * resolves `false` when the adapter is missing or the platform has no
   * streaming surface, so callers can feature-detect and fall back to a
   * normal {@link sendOutbound}. `req.text` is the full accumulated reply so
   * far (not a delta) — adapters diff against their own last frame.
   */
  async streamReplyOutbound(adapterId: string, req: StreamReplyRequest): Promise<boolean> {
    const a = this.adapters.get(adapterId)
    if (!a || !a.streamReply) return false
    await a.streamReply(req)
    return true
  }

  /**
   * Drain an adapter's message-history stream (`PlatformAdapter.fetchHistory`)
   * into a bounded array. Returns `[]` when the adapter is missing or does
   * not implement history fetching. `opts.max` caps the drained count even if
   * the adapter ignores it (defends against an unbounded async iterable).
   */
  async fetchHistoryAll(
    adapterId: string,
    conversationKey: string,
    opts: HistoryFetchOpts = {}
  ): Promise<NormalizedInboundEvent[]> {
    const a = this.adapters.get(adapterId)
    if (!a || !a.fetchHistory) return []
    const cap = typeof opts.max === "number" && opts.max > 0 ? opts.max : 100
    const out: NormalizedInboundEvent[] = []
    for await (const event of a.fetchHistory(conversationKey, opts)) {
      out.push(event)
      if (out.length >= cap) break
    }
    return out
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

    // Passive plugin observers (ctx.connectors.onCallback) see every bound
    // callback here, with the resolved conversation key, before any
    // kind-specific short-circuit or the authoritative callbackHandler.
    this.notifyCallbackObservers(event, resolvedConversationKey)

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

    // ── Step 4-pre-c: tool_approve short-circuit (control-plane HITL) ──
    //
    // A button on an A2UI tool-permission card. Resolve the pending approval
    // in the in-process registry so the suspended turn continues with the
    // user's decision. "Allow for session" additionally remembers a per-session
    // bypass so the same tool won't re-prompt. No digest turn — the model is
    // already mid-turn waiting on this decision.
    if (resolvedBinding?.kind === "tool_approve") {
      const sessionId = String(resolvedBinding.payload?.["sessionId"] ?? "")
      const requestId = String(resolvedBinding.payload?.["requestId"] ?? "")
      const toolName = String(resolvedBinding.payload?.["toolName"] ?? "")
      const decision = String(resolvedBinding.payload?.["decision"] ?? "deny") as
        | "allow"
        | "deny"
        | "allow_session"
      try {
        const [{ applyToolApprovalCallback }, { resolveApproval }] = await Promise.all([
          import("@/lib/connectors/hitl/tool-approval"),
          import("@/lib/connectors/hitl/approval-registry"),
        ])
        const { granted, resolved } = applyToolApprovalCallback({
          sessionId,
          requestId,
          toolName,
          decision,
          resolve: resolveApproval,
        })
        await appendAudit({
          adapterId: event.adapterId,
          kind: granted ? "tool_approve.granted" : "tool_approve.denied",
          at: Date.now(),
          conversationKey: resolvedConversationKey ?? undefined,
          fields: { toolName, requestId, decision, resolved },
        })
      } catch (err) {
        await appendAudit({
          adapterId: event.adapterId,
          kind: "callback.handler_failed",
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

    // ── Step 4a-help: help_quick_command short-circuit (cross-provider) ──
    //
    // A help/welcome card's quick-command button. Re-enter the inbound
    // pipeline with a synthesised `create` event carrying the resolved
    // command text, exactly as if the user had typed it or clicked the
    // native bot menu. `selfMentioned: true` so an explicit click is never
    // dropped by a mention-only trigger rule.
    if (resolvedBinding?.kind === "help_quick_command") {
      const action = (resolvedBinding.payload as { action?: { value?: unknown } } | undefined)
        ?.action
      const text = typeof action?.value === "string" ? action.value : ""
      const convKey = resolvedConversationKey
      if (!text || !convKey) {
        await appendAudit({
          adapterId: event.adapterId,
          kind: "callback.unbound",
          at: Date.now(),
          conversationKey: convKey ?? undefined,
          reason: "help_quick_command:missing_action_or_conversation",
          message: `triggerId=${event.triggerId}`,
        })
        return
      }
      let parsed
      try {
        parsed = parseConversationKey(convKey)
      } catch {
        return
      }
      const synthetic: NormalizedInboundEvent = {
        platform: event.platform,
        adapterId: event.adapterId,
        selfId: event.selfId,
        messageId: `help-cmd:${event.triggerId}`,
        conversationRef: {
          platform: event.platform,
          adapterId: event.adapterId,
          channelId: parsed.remoteChatId,
          ...(parsed.threadId ? { threadTs: parsed.threadId } : {}),
        },
        conversationKey: convKey,
        sender: event.user,
        channel: {
          id: convKey,
          kind: parsed.threadId ? "thread" : "group",
          platformChannelId: parsed.remoteChatId,
        },
        segments: [{ type: "text", text }],
        plainText: text,
        mentions: { selfMentioned: true, users: [] },
        timestamp: event.timestamp || Date.now(),
        raw: event.raw,
        kind: "create",
      }
      try {
        await this.dispatchInboundFull(synthetic)
      } catch (err) {
        await appendAudit({
          adapterId: event.adapterId,
          kind: "callback.handler_failed",
          at: Date.now(),
          conversationKey: convKey,
          reason: err instanceof Error ? err.name : "unknown",
          message: err instanceof Error ? err.message : String(err),
          fields: { triggerId: event.triggerId, kind: "help_quick_command" },
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

  /**
   * Read an adapter's A2UI component-support matrix
   * (`PlatformAdapter.a2uiCapability`) — the per-component-kind
   * `native`/`simulated`/`fallback`/`unsupported` table the assistant and
   * platform mappers use to decide how a surface degrades. Returns `null`
   * when no adapter with that id is registered, so callers can pick a
   * rendering strategy (rich card vs. plain-text mirror) per platform
   * without holding the live adapter.
   */
  getAdapterA2UICapability(adapterId: string): A2UICapabilityMatrix | null {
    const a = this.adapters.get(adapterId)
    return a ? a.a2uiCapability() : null
  }

  /**
   * Read which built-in skill families an adapter can serve on its channel
   * (`PlatformAdapter.platformSkillCapabilities`, e.g. `lark.calendar`
   * read+write). Returns `null` when no adapter with that id is registered
   * and `[]` when the adapter does not declare any — so callers can tell
   * "unknown adapter" apart from "adapter with no skill families".
   */
  getAdapterSkillCapabilities(adapterId: string): readonly PlatformSkillCapability[] | null {
    const a = this.adapters.get(adapterId)
    if (!a) return null
    return a.platformSkillCapabilities ? a.platformSkillCapabilities() : []
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
