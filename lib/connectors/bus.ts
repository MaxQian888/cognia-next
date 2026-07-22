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
  ForwardMessageInput,
  ReadReceipt,
  UrgentChannel,
} from "@/types/connectors"
import type { PlatformSkillCapability } from "@/types/connectors/skill-capability"
import type { StoredMessage } from "@cognia/agent-config-types"
import type {
  ConversationOverrideRow,
  AdapterInstanceRow,
  ConnectorInboundJobRow,
} from "@/lib/db/connector-types"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { readForResolution, setStatus, setSlaDue } from "@/lib/db/conversation-overrides"
import { computeDueAt } from "@/lib/connectors/sla"
import { upsertIdentity } from "@/lib/db/platform-identities"
import { getCharacter } from "@/lib/db/characters"
import { getDb } from "@/lib/db/schema"
import { recordAndCheckInbound, isRecordedInbound } from "./dedup"
import { resolveCallbackBinding } from "./adapters/_shared/a2ui-mapper"
import { appendAudit } from "./audit"
import { runInboundOcr, hasOcrableInboundImage } from "./inbound-ocr"
import { evaluatePolicy, type PolicyEvalState } from "./policy-eval"
import { resolveBinding, type ResolvedBinding } from "./policy-resolve"
import { routeInbound, type RouteDecision } from "./mode-router"
import { dispatchTrigger } from "@/lib/workflow/runtime/trigger-bridge"
import { findMatchingWorkflows } from "@/lib/workflow/runtime/trigger-subscriptions"
import { trackInboxEvent } from "@/lib/telemetry/inbox-events"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { maybeHandleHelpCommand, maybeSendWelcome } from "./help/help-dispatch"
import { maybeHandleControlCommand } from "./commands/dispatch"
import { parseControlCommand } from "./commands/parse"
import { parseConversationKey } from "@/types/connectors/event"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { segmentsToPlainText, type MessageSegment } from "@/types/connectors/segment"
import {
  claimConnectorInboundJob,
  bindConnectorInboundJobExecutionRun,
  completeConnectorInboundJob,
  ensureConnectorInboundJob,
  listRecoverableConnectorInboundJobs,
  markConnectorInboundJobHistoryOnly,
  markConnectorInboundJobRecoveryRequired,
  recoverStaleConnectorInboundJobs,
  updateConnectorInboundJobPayload,
} from "@/lib/db/connector-inbound-jobs"
import { admitConversationEvent } from "./conversation-admission"
import { observeUnmentionedDeliveryProbe } from "./at-gate"
import { deliveryTargetFromEvent } from "@/types/connectors/event"
import { refreshConnectorConversationDeliveryTarget } from "@/lib/db/connector-conversation-state"

export interface BusInboundHandler {
  (event: NormalizedInboundEvent): Promise<void>
}

export interface RouteHandlerContext {
  inboundJobId: string
  bindExecutionRun(executionRunId: string): Promise<void>
}

export interface LiveSteerResult {
  activeRun: boolean
  accepted: boolean
  executionRunId?: string
}

export type LiveSteerHandler = (event: NormalizedInboundEvent) => Promise<LiveSteerResult>

/**
 * Called by the runtime (Task 37) to handle the final routing decision.
 *
 * `override` and `adapterRow` are the rows the bus already fetched in
 * `dispatchInboundFull` (Steps 2 & 3). They are passed through so the
 * runtime's ai-run path doesn't re-read the same immutable rows from Dexie —
 * `adapterRow` is guaranteed non-null (the bus returns early on a missing
 * adapter instance), `override` is null when the conversation has none.
 */
export type RouteHandler = (
  event: NormalizedInboundEvent,
  decision: RouteDecision,
  resolved: ResolvedBinding,
  override: ConversationOverrideRow | null,
  adapterRow: AdapterInstanceRow,
  context: RouteHandlerContext
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

/**
 * Retention window for the per-conversation last-bot-reply timestamp used by
 * the `cooldown-after-bot-reply` blocker. Entries older than this are pruned on
 * write. 10 minutes comfortably exceeds any realistic cooldown (the default is
 * 3 s) while keeping the map bounded across long-lived sessions.
 */
const BOT_REPLY_RETENTION_MS = 10 * 60_000

/**
 * Sliding window the `rate-limit` blocker evaluates over
 * (`policy-eval.ts:checkBlocker`). The per-user/channel buckets are pruned to
 * this window on every write so `policyState.recentByUserAndChannel` stays
 * bounded across long-lived sessions.
 */
const RATE_BUCKET_WINDOW_MS = 60_000

/**
 * Max queued-or-running route-handler turns per conversation. A conversation
 * whose turns cannot drain (wedged handler, message flood) drops further
 * inbound turns with an `adapter.error` / `turn_queue_overflow` audit instead
 * of queueing unboundedly.
 */
const MAX_TURN_QUEUE_DEPTH = 100
const INBOUND_JOB_LEASE_MS = 20 * 60_000

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
  /** Optional safe live-injection bridge supplied by an active runtime. */
  liveSteerHandler: LiveSteerHandler | null = null
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

  /**
   * Per-conversation FIFO of route-handler turns. The route handler runs the
   * ENTIRE model turn (minutes), so it is chained here and NOT awaited by
   * `dispatchInboundFull` — see `enqueueRouteHandlerTurn`. Entries are removed
   * when their tail settles, so the map stays bounded by the number of
   * conversations with in-flight turns.
   */
  private turnQueues = new Map<string, { tail: Promise<void>; depth: number }>()

  /**
   * Trigger ids currently being processed by `dispatchConnectorCallback`.
   * The persistent ledger is only written on a terminal outcome (so transient
   * failures stay retryable); this set guards against a double-fire arriving
   * while the first delivery is still in flight.
   */
  private callbackInFlight = new Set<string>()

  /**
   * Record that the bot delivered a reply on `conversationKey` at `at`.
   *
   * This is the sole writer of `policyState.recentBotReplyAtByConversation`,
   * which the `cooldown-after-bot-reply` trigger blocker reads. That blocker is
   * part of the default group-chat policy (`defaultGroupChatPolicy`), so without
   * this write the group anti-spam cooldown never fired. Production wires this
   * to the outbound runner's `onDelivered` callback so it covers every reply
   * path (ai-run / team / workflow / digest) at the single delivery choke point.
   *
   * Prunes entries older than the largest plausible cooldown window on write so
   * the map cannot grow without bound across long-lived sessions.
   */
  recordBotReply(conversationKey: string, at: number = Date.now()): void {
    const map = this.policyState.recentBotReplyAtByConversation
    map[conversationKey] = at
    const cutoff = at - BOT_REPLY_RETENTION_MS
    for (const key in map) {
      if (map[key] < cutoff) delete map[key]
    }
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
   *
   * Error containment: adapters call this from their transport for-await
   * loop (`ctx.emit`), so an exception escaping here would kill the
   * transport permanently. Any pipeline failure is audited and swallowed.
   *
   * The final route-handler step (the model turn) is enqueued per
   * conversation and NOT awaited — callers get control back as soon as the
   * synchronous pipeline (dedup → policy → mode-route → control-commands →
   * audit → workflow fan-out) settles. Tests that assert on turn
   * side-effects must `await flushInboundTurns()` after dispatching.
   */
  async dispatchInboundFull(event: NormalizedInboundEvent): Promise<void> {
    try {
      await this.runInboundPipeline(event)
    } catch (err) {
      console.error("[connector-bus] inbound pipeline failed", err)
      await appendAudit({
        adapterId: event.adapterId,
        kind: "adapter.error",
        at: Date.now(),
        conversationKey: event.conversationKey,
        reason: "inbound_pipeline_failed",
        message: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined)
    }
  }

  /** Execute a reconnect catch-up event while evaluating sliding expiry at its wire timestamp. */
  async dispatchBackfilledInbound(event: NormalizedInboundEvent): Promise<void> {
    try {
      await this.runInboundPipeline(event, undefined, { admissionNow: event.timestamp })
    } catch (err) {
      await appendAudit({
        adapterId: event.adapterId,
        kind: "adapter.error",
        at: Date.now(),
        conversationKey: event.conversationKey,
        reason: "history_catchup_failed",
        message: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined)
    }
  }

  async recoverActiveConversationHistory(): Promise<{
    conversations: number
    executed: number
    historyOnly: number
  }> {
    const { recoverActiveConversationHistory } = await import("./history-recovery")
    return recoverActiveConversationHistory(this)
  }

  /**
   * Reclaim durable work that was inserted but never started before a restart.
   * Expired running leases are deliberately converted to `recovery_required`
   * and are not replayed because model/tool side effects may already exist.
   */
  async resumeDurableInboundJobs(
    options: { reclaimRunning?: boolean } = {}
  ): Promise<{ resumed: number; recoveryRequired: number }> {
    const recoveryRequired = options.reclaimRunning
      ? await recoverStaleConnectorInboundJobs({ reclaimAllRunning: true })
      : 0
    const jobs = await listRecoverableConnectorInboundJobs()
    for (const job of jobs) {
      try {
        await this.runInboundPipeline(job.event, job)
      } catch (err) {
        await appendAudit({
          adapterId: job.adapterId,
          kind: "adapter.error",
          at: Date.now(),
          conversationKey: job.conversationKey,
          reason: "inbound_recovery_failed",
          message: err instanceof Error ? err.message : String(err),
          fields: { inboundJobId: job.id },
        }).catch(() => undefined)
      }
    }
    return { resumed: jobs.length, recoveryRequired }
  }

  private async runInboundPipeline(
    event: NormalizedInboundEvent,
    recoveredJob?: ConnectorInboundJobRow,
    context: { admissionNow?: number } = {}
  ): Promise<void> {
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

    // ── Step 1: durable insert, then compatibility ledger ────────────────────
    // The job is the authoritative dedup record. It is committed before the
    // legacy inbound ledger so a crash in the old breadcrumb path cannot lose
    // the message. Its unique identity is conversation-scoped because several
    // platforms only guarantee message ids within one chat.
    let inboundJob = recoveredJob
    if (!inboundJob) {
      const ensured = await ensureConnectorInboundJob(event, "queue", { now })
      inboundJob = ensured.job
      if (!ensured.inserted) {
        await appendAudit({
          adapterId: event.adapterId,
          kind: "inbound.deduped",
          at: now,
          conversationKey: event.conversationKey,
        })
        return
      }
      // Preserve the old ledger for edit/delete lookup and observability. Its
      // boolean is intentionally ignored: a legacy ledger row without a v120
      // job represents the historical crash window and must be recoverable.
      await recordAndCheckInbound(
        event.adapterId,
        event.messageId,
        "inbound",
        event.conversationKey
      )
    }
    if (!inboundJob) {
      await appendAudit({
        adapterId: event.adapterId,
        kind: "adapter.error",
        at: now,
        conversationKey: event.conversationKey,
        reason: "inbound_job_missing",
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
    void trackEvent("connector.message.received", {
      adapterId: event.adapterId,
      platform: event.platform,
    })

    // ── Step 1.5: eager OCR of inbound images (ADR-0024) ─────────────────────
    // Attaches `ocrText` to image segments that carry inline bytes, so trigger
    // matching (Step 6), the stored message, the agent prompt, and the digest
    // all see the image's text. Best-effort — never blocks delivery. Gated on
    // an OCR-able image so a text-only / URL-only message skips the settings
    // read + dep build entirely (the common case).
    if (hasOcrableInboundImage(event.segments)) {
      await runInboundOcr(event).catch(() => undefined)
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
    await refreshConnectorConversationDeliveryTarget(deliveryTargetFromEvent(event), {
      deliveryReadiness: adapterRow.deliveryReadiness ?? "unknown",
      now,
    })
    if (await observeUnmentionedDeliveryProbe(event.adapterId, event, adapterRow)) {
      await markConnectorInboundJobHistoryOnly(inboundJob.id, "delivery_probe_observed", { now })
      return
    }

    // ── Step 3: conversation override lookup ──────────────────────────────────
    const override = (await readForResolution(event.conversationKey)) ?? null
    const dispatchMode =
      override?.activeRunDispatchMode ?? adapterRow.activeRunDispatchMode ?? "queue"

    // ── Step 3.1: conversation-aware admission ──────────────────────────────
    // This runs after the durable insert so ignored messages remain auditable,
    // and after override resolution so a topic can override adapter defaults.
    const parsedControl = parseControlCommand(event.plainText)
    const admission =
      parsedControl.kind === "known"
        ? { allowed: true, activated: false }
        : await admitConversationEvent(event, adapterRow, {
            now: context.admissionNow ?? now,
            override,
          })
    if (!admission.allowed) {
      await markConnectorInboundJobHistoryOnly(inboundJob.id, admission.reason ?? "not_admitted", {
        now,
      })
      await appendAudit({
        adapterId: event.adapterId,
        kind: "inbound.policy_blocked",
        at: now,
        conversationKey: event.conversationKey,
        reason: admission.reason,
      })
      return
    }

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

    // ── Steps 3.6 / 3.7 / 4: SLA deadline, identity directory, character ──────
    // These three touch distinct Dexie tables (conversationOverrides /
    // platformIdentities / characters) and have no inter-dependency, so they
    // run concurrently. Step 3.5's lifecycle reopen above stays sequential —
    // it shares the override row with the SLA write, so it must settle first.
    //   • 3.6 response-SLA deadline (v83): stamp next-response deadline so the
    //     inbox SlaBadge can count down; quiet hours excluded (computeDueAt
    //     reuses the outbound-runner math). No-op when no SLA is configured.
    //   • 3.7 platform-identity directory (v83): record the sender for the
    //     contact-profile drawer + cross-platform identity merge.
    //   • 4 character lookup: only this result feeds downstream binding.
    // All three are best-effort — a write/read failure must never break the
    // inbound pipeline.
    const charId = override?.characterId ?? adapterRow.defaultCharacterId
    const [, , character] = await Promise.all([
      override?.slaResponseMinutes && override.slaResponseMinutes > 0
        ? setSlaDue(
            event.conversationKey,
            {
              nextResponseDueAt: computeDueAt(
                now,
                override.slaResponseMinutes,
                override.quietHours ?? null
              ),
            },
            override.sessionId
          ).catch(() => undefined)
        : Promise.resolve(undefined),
      upsertIdentity({
        platform: event.platform,
        adapterId: event.adapterId,
        remoteUserId: event.sender.remoteUserId,
        displayName: event.sender.displayName,
        avatarUrl: event.sender.avatarUrl,
      }).catch(() => undefined),
      charId ? getCharacter(charId).then((c) => c ?? null) : Promise.resolve(null),
    ])

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
        await markConnectorInboundJobHistoryOnly(inboundJob.id, "plugin_blocked", { now })
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

    event = {
      ...event,
      channelData: {
        ...event.channelData,
        activeRunDispatchMode: dispatchMode,
      },
    }
    await updateConnectorInboundJobPayload(inboundJob.id, event, dispatchMode, { now })

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
      // Update the rate-limit bucket, pruning on write to the 60 s window the
      // `rate-limit` blocker evaluates (mirrors recordBotReply's prune-on-write)
      // so the map cannot grow without bound across long-lived sessions.
      const map = this.policyState.recentByUserAndChannel
      const bucketKey = `${event.sender.id}:${event.channel.id}`
      const cutoff = now - RATE_BUCKET_WINDOW_MS
      map[bucketKey] = [...(map[bucketKey] ?? []).filter((t) => t > cutoff), now]
      for (const key in map) {
        if (key === bucketKey) continue
        const kept = map[key].filter((t) => t > cutoff)
        if (kept.length === 0) delete map[key]
        else if (kept.length !== map[key].length) map[key] = kept
      }
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

    if (decision === "drop" || evalResult.blocked) {
      await markConnectorInboundJobHistoryOnly(
        inboundJob.id,
        evalResult.blocked ? "policy_blocked" : "routing_dropped",
        { now }
      )
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
          await completeConnectorInboundJob(inboundJob.id, { now: Date.now() })
          return
        }
        if (await maybeHandleHelpCommand(event, adapterRow)) {
          await completeConnectorInboundJob(inboundJob.id, { now: Date.now() })
          return
        }
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

    // ── Step 10: route handler (enqueued per conversation, NOT awaited) ──────
    // Thread the already-fetched adapter + override rows so the runtime's
    // ai-run path reuses them instead of re-reading the same immutable rows.
    //
    // The route handler runs the ENTIRE model turn (up to the 15-min connector
    // turn timeout). Awaiting it here held the adapter's transport for-await
    // loop hostage: when an ask-tier tool suspended the turn on a HITL
    // approval, the user's Allow click arrived as another envelope on the SAME
    // blocked loop, so the approval could only be processed after the TTL
    // auto-deny — and one slow turn head-of-line-blocked every other
    // conversation on the adapter. Chaining the turn onto a per-conversation
    // FIFO preserves same-conversation ordering, lets other conversations run
    // in parallel, and frees the loop so `dispatchConnectorCallback` (approval
    // clicks) executes while a turn is suspended.
    if (this.routeHandler && decision !== "drop") {
      await this.enqueueRouteHandlerTurn(
        inboundJob.id,
        event,
        decision,
        resolved,
        override,
        adapterRow
      )
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
    if (!this.routeHandler && decision !== "drop" && !evalResult.blocked) {
      await completeConnectorInboundJob(inboundJob.id, { now: Date.now() })
    }
  }

  /**
   * Chain a route-handler turn onto the conversation's FIFO. Depth is capped
   * at {@link MAX_TURN_QUEUE_DEPTH}; beyond it the turn is dropped with an
   * `adapter.error` / `turn_queue_overflow` audit. Queue entries are deleted
   * once their tail settles so the map stays bounded.
   */
  private async enqueueRouteHandlerTurn(
    inboundJobId: string,
    event: NormalizedInboundEvent,
    decision: RouteDecision,
    resolved: ResolvedBinding,
    override: ConversationOverrideRow | null,
    adapterRow: AdapterInstanceRow
  ): Promise<boolean> {
    const key = event.conversationKey
    let queue = this.turnQueues.get(key)
    if (!queue) {
      queue = { tail: Promise.resolve(), depth: 0 }
      this.turnQueues.set(key, queue)
    }
    if (queue.depth >= MAX_TURN_QUEUE_DEPTH) {
      void appendAudit({
        adapterId: event.adapterId,
        kind: "adapter.error",
        at: Date.now(),
        conversationKey: key,
        reason: "turn_queue_overflow",
        message: `retained inbound message ${event.messageId} as history-only (${queue.depth} turns queued)`,
      }).catch(() => undefined)
      await markConnectorInboundJobHistoryOnly(inboundJobId, "pending_limit_exceeded")
      return false
    }
    const wantsLiveSteer =
      queue.depth > 0 &&
      event.channelData?.activeRunDispatchMode === "steer" &&
      this.liveSteerHandler !== null
    const liveSteerPayloadSafe =
      !wantsLiveSteer ||
      hasNoLeakingPiiDeep({ plainText: event.plainText, segments: event.segments })
    if (wantsLiveSteer && liveSteerPayloadSafe && this.liveSteerHandler) {
      const liveSteer = await this.liveSteerHandler(event)
      if (liveSteer.accepted) {
        await completeConnectorInboundJob(inboundJobId, {
          executionRunId: liveSteer.executionRunId,
          now: Date.now(),
        })
        await appendAudit({
          adapterId: event.adapterId,
          kind: "inbound.received",
          at: Date.now(),
          conversationKey: key,
          reason: "inbound_live_steered",
          fields: { inboundJobId, executionRunId: liveSteer.executionRunId },
        }).catch(() => undefined)
        return true
      }
      if (liveSteer.activeRun) {
        event = {
          ...event,
          channelData: { ...event.channelData, dispatchIntent: "steer-replay" },
        }
        await updateConnectorInboundJobPayload(inboundJobId, event, "steer")
      }
    } else if (queue.depth > 0 && event.channelData?.activeRunDispatchMode === "steer") {
      if (wantsLiveSteer && !liveSteerPayloadSafe) {
        await appendAudit({
          adapterId: event.adapterId,
          kind: "inbound.policy_blocked",
          at: Date.now(),
          conversationKey: key,
          reason: "live_steer_pii_blocked",
          fields: { inboundJobId },
        }).catch(() => undefined)
      }
      event = {
        ...event,
        channelData: { ...event.channelData, dispatchIntent: "steer-replay" },
      }
      await updateConnectorInboundJobPayload(inboundJobId, event, "steer")
    }
    const isFirst = queue.depth === 0
    queue.depth += 1
    const previousTail = queue.tail
    const started = isFirst
      ? this.startRouteHandlerTurn(inboundJobId, event, decision, resolved, override, adapterRow)
      : undefined
    const completion = started
      ? started.then((turn) => turn.completion)
      : previousTail.then(() =>
          this.runRouteHandlerTurn(inboundJobId, event, decision, resolved, override, adapterRow)
        )
    const step: Promise<void> = completion.then(() => {
      // `runRouteHandlerTurn` never rejects (it audits internally), so this
      // cleanup always runs. Delete the entry only when this step is still
      // the mapped tail — a later enqueue must not lose its queue.
      if (this.turnQueues.get(key) !== queue) return
      queue.depth -= 1
      if (queue.depth === 0 && queue.tail === step) this.turnQueues.delete(key)
    })
    queue.tail = step
    // For the head turn, wait only until the durable claim has completed and
    // the handler has been invoked. Long model/tool work remains detached so
    // callback envelopes can still arrive on the adapter transport.
    if (started) await started
    return true
  }

  /** Claim and invoke one turn without waiting for a long-running handler. */
  private async startRouteHandlerTurn(
    inboundJobId: string,
    event: NormalizedInboundEvent,
    decision: RouteDecision,
    resolved: ResolvedBinding,
    override: ConversationOverrideRow | null,
    adapterRow: AdapterInstanceRow
  ): Promise<{ completion: Promise<void> }> {
    const claimed = await claimConnectorInboundJob(inboundJobId, {
      leaseOwner: `connector-bus:${crypto.randomUUID()}`,
      leaseMs: INBOUND_JOB_LEASE_MS,
    })
    if (!claimed) return { completion: Promise.resolve() }
    const handler = this.routeHandler
    try {
      const context: RouteHandlerContext = {
        inboundJobId,
        bindExecutionRun: async (executionRunId) => {
          const bound = await bindConnectorInboundJobExecutionRun(inboundJobId, executionRunId)
          if (!bound) throw new Error(`Inbound job ${inboundJobId} is no longer running`)
        },
      }
      const result = handler?.(event, decision, resolved, override, adapterRow, context)
      if (!result || typeof (result as Promise<void>).then !== "function") {
        await completeConnectorInboundJob(inboundJobId, { now: Date.now() })
        return { completion: Promise.resolve() }
      }
      return {
        completion: Promise.resolve(result).then(
          async () => {
            await completeConnectorInboundJob(inboundJobId, { now: Date.now() })
          },
          async (err: unknown) => {
            await this.handleRouteHandlerFailure(inboundJobId, event, err)
          }
        ),
      }
    } catch (err) {
      await this.handleRouteHandlerFailure(inboundJobId, event, err)
      return { completion: Promise.resolve() }
    }
  }

  /** Run one queued turn; a throwing route handler is audited, never rethrown. */
  private async runRouteHandlerTurn(
    inboundJobId: string,
    event: NormalizedInboundEvent,
    decision: RouteDecision,
    resolved: ResolvedBinding,
    override: ConversationOverrideRow | null,
    adapterRow: AdapterInstanceRow
  ): Promise<void> {
    const { completion } = await this.startRouteHandlerTurn(
      inboundJobId,
      event,
      decision,
      resolved,
      override,
      adapterRow
    )
    await completion
  }

  private async handleRouteHandlerFailure(
    inboundJobId: string,
    event: NormalizedInboundEvent,
    err: unknown
  ): Promise<void> {
    console.error("[connector-bus] route handler failed", err)
    await appendAudit({
      adapterId: event.adapterId,
      kind: "adapter.error",
      at: Date.now(),
      conversationKey: event.conversationKey,
      reason: "route_handler_failed",
      message: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined)
    await markConnectorInboundJobRecoveryRequired(inboundJobId, "route_handler_failed", {
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined)
  }

  /**
   * Resolve once every queued route-handler turn has settled. Loops until the
   * queue map quiesces because a running turn may enqueue another (e.g. the
   * `help_quick_command` synthetic re-entry). Used by tests that assert on
   * turn side-effects after `dispatchInboundFull`, and safe to call from any
   * shutdown path that wants to drain in-flight turns.
   */
  async flushInboundTurns(): Promise<void> {
    while (this.turnQueues.size > 0) {
      await Promise.all(Array.from(this.turnQueues.values(), (q) => q.tail))
    }
  }

  /**
   * Locate the StoredMessage a platform edit/delete event targets, via the
   * v49 `platformMessageId` index.
   *
   * Rows written after the platformMessage scoping fix carry `adapterId` +
   * `conversationKey` inside `metadata.platformMessage`; both must match the
   * event, because per-chat message ids (Telegram `message_id`, Slack `ts`)
   * collide across chats and multi-bot setups collide across adapter
   * instances — a platform-only match could rewrite the WRONG chat's message.
   *
   * Backward compat: legacy rows carry only {messageId, platform, sender},
   * so requiring the event's adapterId against them is impossible (the row
   * never stored one) — they keep the historical platform-only match, which
   * is their strongest available scoping. When both a scoped and a legacy
   * row match, the fully-scoped row wins.
   */
  private async findStoredPlatformMessage(
    event: NormalizedInboundEvent,
    replaces: string
  ): Promise<StoredMessage | undefined> {
    const candidates = await getDb()
      .messages.where("platformMessageId")
      .equals(replaces)
      .filter((m) => {
        const pm = m.metadata?.platformMessage
        if (!pm || pm.platform !== event.platform) return false
        if (pm.adapterId !== undefined && pm.adapterId !== event.adapterId) return false
        if (pm.conversationKey !== undefined && pm.conversationKey !== event.conversationKey) {
          return false
        }
        return true
      })
      .toArray()
    return (
      candidates.find((m) => m.metadata?.platformMessage?.adapterId === event.adapterId) ??
      candidates[0]
    )
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
    // Indexed lookup, scoped by adapterId + conversationKey (with a legacy
    // platform-only fallback) — see `findStoredPlatformMessage`.
    const db = getDb()
    const target = await this.findStoredPlatformMessage(event, replaces)
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
    // Indexed lookup, scoped by adapterId + conversationKey (with a legacy
    // platform-only fallback) — see `findStoredPlatformMessage`.
    const db = getDb()
    const target = await this.findStoredPlatformMessage(event, replaces)
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
    else if (
      sk === "reaction_added" ||
      sk === "reaction_removed" ||
      sk === "poke" ||
      sk === "request" ||
      sk === "lifecycle"
    ) {
      // Declared systemKinds that arrive on every user gesture. They carry no
      // message body and the closed AuditKind union has no reaction/poke kind;
      // routing them to `adapter.error` (as the pre-fix code did) flooded the
      // audit trail with a false error per emoji reaction. Deliberate silent
      // no-op until a dedicated audit kind ships in types/connectors/audit.ts.
      return
    } else {
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
    // Lark chat-member/bot events carry `external:true` when the chat is a
    // cross-tenant (external) group. Surface it in the audit so an operator
    // can tell an external group was joined/left; absent (or non-boolean) on
    // every other platform, so it is only included when actually present.
    const rawExternal = (event.raw as { event?: { external?: boolean } } | undefined)?.event
      ?.external
    await appendAudit({
      adapterId: event.adapterId,
      kind,
      at: now,
      conversationKey: event.conversationKey,
      fields: {
        actorOpenId: event.sender.remoteUserId,
        rawType: (event.raw as { header?: { event_type?: string } } | undefined)?.header
          ?.event_type,
        ...(typeof rawExternal === "boolean" ? { external: rawExternal } : {}),
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
        // Fine-grained trigger filters (senderIds / channelKinds /
        // keywords / requireMention on the trigger node) match on these.
        senderId: event.sender.remoteUserId,
        channelKind: event.channel.kind,
        plainText: event.plainText,
        selfMentioned: event.mentions.selfMentioned,
      })
    } catch (err) {
      // A broken subscription index would otherwise silently disable the
      // entire workflow fan-out — warn + audit so the operator can see it.
      console.warn("[connector-bus] findMatchingWorkflows failed", err)
      await appendAudit({
        adapterId: event.adapterId,
        kind: "adapter.error",
        at: Date.now(),
        conversationKey: event.conversationKey,
        reason: "workflow_match_failed",
        message: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined)
      return
    }
    if (matches.length === 0) return

    const originAt = Date.now()
    const dispatches = matches.map(async (m) => {
      try {
        await dispatchTrigger({
          workflowId: m.workflowId,
          kind: "trigger.connector.inbound",
          triggerId: m.nodeId,
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
      const result: OutboundResult = {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
      void trackEvent("connector.message.sent", {
        adapterId,
        platform: "unknown",
        outcome: "failed",
        errorCode: result.error?.code ?? "adapter_not_found",
      })
      return result
    }
    try {
      const result = await a.send(req)
      void trackEvent("connector.message.sent", {
        adapterId,
        platform: a.meta.type,
        outcome: result.ok ? "succeeded" : "failed",
        ...(!result.ok && result.error?.code ? { errorCode: result.error.code } : {}),
      })
      return result
    } catch (error) {
      void trackEvent("connector.message.sent", {
        adapterId,
        platform: a.meta.type,
        outcome: "failed",
        errorCode: error instanceof Error ? error.name : "Error",
      })
      throw error
    }
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
   * Add an emoji reaction to an already-sent message through an adapter
   * that supports it (`PlatformAdapter.addReaction`). Mirrors
   * {@link deleteOutbound}: returns a uniform `{ ok }` result instead of
   * throwing on a missing adapter / unsupported platform.
   */
  async addReactionOutbound(
    adapterId: string,
    messageId: string,
    emojiType: string
  ): Promise<OutboundResult & { reactionId?: string }> {
    const a = this.adapters.get(adapterId)
    if (!a) {
      return {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
    }
    if (!a.addReaction) {
      return {
        ok: false,
        error: { code: "unsupported", message: "adapter cannot add reactions", retryable: false },
      }
    }
    const ref = await a.addReaction(messageId, emojiType)
    // Surface the platform reaction id (when the adapter returns one) so a
    // caller can later `removeReactionOutbound` exactly this reaction.
    return { ok: true, ...(ref && ref.reactionId ? { reactionId: ref.reactionId } : {}) }
  }

  /**
   * Remove a previously added reaction by its platform reaction id (from the
   * `reactionId` of a prior {@link addReactionOutbound}). Mirrors
   * {@link deleteOutbound}'s uniform `{ ok }` result.
   */
  async removeReactionOutbound(
    adapterId: string,
    messageId: string,
    reactionId: string
  ): Promise<OutboundResult> {
    const a = this.adapters.get(adapterId)
    if (!a) {
      return {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
    }
    if (!a.removeReaction) {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "adapter cannot remove reactions",
          retryable: false,
        },
      }
    }
    await a.removeReaction(messageId, reactionId)
    return { ok: true }
  }

  /**
   * Forward an existing message (or merge-forward several) to another
   * conversation through an adapter that supports it
   * (`PlatformAdapter.forwardMessage`). Returns the adapter's own
   * `{ ok, platformMessageId, error }` result, or a uniform unsupported /
   * not-found error.
   */
  async forwardOutbound(adapterId: string, input: ForwardMessageInput): Promise<OutboundResult> {
    const a = this.adapters.get(adapterId)
    if (!a) {
      return {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
    }
    if (!a.forwardMessage) {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "adapter cannot forward messages",
          retryable: false,
        },
      }
    }
    return a.forwardMessage(input)
  }

  /**
   * Pin a message through an adapter that supports it
   * (`PlatformAdapter.pinMessage`). Mirrors {@link deleteOutbound}.
   */
  async pinOutbound(
    adapterId: string,
    conversationKey: string,
    messageId: string
  ): Promise<OutboundResult> {
    const a = this.adapters.get(adapterId)
    if (!a) {
      return {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
    }
    if (!a.pinMessage) {
      return {
        ok: false,
        error: { code: "unsupported", message: "adapter cannot pin messages", retryable: false },
      }
    }
    await a.pinMessage(conversationKey, messageId)
    return { ok: true }
  }

  /**
   * Remove a previously pinned message through an adapter that supports it
   * (`PlatformAdapter.unpinMessage`). Mirrors {@link deleteOutbound}.
   */
  async unpinOutbound(adapterId: string, messageId: string): Promise<OutboundResult> {
    const a = this.adapters.get(adapterId)
    if (!a) {
      return {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
    }
    if (!a.unpinMessage) {
      return {
        ok: false,
        error: { code: "unsupported", message: "adapter cannot unpin messages", retryable: false },
      }
    }
    await a.unpinMessage(messageId)
    return { ok: true }
  }

  /**
   * Escalate a message to users via an urgent channel (加急) through an
   * adapter that supports it (`PlatformAdapter.sendUrgent`). Mirrors
   * {@link deleteOutbound}; a missing platform scope surfaces as a throw the
   * caller maps to `platform_error`.
   */
  async sendUrgentOutbound(
    adapterId: string,
    messageId: string,
    userIds: string[],
    via?: UrgentChannel
  ): Promise<OutboundResult> {
    const a = this.adapters.get(adapterId)
    if (!a) {
      return {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
    }
    if (!a.sendUrgent) {
      return {
        ok: false,
        error: { code: "unsupported", message: "adapter cannot send urgent", retryable: false },
      }
    }
    try {
      await a.sendUrgent(messageId, userIds, via)
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "platform_error",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      }
    }
  }

  /**
   * Query read receipts for a message through an adapter that supports it
   * (`PlatformAdapter.getReadReceipt`). Returns `null` when the adapter is
   * missing or the platform has no read-user surface (feature-detect).
   */
  async getReadReceiptOutbound(adapterId: string, messageId: string): Promise<ReadReceipt | null> {
    const a = this.adapters.get(adapterId)
    if (!a || !a.getReadReceipt) return null
    return a.getReadReceipt(messageId)
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
   * transport loop; an unexpected pipeline exception is likewise contained
   * (audited as `adapter.error`) — adapters call this from their transport
   * for-await loop, so nothing may escape.
   *
   * Dedup commit protocol: the triggerId is checked up front but only
   * COMMITTED to the persistent ledger on a terminal outcome (success or
   * permanent failure). A transient failure — the binding lookup threw on a
   * Dexie hiccup — leaves it unrecorded so the platform's redelivery can
   * retry the click instead of losing it forever. Double-fire while the
   * first delivery is still processing is guarded by the in-memory
   * `callbackInFlight` set.
   */
  async dispatchConnectorCallback(event: ConnectorCallbackEvent): Promise<void> {
    const flightKey = `${event.adapterId}:${event.triggerId}`
    try {
      // ── Step 1: Dedup (check now, commit on terminal outcome) ──────
      const duplicate =
        this.callbackInFlight.has(flightKey) ||
        (await isRecordedInbound(event.adapterId, event.triggerId, "callback"))
      if (duplicate) {
        await appendAudit({
          adapterId: event.adapterId,
          kind: "callback.deduped",
          at: Date.now(),
          conversationKey: event.conversationKey,
          reason: "callback:duplicate",
          message: `triggerId=${event.triggerId}`,
          fields: { actionType: event.actionType },
        })
        return
      }
      this.callbackInFlight.add(flightKey)
      // Terminal by default: an unexpected throw below still commits the
      // triggerId (re-processing an exploding callback forever helps nobody)
      // and is audited by the outer catch.
      let terminal = true
      try {
        terminal = await this.runConnectorCallback(event)
      } finally {
        if (terminal) {
          await recordAndCheckInbound(event.adapterId, event.triggerId, "callback").catch(
            () => undefined
          )
        }
        this.callbackInFlight.delete(flightKey)
      }
    } catch (err) {
      console.error("[connector-bus] callback pipeline failed", err)
      await appendAudit({
        adapterId: event.adapterId,
        kind: "adapter.error",
        at: Date.now(),
        conversationKey: event.conversationKey,
        reason: "callback_pipeline_failed",
        message: err instanceof Error ? err.message : String(err),
        fields: { triggerId: event.triggerId },
      }).catch(() => undefined)
    }
  }

  /**
   * Callback pipeline body (Steps 2-4). Returns whether the outcome is
   * TERMINAL — `true` commits the triggerId to the dedup ledger, `false`
   * (transient failure) leaves it retryable for a platform redelivery.
   */
  private async runConnectorCallback(event: ConnectorCallbackEvent): Promise<boolean> {
    const now = Date.now()

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
    } catch (err) {
      // TRANSIENT: a Dexie hiccup here says nothing about the click itself.
      // Falling through on the event's self-reported fields would take a
      // kind-specific binding (tool_approve, wf_approve, …) down the generic
      // handler path AND permanently consume the triggerId — so instead we
      // bail WITHOUT committing the dedup record, letting the platform's
      // redelivery retry the click.
      await appendAudit({
        adapterId: event.adapterId,
        kind: "adapter.error",
        at: now,
        conversationKey: resolvedConversationKey ?? undefined,
        reason: "callback_binding_lookup_failed",
        message: err instanceof Error ? err.message : String(err),
        fields: { triggerId: event.triggerId },
      }).catch(() => undefined)
      return false
    }

    // Durable Execution Run controls are self-describing CardKit/Slack actions.
    // The actor comes from the signed platform callback envelope; values inside
    // the card are used only for the run/action target and optimistic revision.
    const runId = typeof event.payload?.runId === "string" ? event.payload.runId : ""
    const runAction = typeof event.payload?.action === "string" ? event.payload.action : ""
    const runRevision = Number(event.payload?.revision)
    if (runId && Number.isInteger(runRevision)) {
      const allowedActions = new Set([
        "stop",
        "pause",
        "resume",
        "approve",
        "deny",
        "retry",
        "open_details",
      ])
      if (allowedActions.has(runAction)) {
        // Return to the transport immediately so CardKit can ACK well inside
        // its three-second deadline. Durable execution and card refresh happen
        // asynchronously from the journal update.
        void (async () => {
          try {
            const [{ executeRunControlCommand }, adapterRow] = await Promise.all([
              import("@/lib/execution/run-control"),
              getAdapterInstance(event.adapterId),
            ])
            const configuredOperators = adapterRow?.settings.runOperatorUserIds
            const operatorIds = Array.isArray(configuredOperators)
              ? configuredOperators.filter((value): value is string => typeof value === "string")
              : []
            await executeRunControlCommand(
              {
                runId,
                action: runAction as import("@/types/execution/run").RunControlAction,
                idempotencyKey: event.triggerId,
                expectedRevision: runRevision,
                actor: {
                  platformIdentityId: event.user.id,
                  remoteUserId: event.user.remoteUserId,
                  displayName: event.user.displayName,
                },
                ...(typeof event.payload?.interruptId === "string"
                  ? { interruptId: event.payload.interruptId }
                  : {}),
              },
              { operatorIds }
            )
          } catch (err) {
            await appendAudit({
              adapterId: event.adapterId,
              kind: "callback.handler_failed",
              at: Date.now(),
              conversationKey: resolvedConversationKey ?? undefined,
              reason: err instanceof Error ? err.name : "unknown",
              message: err instanceof Error ? err.message : String(err),
              fields: { triggerId: event.triggerId, runId, action: runAction },
            })
          }
        })()
        return true
      }
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
      return true
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
      return true
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
      return true
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
        "allow" | "deny" | "allow_session"
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
      return true
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
        return true
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
      return true
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
        return true
      }
      let parsed
      try {
        parsed = parseConversationKey(convKey)
      } catch {
        // The bound conversationKey cannot be parsed back into (platform,
        // adapterId, chat) — the synthetic re-entry event cannot be built.
        // Terminal, but audited: a silently dead quick-command button was
        // impossible to diagnose from the trail before this row.
        await appendAudit({
          adapterId: event.adapterId,
          kind: "callback.unbound",
          at: Date.now(),
          conversationKey: convKey,
          reason: "help_quick_command:unparsable_conversation_key",
          message: `triggerId=${event.triggerId}`,
        }).catch(() => undefined)
        return true
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
      return true
    }

    // ── Step 4b: Hand off to the bridge ──────────────────────────────
    if (!this.callbackHandler) return true
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
    return true
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
