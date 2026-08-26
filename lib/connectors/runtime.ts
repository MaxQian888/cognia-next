/**
 * Bus runtime — Task 37 + IM-completion §A (real ai-run capture).
 *
 * Wires the ConnectorBus route-handler callback into the chat-send pipeline.
 * Each routed inbound event:
 *   1. Finds or creates the ChatSession for the conversation.
 *   2. Inserts the inbound StoredMessage.
 *   3. Branches on RouteDecision:
 *      - "ai-run"        → resolveSendOptions(inbox context) → suppression
 *                          gate → runAndCapture(...) → enqueueOutbound with
 *                          the captured assistant text.
 *      - "manual-store"  → nothing further (session + message already written).
 *      - "draft-prepare" → resolveSendOptions(inbox context) → runAndCapture
 *                          (PII-gated, tool perms denied) → create a
 *                          ConnectorDraft with the generated reply segments.
 *      - "store-only"    → nothing further.
 *      - "drop"          → skip StoredMessage insert; audit policy_blocked.
 *
 * NOTE: the bus already writes "inbound.policy_blocked" / "inbound.received"
 * audit entries before calling the routeHandler. The handler adds extra audit
 * entries where a distinct action was taken (ai-run enqueue, draft creation,
 * deferred suppression).
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import type { A2UISegmentContent, MessageSegment } from "@/types/connectors/segment"
import { projectInboundToA2UI } from "@/lib/connectors/adapters/_shared/inbound-a2ui-dispatch"
import type { RouteDecision } from "./mode-router"
import type { LiveSteerHandler } from "./bus"
import type { ResolvedBinding } from "./policy-resolve"
import { matchDispatchRule } from "./dispatch-rules"
import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"
import { projectImComposition } from "./composition/im-composition-selection"
import { resolveImEffectiveConfig } from "./effective-config"
import type {
  SendContent,
  StoredMessage,
  AppSettings,
  ChatSession,
} from "@cognia/agent-config-types"
import type { AgentExecutionSendSpec } from "@cognia/agent-config-types/agent-execution"
import type { AuditKind } from "@/types/connectors/audit"
import type { InboxSendPolicy } from "@/lib/claude/build-options"
import { getDb } from "@/lib/db/schema"
import { publishSyncInvalidate } from "@/lib/sync/host-invalidate"
import { publishInboundMessageAdded } from "@/lib/connectors/inbox-relay/host-events"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { createDraft } from "@/lib/db/connector-drafts"
import type { ConversationOverrideRow, AdapterInstanceRow } from "@/lib/db/connector-types"
import { resolveCharacterById } from "@/lib/db/characters"
import { getSettings } from "@/lib/db/settings"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { endSpan } from "@cognia/agent-trace/emitter"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import { generateEmbedding } from "@cognia/provider-embedding/embedding"
import { readResolvedPrincipal } from "./principal/resolve"
import { tryBuildMemoryDeps } from "@/lib/memory/runtime/build-deps"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { assistantReplyToSegments } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { buildSteerPayload, steerBlocksOf } from "@/lib/claude/steer"
import { deliveryTargetFromEvent } from "@/types/connectors/event"
import { hasNoLeakingPii } from "@cognia/redact"
import { appendAudit } from "./audit"
import { getBus } from "./bus"
import {
  createPlatformSession,
  findActiveSessionForConversation,
  refreshPlatformSessionBinding,
} from "./session-bindings"
import { stampSlaDeadline } from "./sla"
import { startTeamRunFromIM } from "./team-dispatch"
import { startWorkflowFromIM } from "@/lib/workflow/runtime/start-from-im"
import { buildImPermissionCeiling } from "@/lib/connectors/im-permission-ceiling"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import { evaluateImRate } from "@/lib/connectors/im-rate/registry"
import { getRunningAdapter } from "./lifecycle"
import { makeImPermissionResponder } from "./hitl/tool-approval"
import { holdWorkflowDispatchForApproval } from "./hitl/workflow-run-approval"
import {
  createExecutionRun,
  putExecutionRunBinding,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import { AgentRunEventProducer } from "@/lib/execution/sources/agent-turn"
import { registerAgentRunController } from "@/lib/execution/control-handlers"
import type { ConnectorLiveSteerCoordinator } from "./live-steer"
import { sessionExecutionRootPath } from "@/lib/workspace/session-root"
import { invalidatePersistSnapshot } from "@/lib/db/messages"
import { getAllProjects } from "@/lib/db/projects"
import { waitForExecutionRunPresentationFreeze } from "./run-presentation/runner"
import { markConnectorInboundJobRecoveryRequired } from "@/lib/db/connector-inbound-jobs"
import { setSdkSessionId } from "@/lib/db/sessions"
import {
  buildAgentRunRecoveryAnchor,
  parseAgentRunRecoveryAnchor,
  validateRecoveryContinuation,
} from "@/lib/ai/agent/recovery/reconcile-crashed-runs"
import { appendCanonicalEnvelopes } from "@/lib/ai/agent/recovery/canonical-log"
import {
  canonicalEventFromCaptureEvent,
  createEnvelopeSequencer,
} from "@/lib/ai/agent/execution/event-envelope"
import {
  effectiveCapabilitiesForRow,
  hasEffectiveCapability,
} from "@/lib/connectors/effective-capabilities"
import { markSessionDirty } from "@/lib/chat/search/indexer"

/**
 * Turn-capture timeout for connector AI-run turns. Raised above the 5-min chat
 * default so an in-flight tool-permission approval (registry TTL 10 min)
 * resolves before the turn times out, while still bounding a stuck sidecar.
 */
const CONNECTOR_TURN_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Read watchdog for connector turns. Until this was wired, connector captures
 * passed only {@link CONNECTOR_TURN_TIMEOUT_MS}, so `idleTimeoutMs` defaulted to
 * 0, `armIdle()` no-opped, and a provider stream that simply went quiet burned
 * the full 15 minutes before failing — with the user waiting in the IM thread.
 *
 * Safe to set well below the wall clock because the watchdog stands down for
 * every legitimate silence: `pauseIdle()` on a pending permission (approval
 * registry TTL is 10 min) and for the duration of any in-flight tool. What's
 * left is a genuinely stalled stream.
 *
 * NOT a cure for every hang: the watchdog only arms on the FIRST event of a turn
 * (so a slow cold start stays bounded by the wall clock), and it deliberately
 * doesn't re-arm while a tool is in flight — a tool that never returns still
 * runs to {@link CONNECTOR_TURN_TIMEOUT_MS}.
 */
const CONNECTOR_TURN_IDLE_TIMEOUT_MS = 2 * 60 * 1000

function candidateDeploymentIds(
  sendOptions: Awaited<ReturnType<typeof resolveSendOptions>>,
  execution: AgentExecutionSendSpec | undefined = sendOptions.execution
): string[] {
  const routed = sendOptions.routingPlan?.orderedCandidates.map(
    (candidate) => candidate.deploymentId
  )
  if (routed && routed.length > 0) return routed
  const directRef =
    execution?.route.kind === "direct" ? execution.route.credentialProfileRef : undefined
  return [directRef ?? sendOptions.provider ?? "inherit"]
}

export async function resolveRecoveryExecutionSpec(
  sendOptions: Awaited<ReturnType<typeof resolveSendOptions>>,
  sessionId: string,
  identity: { runId: string; attemptId?: string },
  recoveringSafely: boolean,
  requiredRouteKind?: "gateway" | "direct"
): Promise<AgentExecutionSendSpec> {
  // The initial send already resolved and (for gateway) minted its exact
  // ticket in build-options. Reuse it; only a recovery attempt needs remint.
  if (sendOptions.execution && !recoveringSafely) return sendOptions.execution
  const [{ resolveAgentExecutionSpecForConfig }, { sendSpecFromResolved }, { isTauri }] =
    await Promise.all([
      import("@/lib/ai/agent/execution/agent-execution-service"),
      import("@/lib/ai/agent/execution/resolve-agent-execution-spec"),
      import("@/lib/tauri"),
    ])
  const resolution = await resolveAgentExecutionSpecForConfig(
    {
      sessionId,
      provider: sendOptions.provider,
      model: sendOptions.model,
      toolsEnabled: true,
    },
    { isTauri: isTauri(), isHeadlessHost: false },
    {
      surface: "connector",
      policy: { executionKind: "agent" },
      identity,
    }
  )
  if (recoveringSafely && requiredRouteKind === "gateway") {
    if (resolution.spec.route.kind !== "gateway") {
      throw new Error("recovery_gateway_ticket_remint_failed")
    }
    // build-options already runs for this recovery turn. Reuse its freshly
    // minted ticket when it was issued for the same frozen fingerprint; this
    // avoids minting and leaking a second provisional ticket.
    if (
      sendOptions.execution?.route.kind === "gateway" &&
      sendOptions.execution.executionFingerprint === resolution.spec.executionFingerprint
    ) {
      return sendSpecFromResolved(resolution.spec, {
        endpoint: sendOptions.execution.route.endpoint,
        ticketId: sendOptions.execution.route.ticketId,
      })
    }
    const { mintSessionRouteTicket } = await import("@/lib/gateway/mint-session-ticket")
    const minted = await mintSessionRouteTicket({
      sessionId,
      executionFingerprint: resolution.spec.executionFingerprint,
      model: sendOptions.model ?? resolution.spec.modelBindings.primary,
      routePolicy: resolution.spec.route.routePolicy,
    })
    if (minted) {
      sendOptions.env = {
        ...sendOptions.env,
        ANTHROPIC_BASE_URL: minted.endpoint,
        ANTHROPIC_API_KEY: minted.secret,
      }
      return sendSpecFromResolved(resolution.spec, {
        endpoint: minted.endpoint,
        ticketId: minted.ticketId,
      })
    }
    throw new Error("recovery_gateway_ticket_remint_failed")
  }
  return sendSpecFromResolved(resolution.spec)
}

/**
 * Canned user-facing texts for proactive IM failure notifications
 * (`notifyConversationOverIM`).
 *
 * PATTERN NOTE — IM-outbound strings cannot use next-intl (`useTranslations`
 * is React-only; this runtime is not a component tree), and the repo has no
 * locale-keyed catalog for notification texts today. The existing precedent
 * for `notifyConversationOverIM` call sites is inline bilingual "zh / en"
 * strings (see the scheduler notify in
 * `lib/scheduler/notification-integration.ts`); the live-activity
 * card's locale-resolved bag (`lib/connectors/activity/i18n.ts`) instead needs
 * `AppSettings` at the call site, which the dispatch-failure paths below do
 * not have. Follow the bilingual precedent, but keep every canned notice in
 * this one named table so a future locale-bag refactor has a single seam.
 */
const IM_FAILURE_NOTICE = {
  /** Single-character ai-run capture failed (sidecar error). */
  replyFailed: {
    title: "回复失败 / Reply failed",
    body: "助手处理这条消息时出错。/ The assistant hit an error processing this message.",
  },
  /** Bound team / workflow could not be dispatched for this turn. */
  dispatchFailed: {
    title: "任务分发失败 / Dispatch failed",
    body: "绑定的团队或工作流无法启动，本条消息未被处理。/ The bound team or workflow could not start; this message was not processed.",
  },
} as const

/**
 * Fire-and-forget an IM failure notice (control-plane notifications): lands in
 * the Notification Center always, and pushes to IM when the conversation opted
 * in. Coalesced via `notifyConversationOverIM`'s `dedupeKey`. The dynamic
 * import keeps the notifications runtime out of the connector bundle;
 * best-effort so it can never mask the original failure.
 */
function notifyImFailure(
  conversationKey: string,
  notice: { title: string; body: string },
  dedupeKey: string
): void {
  void import("@/lib/notifications/conversation-notify")
    .then(({ notifyConversationOverIM }) =>
      notifyConversationOverIM({
        conversationKey,
        level: "error",
        title: notice.title,
        body: notice.body,
        dedupeKey,
      })
    )
    .catch(() => undefined)
}

/** Resolved outbound target for one ai-run reply — see `resolveRespondViaTarget`. */
export interface RespondViaTarget {
  adapterId: string
  conversationKey: string
  conversationRef: NormalizedInboundEvent["conversationRef"]
  deliveryTarget: import("@/types/connectors/event").ConversationDeliveryTarget
}

/**
 * Resolve the outbound target for an ai-run reply when a dispatch rule set
 * `action.respondViaAdapterId` (multi-bot cross-account send).
 *
 * Fallback-first: any invalid target (unset, self, missing row, disabled,
 * muted, cross-platform, malformed conversation key) returns the receiving
 * bot unchanged, so a stale rule can never drop the reply. Every respond-via
 * decision — applied or not — writes a `dispatch.respond_via` audit row on
 * the RECEIVING adapter so the operator can trace which bot actually spoke.
 */
export async function resolveRespondViaTarget(
  respondViaAdapterId: string | undefined,
  event: NormalizedInboundEvent,
  adapterRow: Pick<AdapterInstanceRow, "type">
): Promise<RespondViaTarget> {
  const fallback: RespondViaTarget = {
    adapterId: event.adapterId,
    conversationKey: event.conversationKey,
    conversationRef: event.conversationRef,
    deliveryTarget: deliveryTargetFromEvent(event),
  }
  if (!respondViaAdapterId || respondViaAdapterId === event.adapterId) return fallback

  const auditDecision = async (
    applied: boolean,
    extra?: Record<string, unknown>
  ): Promise<void> => {
    await appendAudit({
      adapterId: event.adapterId,
      kind: "dispatch.respond_via",
      at: Date.now(),
      conversationKey: event.conversationKey,
      fields: { targetAdapterId: respondViaAdapterId, applied, ...extra },
    }).catch(() => undefined)
  }

  let targetRow: AdapterInstanceRow | undefined
  try {
    targetRow = await getAdapterInstance(respondViaAdapterId)
  } catch {
    targetRow = undefined
  }
  if (!targetRow) {
    await auditDecision(false, { reason: "not_found" })
    return fallback
  }
  if (!targetRow.enabled) {
    await auditDecision(false, { reason: "disabled" })
    return fallback
  }
  if (targetRow.muted === true) {
    await auditDecision(false, { reason: "muted" })
    return fallback
  }
  if (targetRow.type !== adapterRow.type) {
    await auditDecision(false, { reason: "cross_platform" })
    return fallback
  }

  const sourceAddress = deliveryTargetFromEvent(event).address

  await auditDecision(true)
  return {
    adapterId: targetRow.id,
    conversationKey: buildConversationKey(
      sourceAddress.platform,
      targetRow.id,
      sourceAddress.containerId,
      sourceAddress.topicId
    ),
    conversationRef: { ...event.conversationRef, adapterId: targetRow.id },
    deliveryTarget: {
      address: {
        ...(event.conversationAddress ?? deliveryTargetFromEvent(event).address),
        adapterId: targetRow.id,
        conversationKey: buildConversationKey(
          sourceAddress.platform,
          targetRow.id,
          sourceAddress.containerId,
          sourceAddress.topicId
        ),
      },
      conversationRef: { ...event.conversationRef, adapterId: targetRow.id },
      sourceMessageId: event.messageId,
      refreshedAt: event.timestamp,
    },
  }
}

/**
 * PII red-line gate for the inbound text a team / workflow dispatch forwards to
 * the model.
 *
 * The single-character ai-run path runs through `safeSendPrompt` (which calls
 * `hasNoLeakingPii` on the prompt before the model call). But the team and
 * workflow branches dispatch `event.plainText` straight into their own runtimes
 * (`startTeamRunFromIM` seeds it as the team objective, `startWorkflowFromIM`
 * as `$trigger.payload.message`) and never reach that gate — a confirmed
 * bypass. Mirror the same fail-closed check here so an IM-triggered team /
 * workflow run cannot leak locally-derived PII to the model. `event.plainText`
 * already folds in any OCR text lifted from inbound images, so gating it covers
 * that sink too. Returns true when safe to dispatch.
 */
function isInboundTextPiiSafe(event: NormalizedInboundEvent): boolean {
  return hasNoLeakingPii(event.plainText)
}

/**
 * Capture-aware Claude turn driver. Production wires it to
 * `runAndCaptureAssistantReply` from `@/lib/claude/run-and-capture`. Tests
 * pass a mock returning a deterministic `{ text, messageId }`.
 *
 * The capture wrapper is responsible for: subscribing to the sidecar event
 * channel, calling `sendPrompt` under the hood, accumulating the assistant
 * reply, and resolving once the session ends. The runtime treats the
 * resulting text as the body to enqueue for outbound delivery.
 */
export type RunAndCaptureFn = (
  sessionId: string,
  prompt: SendContent,
  options?: import("@cognia/agent-config-types").SendOptions,
  /**
   * Optional capture controls. The runtime passes `onPartial` here when the
   * target adapter implements `streamReply`, so the assistant's incremental
   * output can drive platform-side streaming (WeCom 智能机器人 stream frames)
   * while the authoritative final message still flows through the durable
   * outbound queue. Production wires this to `runAndCaptureAssistantReply`,
   * whose 4th `RunAndCaptureOptions` arg is a structural superset.
   *
   * `adapterId` / `conversationKey` are optional connector-context passthrough
   * so a wrapping injection (production routes this through `safeSendPrompt`)
   * can attribute the PII gate + usage telemetry to the right conversation.
   * They are ignored by the raw capture wrapper.
   */
  cap?: import("@/lib/claude/run-and-capture").RunAndCaptureOptions & {
    adapterId?: string
    conversationKey?: string
  }
) => Promise<{
  text: string
  messageId: string
  /**
   * A2UI surfaces emitted during this turn via the `builtin:a2ui-bridge`
   * MCP tools. Empty for plain-text turns. The runtime projects them into
   * `MessageSegment.a2ui` segments via
   * `lib/connectors/a2ui-bridge/a2ui-to-segments.ts`.
   *
   * Optional in the type so older capture wrappers (and the mock used by
   * test stubs that don't care about A2UI) keep compiling — the runtime
   * defaults to an empty record when missing.
   */
  a2uiSurfaces?: Record<string, A2UISegmentContent>
  /**
   * Surface ids in emission order. Optional for the same back-compat
   * reasons as `a2uiSurfaces`.
   */
  a2uiSurfaceOrder?: string[]
  /**
   * Token/cost usage for this turn, when the capture wrapper extracted it
   * from the SDK result message. Optional so test stubs and older wrappers
   * that don't surface usage keep compiling; the runtime only reads it to
   * close the connector turn's root trace span with LLM accounting.
   */
  usage?: import("@/lib/claude/adapter").UsageInfo
  sdkSessionId?: string
}>

export interface RuntimeOptions {
  /**
   * Inject the chat-send entry point. Production wires it to
   * `(sessionId, content, options) => runAndCaptureAssistantReply(...)`
   * from `@/lib/claude/run-and-capture`. Tests pass a mock that resolves
   * to a deterministic `{ text, messageId }`.
   */
  runAndCapture: RunAndCaptureFn
  /** Optional phase-aware injection bridge; absent runtimes replay at the next safe boundary. */
  tryLiveSteer?: LiveSteerHandler
  /** Active-run registry used by the production Anthropic sidecar bridge. */
  liveSteerCoordinator?: ConnectorLiveSteerCoordinator
}

// Session ↔ conversation binding lookups live in `session-bindings.ts` so the
// command dispatcher can reuse them without importing this heavy install path.
// Re-exported here so existing importers (`scheduled-outbound.ts`,
// `use-history-hydration.ts`) keep their `from "./runtime"` import unchanged.
export { findSessionByConversationKey, createPlatformSession } from "./session-bindings"

/**
 * What the model is told in place of media it is not allowed to see. Phrased
 * for the model, not the user: it has to understand that content exists and
 * that asking is the right move.
 */
export const WITHHELD_MEDIA_MARKER =
  "[attachment withheld: binary media is not shared with the model for this conversation]"

/**
 * Map a NormalizedInboundEvent's `segments` into the Claude SDK's
 * `SendContent` shape. Text + markdown segments collapse into text blocks;
 * other segment kinds degrade to a one-line text marker.
 *
 * This is the ONLY place inbound bytes can become model input, which is why
 * the media policy is enforced here. Under `local_extract_only` — the default,
 * and what `undefined` means — an inline image is NOT sent as a base64 block;
 * only text a local extractor produced (OCR, transcription) goes, and the model
 * is told an attachment it cannot see arrived, so it asks instead of answering
 * as though the message were empty. The bus decides the policy once
 * (`bus.ts` step 9.7) and stamps it on the event.
 *
 * Note the bytes are still on the event: the Inbox renders the image locally,
 * which was never the concern. See `media-model-gate.ts`.
 *
 * Exported so `runtime.test.ts` can exercise the mapping in isolation.
 */
export function inboundEventToSendContent(event: NormalizedInboundEvent): SendContent {
  // `undefined` is the safe value: an event that never passed the gate keeps
  // its bytes to itself.
  const allowBinary = event.mediaModelPolicy === "allow_cloud_binary"
  const blocks: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  > = []

  for (const seg of event.segments) {
    if (seg.type === "text") {
      if (seg.text.length > 0) blocks.push({ type: "text", text: seg.text })
      continue
    }
    if (seg.type === "markdown") {
      if (seg.md.length > 0) blocks.push({ type: "text", text: seg.md })
      continue
    }
    if (seg.type === "image") {
      const inline = (seg as { dataBase64?: string; mimeType?: string }).dataBase64
      const mime = (seg as { mimeType?: string }).mimeType ?? "image/png"
      const hasOcr = typeof seg.ocrText === "string" && seg.ocrText.length > 0
      if (allowBinary && typeof inline === "string" && inline.length > 0) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mime, data: inline },
        })
      } else if (typeof seg.url === "string" && seg.url.length > 0) {
        blocks.push({ type: "text", text: `[image: ${seg.url}]` })
      } else if (!hasOcr) {
        // Neither bytes the model may see nor extracted words nor a URL: say
        // so, rather than dropping the segment and leaving the model to answer
        // a message that looks empty.
        blocks.push({ type: "text", text: WITHHELD_MEDIA_MARKER })
      }
      // ADR-0024 — when a LOCAL extractor produced text, hand it to the model
      // (alongside the image where the policy allows the picture itself, so
      // vision-capable models still see it). This is the whole reason
      // `local_extract_only` is usable: non-vision models read the words, and
      // the bytes never leave the device.
      if (hasOcr) {
        blocks.push({ type: "text", text: seg.ocrText as string })
      }
      continue
    }
    // file — surface the name plus any text the inbound-media pass extracted
    // (ADR-0009 rich-media) so the model can read the document's contents.
    if (seg.type === "file") {
      const text =
        seg.ocrText && seg.ocrText.length > 0
          ? `[file: ${seg.name}]\n${seg.ocrText}`
          : `[file: ${seg.name}]`
      blocks.push({ type: "text", text })
      continue
    }
    // voice — hand back the LOCAL transcript when one was resolved. Without
    // one there is nothing the model may have: the audio itself is binary.
    if (seg.type === "voice") {
      blocks.push({
        type: "text",
        text: seg.transcript ? seg.transcript : `[voice message] ${WITHHELD_MEDIA_MARKER}`,
      })
      continue
    }
    // video / unknown — degrade to a text marker. We use `seg.type` so the
    // model can at least see what kind of attachment arrived, instead of
    // silently swallowing it.
    blocks.push({ type: "text", text: `[${seg.type}]` })
  }

  // Always include `plainText` as a final text block when the segment list
  // produced nothing — guarantees the model never sees an empty user turn.
  if (blocks.length === 0) {
    return event.plainText.length > 0 ? event.plainText : "[empty]"
  }

  // When every block is text, hand back a plain string for the SDK's
  // back-compat code path (fewer surprises in logs).
  if (blocks.every((b) => b.type === "text")) {
    return blocks.map((b) => (b as { text: string }).text).join("\n")
  }
  return blocks
}

/**
 * Build and insert a StoredMessage for the inbound event.
 */
export async function insertInboundMessage(
  event: NormalizedInboundEvent,
  sessionId: string,
  overrideTimestamp?: number
): Promise<StoredMessage> {
  const now = overrideTimestamp ?? Date.now()
  const existing = await getDb()
    .messages.where("platformMessageId")
    .equals(event.messageId)
    .filter((message) => {
      const platform = message.metadata?.platformMessage
      return (
        message.sessionId === sessionId &&
        platform?.adapterId === event.adapterId &&
        platform?.conversationKey === event.conversationKey
      )
    })
    .first()
  if (existing) return existing
  // Map MessageSegment[] → UIMessage parts (text & image; others as text-fallback)
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
      if (seg.type === "file") {
        return { type: "text" as const, text: `[file: ${seg.name}]` }
      }
      // Other segment types degrade to a text placeholder for Phase 1
      return { type: "text" as const, text: event.plainText }
    })
    .filter((_, i, arr) => {
      // De-duplicate fallback entries: only keep one text part when all
      // segments collapsed to the same plainText.
      if (i === 0) return true
      const prev = arr[i - 1]
      const curr = arr[i]
      if (prev.type === "text" && curr.type === "text" && prev.text === curr.text) return false
      return true
    })

  // If the segment list was empty, fall back to plainText
  const finalParts: StoredMessage["parts"] =
    parts.length > 0 ? parts : [{ type: "text", text: event.plainText }]

  // Reverse-project the platform-native rich content (Block Kit, Lark
  // card, Discord embeds, Telegram inline keyboard, OneBot CQ segments)
  // into an InboundA2UIBlock so the Inbox renderer can show native UI
  // structure rather than the plaintext fallback. Best-effort — the
  // mapper returns null when the payload has nothing structured.
  const inboundA2UI = projectInboundToA2UI(event.platform, event.raw, event.segments)

  const row: StoredMessage = {
    id: crypto.randomUUID(),
    sessionId,
    role: "user",
    parts: finalParts,
    // Denormalized copy of platformMessage.messageId so the v49 messages
    // index resolves edit/delete events in O(log n). Kept in sync with the
    // metadata blob below.
    platformMessageId: event.messageId,
    metadata: {
      platformMessage: {
        messageId: event.messageId,
        platform: event.platform,
        sender: event.sender,
        // Scope edit/delete lookups: per-chat message ids (Telegram, Slack)
        // collide across chats/adapters, so the bus matches on these too.
        adapterId: event.adapterId,
        conversationKey: event.conversationKey,
      },
      ...(inboundA2UI ? { inboundA2UI } : {}),
    },
    createdAt: now,
  }
  await getDb().messages.add(row)
  // The persist snapshot in `lib/db/messages.ts` assumes it is the only
  // writer for a session; an inbound platform message arriving mid-stream
  // would otherwise leave it claiming rows are unchanged.
  invalidatePersistSnapshot(sessionId)
  // Inbound platform traffic is chat history too: without this the global
  // search index never learns about it (ADR-0099 indexes only what the chat
  // paths mark dirty, and its backfill latches `complete`).
  markSessionDirty(sessionId)
  // Bump the bound session's recency so "most-recently-updated" ordering in
  // `findActiveSessionForConversation` / `listSessionsByConversationKey`
  // reflects inbound traffic — without this, a conversation whose session
  // never changes otherwise goes stale and `/sessions` ordering (plus the
  // active-session fallback) drifts. Best-effort: a missing row is a no-op.
  await getDb()
    .sessions.update(sessionId, { updatedAt: now })
    .catch(() => undefined)
  // ADR-0131 cross-shell relay. Both calls are reached ONLY for a genuinely
  // new row — the `existing` early-return above means a redelivered platform
  // message never re-invalidates or re-notifies.
  //
  // Two distinct signals on purpose: `sync://invalidate` keeps a foreground
  // thin client's mirror current (coalesced, table-scoped, always sent),
  // while `connector://message-added` is the notifiable one that wakes a
  // BACKGROUNDED phone through the Rust push trigger and is suppressed when
  // the operator is already looking, has muted the conversation, or is inside
  // quiet hours. Both are best-effort and never throw.
  publishSyncInvalidate("messages", event.conversationKey)
  void publishInboundMessageAdded(event, { sessionId, messageId: row.id })
  return row
}

/**
 * Map a `SendOptions.suppressedReason` to its corresponding deferred audit
 * kind. Centralised so the audit log gives the troubleshooter the strongest
 * single reason without branching at the call site.
 */
function suppressedReasonToAuditKind(
  reason: NonNullable<import("@cognia/agent-config-types").SendOptions["suppressedReason"]>
): AuditKind {
  switch (reason) {
    case "quiet_hours":
      return "inbound.deferred_quiet_hours"
    case "muted":
      return "inbound.deferred_muted"
    case "manual_mode_override":
      return "inbound.deferred_manual_mode"
  }
}

/**
 * Gate for embedding inbound text into the twin/memory RAG query vector.
 *
 * Returns true only when the text is non-empty AND carries no leaking PII —
 * the same red line `safeSendPrompt` enforces for the LLM leg. The embedding
 * provider is a cloud-capable sink (`@cognia/provider-embedding`), so an
 * inbound message that would be blocked before the model reply must not be
 * embedded first. On a leak we skip the embed and degrade to no-RAG (the
 * reply is blocked one step later anyway).
 */
export function shouldEmbedInboundText(plainText: string): boolean {
  return plainText.trim().length > 0 && hasNoLeakingPii(plainText)
}

/**
 * Resolve the `SendOptions` for an inbound turn — shared by the `ai-run` and
 * `draft-prepare` branches so a draft is grounded in the exact same character,
 * twin, and long-term-memory context a live reply would use. Pure context
 * resolution: it wires no send-side hooks, applies no suppression handling, and
 * owns no span accounting — the caller does. Every lookup is best-effort; a
 * missing AppSettings / character degrades to an ungrounded reply rather than
 * crashing the pipeline.
 */
async function resolveInboundSendOptions(params: {
  event: NormalizedInboundEvent
  session: ChatSession
  resolved: ResolvedBinding
  override: ConversationOverrideRow | null
  adapterRow: AdapterInstanceRow
  emitTrace: boolean
  executionIdentity?: { runId: string; attemptId?: string }
  permissionCeiling?: AgentPermissionCeiling
  resolvedCharacter?: Awaited<ReturnType<typeof resolveCharacterById>>
  /**
   * Composition selection projected from this conversation's effective config
   * (ADR-0117). Without it `resolveTurnComposition` reads the localStorage
   * session store, so an IM turn would compose from whatever the desktop user
   * last picked in the composer chip.
   */
  compositionSelection?: AgentCompositionSelectionV1
}): Promise<{
  sendOptions: Awaited<ReturnType<typeof resolveSendOptions>>
  appSettings: AppSettings | undefined
  runTitle: string
  workspaceRoot?: string
}> {
  const {
    event,
    session,
    resolved,
    override,
    adapterRow,
    emitTrace,
    executionIdentity,
    permissionCeiling,
    resolvedCharacter,
    compositionSelection,
  } = params

  let appSettings: AppSettings | undefined
  try {
    appSettings = await getSettings()
  } catch {
    appSettings = undefined
  }
  let character = resolvedCharacter
  if (!character && resolved.characterId) {
    try {
      character = await resolveCharacterById(resolved.characterId)
    } catch {
      character = undefined
    }
  }

  const inboxPolicy: InboxSendPolicy = {
    quietHours: adapterRow.quietHours,
    muted: adapterRow.muted,
    forcedMode: override?.mode,
  }

  // Twin runtime injection (parity with the in-app chat path in
  // use-claude-chat): when the conversation's character is twin-bound, hand
  // resolveSendOptions the RAG deps so the inbound message is grounded in the
  // twin's knowledge. Best-effort — tryBuildTwinDeps returns undefined when the
  // twin runtime is disabled/unconfigured, and a twinId-less character skips the
  // lookup entirely.
  const twinHandshake =
    character?.twinId && event.plainText.trim() ? await tryBuildTwinDeps() : undefined

  // Long-term memory recall (parity with use-claude-chat): ground the inbound
  // reply in the operator's memory store. `tryBuildMemoryDeps` no-ops when
  // memory is disabled, and memories are PII-filtered at write time. Inbound
  // content is never *written* back (provenance gate in run-memory-extraction),
  // but recall keeps connector replies consistent with direct chat instead of
  // being blind to the user's known facts.
  const memoryHandshake = event.plainText.trim()
    ? await tryBuildMemoryDeps(resolveMemoryConfig(appSettings?.memory), twinHandshake)
    : undefined

  // PII red line for the RAG legs: when the inbound text would leak PII to the
  // (cloud-capable) embedding provider, withhold BOTH the precomputed embedding
  // AND the twin/memory user-message levers below. Gating only the precompute
  // is not enough — `applyTwinContext` falls back to
  // `generateEmbedding(userMessage)` when `precomputedQueryEmbedding` is absent,
  // and the memory retriever calls `deps.embed(query)` the same way — so
  // passing the raw text would re-embed exactly what this gate blocked.
  // `resolveSendOptions` only invokes either context builder when its
  // userMessage is set, so withholding them disables every fallback embed in
  // one move. Degrades to no-RAG; the LLM leg is blocked by `safeSendPrompt`
  // one step later anyway.
  const embedSafe = shouldEmbedInboundText(event.plainText)

  // Embed the inbound message ONCE (when twin deps exist) so the twin RAG and
  // memory recall legs share one query vector instead of embedding twice. Memory
  // reuses the twin embedding model, so the vector is valid for both. Best-effort.
  let turnEmbedding: number[] | undefined
  if (twinHandshake && embedSafe) {
    try {
      turnEmbedding = (await generateEmbedding(event.plainText, twinHandshake.embedding)).embedding
    } catch {
      turnEmbedding = undefined
    }
  }

  const sendOptions = await resolveSendOptions({
    session,
    character,
    appSettings,
    conversationKey: event.conversationKey,
    platformBinding: session.platformBinding,
    inboxPolicy,
    // Reuse the rows the bus already fetched — skips two Dexie re-reads inside
    // resolveSendOptions (provider/model override + capability matrix).
    imOverrideRow: override,
    imAdapterRow: adapterRow,
    twinDeps: twinHandshake,
    twinUserMessage: twinHandshake && embedSafe ? event.plainText : undefined,
    memoryDeps: memoryHandshake,
    memoryUserMessage: memoryHandshake && embedSafe ? event.plainText : undefined,
    precomputedQueryEmbedding: turnEmbedding,
    // Open the connector turn's agent-trace ROOT span (ai-run) so the whole
    // turn appears in the waterfall under surface "connector". Draft prepares
    // pass `emitTrace: false` — a draft is not a live turn, so it mints no span
    // and the caller runs no endSpan dance. Suppressed turns mint nothing too
    // (guarded in the resolver).
    emitTrace,
    traceSurface: "connector",
    executionIdentity,
    permissionCeiling,
    compositionSelection,
  })

  const projects = await getAllProjects().catch(() => [])
  // The conversation's OWN execution root, not its workspace's primary root:
  // an IM message resuming a worktree-bound conversation must run where that
  // conversation runs, or the agent writes into the checkout the worktree was
  // cut from.
  const workspaceRoot = sessionExecutionRootPath(session, projects)

  return {
    sendOptions,
    appSettings,
    runTitle: character?.name?.trim() || "Agent run",
    ...(workspaceRoot ? { workspaceRoot } : {}),
  }
}

/**
 * Install the route handler on the bus singleton.
 *
 * Call this once at app startup (e.g. from ConnectorBusProvider).
 */
export function installRuntime(bus: ReturnType<typeof getBus>, opts: RuntimeOptions): void {
  bus.liveSteerHandler = opts.tryLiveSteer ?? opts.liveSteerCoordinator?.handle ?? null
  bus.routeHandler = async (
    event: NormalizedInboundEvent,
    decision: RouteDecision,
    resolved: ResolvedBinding,
    override: ConversationOverrideRow | null,
    adapterRow: AdapterInstanceRow,
    routeContext
  ): Promise<void> => {
    const now = Date.now()

    // ── "drop" → skip all storage; bus already wrote policy_blocked audit ──
    if (decision === "drop") {
      return
    }

    // ── Edit / delete events: route to bus's edit/delete handler instead of
    // creating a new StoredMessage. The bus owns the in-place update path
    // because it has the inboundLedger context to resolve `replacesMessageId`
    // back to the original `StoredMessage`. The runtime's job here is only
    // the create / ai-run / draft-prepare / manual-store paths.
    if (event.kind === "edit" || event.kind === "delete" || event.kind === "system") {
      // The bus's dispatchInboundFull short-circuits these before they reach
      // the routeHandler in production, but we leave a defensive return here
      // in case a connector pushes one through a different path.
      return
    }

    // ── Step 1: resolve the active ChatSession (honoring `/switch` / `/new`) ──
    // Consult `override.activeSessionId` first so an AI turn targets the
    // session the user switched to; fall back to the most-recently-updated
    // bound session, then create one. The override read is best-effort — a
    // failure degrades to "most-recent / create", today's behaviour.
    // Reuse the override row the bus already fetched (Step 3) — it is
    // immutable for this inbound event, so a second Dexie read here would be
    // pure waste. Null when the conversation has no override.
    let session = await findActiveSessionForConversation(
      event.conversationKey,
      override ?? undefined
    )
    if (!session) {
      session = await createPlatformSession(event, resolved.characterId)
      // Slice 1B: the bus could not stamp the bot-default SLA deadline for a
      // first-ever inbound (no session → no override row); now that the
      // session exists, backfill it. Idempotent + best-effort.
      await stampSlaDeadline({
        conversationKey: event.conversationKey,
        sessionId: session.id,
        adapter: adapterRow,
        now: event.timestamp,
      }).catch(() => undefined)
    } else {
      session = await refreshPlatformSessionBinding(session, event)
    }

    // ── Step 2: insert inbound StoredMessage ─────────────────────────────────
    const storedMsg = await insertInboundMessage(event, session.id)

    // ── Step 3: branch on decision ───────────────────────────────────────────
    switch (decision) {
      case "ai-run":
      case "draft-prepare": {
        // `draft-prepare` is NOT a second execution path — it is this one with
        // its product held for a human. Keeping it separate is what made a
        // team-bound conversation silently degrade: that branch resolved no
        // execution target, so `/team`-bound work never reached the team and
        // the "draft" was a single-character reply nobody had asked for.
        //
        // In axis terms (ADR-0117) this is `autonomy: "suggest"` producing
        // `requireAcceptance`, which is a property of the PRODUCT, not of the
        // executor. So the turn runs exactly as it otherwise would — same
        // routing, same team, same workflow, same PII gate — and only the
        // DELIVERY stage differs.
        const requireAcceptance = decision === "draft-prepare"
        // Real ai-run path: build the SendOptions with inbox context, check
        // the suppression gate, and either short-circuit (write a deferred
        // audit) or invoke the capture wrapper and enqueue the result.
        //
        // All the lookups are best-effort. A missing adapter row, override,
        // character, or AppSettings should not crash the pipeline — we fall
        // through to a no-policy resolveSendOptions call so the adapter
        // still produces SOMETHING for the user. The capture wrapper itself
        // is wrapped in try/catch so a sidecar failure becomes an
        // "adapter.error" audit row, not an unhandled rejection.
        // `adapterRow` and `override` were already fetched by the bus and
        // threaded in — no re-read here.
        // ── Effective routing (override → dispatch rule → instance default) ──
        // W3 inbound dispatch rules: the instance's declarative rule table is
        // evaluated once per turn, then composed with the conversation
        // override and the instance defaults. Computed here so the PII gate,
        // the dispatch branches, and the audits below all agree on the same
        // routing. `teamDisabled` (the `/team off` sentinel) suppresses the
        // rule-sourced team AND the bot-level default.
        const ruleHit = matchDispatchRule(adapterRow.dispatchRules, event)
        const effectiveConfig = resolveImEffectiveConfig({
          adapter: adapterRow,
          override,
          rule: ruleHit,
          system: { mode: resolved.mode, characterId: resolved.characterId },
          // The send path reads `session.model` between the conversation
          // override and the bot default, so the facade has to see it too or
          // `/status` reports a model this turn will not use.
          session: { model: session.model, providerOverride: session.providerOverride },
        })
        const routing = effectiveConfig.routing
        const effectiveTeamId = routing.teamId
        const effectiveWorkflowId = routing.workflowId
        const effectiveCharacterId = override?.characterDisabled
          ? undefined
          : (routing.characterId ?? resolved.characterId)
        const effectiveCharacter = effectiveCharacterId
          ? await resolveCharacterById(effectiveCharacterId).catch(() => undefined)
          : undefined

        // Explicit references are fail-closed. A deleted Character must never
        // silently turn into the system persona for Team, Workflow, or Direct.
        if (
          effectiveCharacterId &&
          effectiveConfig.character.source !== "system-default" &&
          !effectiveCharacter
        ) {
          await appendAudit({
            adapterId: event.adapterId,
            kind: "adapter.error",
            at: Date.now(),
            conversationKey: event.conversationKey,
            reason: "character_reference_missing",
            fields: {
              characterId: effectiveCharacterId,
              characterSource: routing.characterSource,
              sourceMessageId: storedMsg.id,
            },
          })
          notifyImFailure(
            event.conversationKey,
            IM_FAILURE_NOTICE.dispatchFailed,
            `dispatch-error:${event.conversationKey}`
          )
          break
        }

        const target = effectiveTeamId ? "team" : effectiveWorkflowId ? "workflow" : "direct"
        const permissionCeiling = await buildImPermissionCeiling({
          adapter: adapterRow,
          override,
          character: effectiveCharacter,
          platform: event.platform,
          target,
        })

        // One-shot `dispatch.rule_matched` audit writer — appended only when
        // the matched rule's action actually decided the routing (i.e. was
        // not shadowed by an explicit conversation override), right before
        // the decided branch dispatches.
        const auditRuleDecision = async (
          target: Partial<Record<"teamId" | "workflowId" | "characterId", string>>
        ): Promise<void> => {
          if (!ruleHit) return
          await appendAudit({
            adapterId: event.adapterId,
            kind: "dispatch.rule_matched",
            at: Date.now(),
            conversationKey: event.conversationKey,
            fields: {
              ruleId: ruleHit.rule.id,
              ...(ruleHit.rule.name ? { ruleName: ruleHit.rule.name } : {}),
              ...target,
              sourceMessageId: storedMsg.id,
            },
          })
        }

        // ── PII gate for team / workflow dispatch ──
        // Both branches below forward `event.plainText` straight into their own
        // runtimes, bypassing `safeSendPrompt`. Enforce the same fail-closed
        // red-line here (single choke point covering both — including
        // rule-sourced teams/workflows) before any dispatch.
        if ((effectiveTeamId || effectiveWorkflowId) && !isInboundTextPiiSafe(event)) {
          await appendAudit({
            adapterId: event.adapterId,
            kind: "adapter.error",
            at: Date.now(),
            conversationKey: event.conversationKey,
            reason: "pii_blocked",
            message: "team/workflow dispatch prompt rejected by PII gate before dispatch",
            fields: {
              ...(effectiveTeamId
                ? { teamId: effectiveTeamId, teamSource: routing.teamSource }
                : {}),
              ...(effectiveWorkflowId ? { workflowId: effectiveWorkflowId } : {}),
              sourceMessageId: storedMsg.id,
            },
          })
          break
        }

        // ── Team dispatch (control-plane multi-agent) ──
        // When the conversation is bound to an Agent Team, route the turn to
        // the team runtime instead of the single-character `runAndCapture`
        // path. The team's progress + final result fan back to this
        // conversation via the execution bridge + run-presentation runner
        // (triggeredFrom). Skip
        // the rest of the ai-run branch on success.
        if (effectiveTeamId) {
          if (routing.teamSource === "rule") {
            await auditRuleDecision({ teamId: effectiveTeamId })
          }
          const res = await startTeamRunFromIM({
            teamId: effectiveTeamId,
            goal: event.plainText,
            adapterId: event.adapterId,
            conversationKey: event.conversationKey,
            sessionId: session.id,
            session,
            ...(effectiveCharacterId ? { characterId: effectiveCharacterId } : {}),
            permissionCeiling,
            ...(event.sender.remoteUserId ? { initiatorUserId: event.sender.remoteUserId } : {}),
            // Acceptance, expressed through the mechanism that exists for a
            // team. A single-character turn can be held as a draft because its
            // product lands here; a team's product lands minutes later through
            // the presentation runner, where there is nothing to hold. What
            // `suggest` actually means for a team is "a human signs off before
            // it acts" — which is the plan gate, and it now has a card to ask
            // on (`makeImPlanApprovalDelegate`). Holding the finished output
            // instead would review work already done.
            //
            // Read from the routing decision, not re-derived from the stored
            // autonomy: the decision is what routing already concluded, and a
            // second derivation can disagree with it (a recovery replay hands
            // the handler a decision whose conversation row has since changed).
            ...(requireAcceptance ? { requirePlanApprovalFloor: true } : {}),
          })
          if (res.started && res.runId) {
            // Bind the EXECUTION run id, not the raw team run id. The two are
            // different keys (`execution:team:<id>` vs `<id>`), and
            // `reconcileCrashedRuns` filters `connectorInboundJobs` by the
            // execution id — so binding the raw id meant a crashed team turn
            // could never re-link to the inbound job that started it.
            const { agentTeamExecutionRunId } = await import("@/lib/execution/agent-team-bridge")
            await routeContext.bindExecutionRun(agentTeamExecutionRunId(res.runId))
          }
          await appendAudit({
            adapterId: event.adapterId,
            kind: res.started ? "team.dispatched" : "adapter.error",
            at: Date.now(),
            conversationKey: event.conversationKey,
            ...(res.started
              ? {}
              : {
                  reason: res.reason ?? "team_dispatch_failed",
                }),
            fields: {
              teamId: effectiveTeamId,
              teamSource: routing.teamSource,
              sourceMessageId: storedMsg.id,
              // Recorded because the old `draft-prepare` branch could not
              // dispatch at all: a draft-mode conversation bound to a team
              // silently produced a single-character reply, and nothing said
              // so. Now the team runs and the audit names how it was gated.
              ...(requireAcceptance ? { acceptance: "plan-approval" } : {}),
            },
          })
          if (!res.started) {
            notifyImFailure(
              event.conversationKey,
              IM_FAILURE_NOTICE.dispatchFailed,
              `dispatch-error:${event.conversationKey}`
            )
          }
          break
        }

        // ── Visual Workflow dispatch (workflow⇄IM parity) ──
        // When the conversation (or a matched dispatch rule) binds a Visual
        // Workflow (and NOT a team — `teamId` wins above), route the turn to
        // the workflow orchestrator via `startWorkflowFromIM`. The message
        // text is surfaced to trigger-aware nodes as
        // `$trigger.payload.message`; progress + final fan back through the
        // same execution bridge + run-presentation runner the team path
        // uses. Skip the rest
        // of the ai-run branch on dispatch.
        if (effectiveWorkflowId) {
          if (routing.workflowSource === "rule") {
            await auditRuleDecision({ workflowId: effectiveWorkflowId })
          }
          const runParams = {
            message: event.plainText,
            ...(effectiveCharacterId ? { characterId: effectiveCharacterId } : {}),
          }
          const triggeredFrom = {
            source: "im" as const,
            adapterId: event.adapterId,
            conversationKey: event.conversationKey,
            sourceMessageId: event.messageId,
            deliveryTarget: deliveryTargetFromEvent(event),
            ...(session.id ? { sessionId: session.id } : {}),
            ...(effectiveCharacterId ? { characterId: effectiveCharacterId } : {}),
            initiator: {
              platformIdentityId: event.sender.id,
              remoteUserId: event.sender.remoteUserId,
              displayName: event.sender.displayName,
              ...(readResolvedPrincipal(event.channelData) ?? {}),
            },
          }

          // ── Acceptance, expressed through the mechanism a workflow has ──
          // The third shape of `autonomy: "suggest"`. Direct holds the
          // product, a team holds its plan; a workflow has neither — its
          // product is delivered by its own nodes and never lands here, so by
          // the time anything is holdable the work has shipped. The only
          // remaining point where "a human signs off before it acts" is still
          // true is BEFORE the run starts, so that is what is held. The press
          // is answered by the `wf_approve` / `wf_cancel` dispatcher that
          // already exists, which is why nothing is dispatched here.
          if (requireAcceptance) {
            const held = await holdWorkflowDispatchForApproval({
              workflowId: effectiveWorkflowId,
              runParams,
              triggeredFrom,
              permissionCeiling,
              adapterId: event.adapterId,
              conversationKey: event.conversationKey,
              conversationRef: event.conversationRef,
              deliveryTarget: deliveryTargetFromEvent(event),
              ...(event.sender.remoteUserId ? { initiatorUserId: event.sender.remoteUserId } : {}),
              requestText: event.plainText,
            })
            if (held.held) {
              await appendAudit({
                adapterId: event.adapterId,
                kind: "workflow.dispatch_held",
                at: Date.now(),
                conversationKey: event.conversationKey,
                fields: {
                  workflowId: effectiveWorkflowId,
                  surfaceId: held.surfaceId,
                  sourceMessageId: storedMsg.id,
                  acceptance: "run-approval",
                },
              })
            } else {
              // Fail closed. Running the workflow because the question could
              // not be asked is the exact gap this closes, only louder.
              await appendAudit({
                adapterId: event.adapterId,
                kind: "adapter.error",
                at: Date.now(),
                conversationKey: event.conversationKey,
                reason: "workflow_hold_failed",
                message: held.message,
                fields: {
                  workflowId: effectiveWorkflowId,
                  sourceMessageId: storedMsg.id,
                  acceptance: "run-approval",
                },
              })
              notifyImFailure(
                event.conversationKey,
                IM_FAILURE_NOTICE.dispatchFailed,
                `dispatch-error:${event.conversationKey}`
              )
            }
            break
          }

          const res = await startWorkflowFromIM({
            workflowId: effectiveWorkflowId,
            runParams,
            triggeredFrom,
            permissionCeiling,
          })
          if (res.ok) {
            await routeContext.bindExecutionRun(res.runId)
          }
          await appendAudit({
            adapterId: event.adapterId,
            kind: res.ok ? "workflow.dispatched" : "adapter.error",
            at: Date.now(),
            conversationKey: event.conversationKey,
            ...(res.ok ? {} : { reason: res.reason ?? "workflow_dispatch_failed" }),
            fields: {
              workflowId: effectiveWorkflowId,
              sourceMessageId: storedMsg.id,
            },
          })
          // Surface the failure to the conversation (parity with the
          // capture-failure branch below) — the audit row alone leaves the IM
          // user with silence.
          if (!res.ok) {
            notifyImFailure(
              event.conversationKey,
              IM_FAILURE_NOTICE.dispatchFailed,
              `dispatch-error:${event.conversationKey}`
            )
          }
          break
        }

        // ── Plugin IM rate-source gate (im-rate-source capability) ──
        // A plugin may contribute a per-conversation send gate; a block here
        // suppresses the AI-run turn before any send is built. Advisory /
        // additive (it can only further restrict the built-in policy).
        // Best-effort — `evaluateImRate` swallows source errors as abstain.
        const rateBlock = await evaluateImRate({
          adapterId: event.adapterId,
          conversationKey: event.conversationKey,
          platform: event.platform,
          now,
        })
        if (rateBlock) {
          await appendAudit({
            adapterId: event.adapterId,
            kind: "plugin.rate_blocked",
            at: now,
            conversationKey: event.conversationKey,
            reason: rateBlock.reason,
            fields: { key: rateBlock.key, sourceMessageId: storedMsg.id },
          })
          break
        }

        // ── Rule-sourced character (single-character path) ──
        // A matched rule's `characterId` applies to the SEND options only
        // (an explicit `/character` override is already folded into
        // `resolved.characterId` by `resolveBinding` and wins). Session
        // creation above deliberately kept `resolved.characterId` — the
        // rule retargets this turn's persona, not the session binding.
        const effectiveResolved: ResolvedBinding = {
          ...resolved,
          characterId: effectiveCharacterId,
        }
        if (routing.characterSource === "rule" && routing.characterId) {
          await auditRuleDecision({ characterId: routing.characterId })
        }

        const baseExecutionRunId = `execution:agent:${session.id}:${storedMsg.id}`
        const recoveringSafely = event.channelData?.recoveryIntent === "continue_safely"
        const previousRecoveryAnchor = recoveringSafely
          ? parseAgentRunRecoveryAnchor(event.channelData?.recoveryAnchor)
          : undefined
        const recoveryParentRunId = previousRecoveryAnchor
          ? (previousRecoveryAnchor.executionJournalRunId ??
            previousRecoveryAnchor.executionIdentityRunId ??
            baseExecutionRunId)
          : undefined
        const executionRunId = previousRecoveryAnchor
          ? `${baseExecutionRunId}:attempt:${previousRecoveryAnchor.attemptId}`
          : baseExecutionRunId
        const executionIdentity = {
          runId: previousRecoveryAnchor?.executionIdentityRunId ?? baseExecutionRunId,
          ...(previousRecoveryAnchor ? { attemptId: previousRecoveryAnchor.attemptId } : {}),
        }

        // Resolve the send options (character + twin + memory context) through
        // the shared helper so an ai-run and a draft prepare from identical
        // grounding. `emitTrace: true` mints the connector root span, ended on
        // the capture-error / success branches below.
        const { sendOptions, appSettings, runTitle, workspaceRoot } =
          await resolveInboundSendOptions({
            event,
            session,
            resolved: effectiveResolved,
            override,
            adapterRow,
            emitTrace: true,
            executionIdentity,
            permissionCeiling,
            // A ChatSession carries no `agentModeId` of its own (that field
            // lives on SystemPromptPreset), so the preset stays Standard here
            // rather than borrowing the desktop's localStorage default — which
            // is the very coupling this seam exists to remove. The axes below
            // it all come from this conversation's Dexie config.
            compositionSelection: projectImComposition({ effective: effectiveConfig }).selection,
          })

        let recoveryExecution: AgentExecutionSendSpec
        try {
          recoveryExecution = await resolveRecoveryExecutionSpec(
            sendOptions,
            session.id,
            executionIdentity,
            recoveringSafely,
            previousRecoveryAnchor?.routeKind
          )
        } catch (error) {
          if (
            recoveringSafely &&
            error instanceof Error &&
            error.message === "recovery_gateway_ticket_remint_failed"
          ) {
            await markConnectorInboundJobRecoveryRequired(
              routeContext.inboundJobId,
              "recovery_gateway_ticket_remint_failed"
            )
            await runEventJournal.append(
              recoveryParentRunId ?? executionRunId,
              semanticRunEvent("run.recovery_required", {
                reason: "gateway-ticket-remint-failed",
              })
            )
            break
          }
          throw error
        }
        // Preserve rollout semantics: only update the on-wire spec when this
        // send already opted into canonical dispatch. The shadow spec still
        // owns recovery identity and journaling while the flag is off.
        if (sendOptions.execution) sendOptions.execution = recoveryExecution

        if (recoveringSafely) {
          const current = {
            sdkSessionId: session.sdkSessionId,
            executionFingerprint: recoveryExecution.executionFingerprint,
            candidateDeploymentIds: candidateDeploymentIds(sendOptions, recoveryExecution),
            modelBindings: recoveryExecution.modelBindings,
          }
          const validation = previousRecoveryAnchor
            ? validateRecoveryContinuation(previousRecoveryAnchor, current)
            : { action: "pause" as const, mismatches: ["recoveryAnchor"] }
          if (validation.action === "pause") {
            await markConnectorInboundJobRecoveryRequired(
              routeContext.inboundJobId,
              "recovery_execution_drift",
              { error: validation.mismatches.join(",") }
            )
            await runEventJournal.append(
              recoveryParentRunId ?? executionRunId,
              semanticRunEvent("run.recovery_required", {
                reason: "execution-drift",
                detail: validation.mismatches,
              })
            )
            break
          }
        }

        // ── Suppression gate: short-circuit before the sidecar call ──
        if (sendOptions.suppressedReason) {
          await appendAudit({
            adapterId: event.adapterId,
            kind: suppressedReasonToAuditKind(sendOptions.suppressedReason),
            at: now,
            conversationKey: event.conversationKey,
            reason: sendOptions.suppressedReason,
            fields: { sourceMessageId: storedMsg.id },
          })
          break
        }

        // ── Capture the assistant reply via the injected wrapper ──
        // Always wire `onPermissionRequest` so an ask-tier tool fired mid-turn
        // projects an A2UI Allow/Deny card to the conversation and the turn
        // suspends until the user taps (control-plane HITL). Without this the
        // sidecar's permission_request went unanswered and the turn hung until
        // the 5-min timeout — a latent IM auto-mode bug this also fixes.
        // `onPartial` is additionally wired when the target adapter supports
        // incremental replies (WeCom 智能机器人) so the assistant's growing text
        // drives platform-side stream frames; the authoritative final message
        // still flows through `enqueueOutbound` below. Both are best-effort.
        //
        // The turn timeout is raised to {@link CONNECTOR_TURN_TIMEOUT_MS} so a
        // legitimate human approval (registry TTL 10 min) resolves before the
        // turn times out, while a genuinely stuck sidecar is still bounded.
        const targetAdapter = bus.getAdapter(event.adapterId)
        // A drafted turn has no live conversational surface: nobody has agreed
        // to see it yet, so a progress card would announce a reply the operator
        // may never approve.
        const liveActivityEnabled = override?.liveActivity !== false && !requireAcceptance
        // ── Respond-via bot (multi-bot cross-account send) ──
        // A matched dispatch rule may ask for the reply to be delivered
        // through ANOTHER of our own bot instances. Validate the target at
        // dispatch time (exists, enabled, not muted, same platform) and fall
        // back to the receiving bot — with an audit trail either way — so a
        // stale rule can never silently drop the reply. Resolved BEFORE the
        // capture so platform streaming can be gated on it: when the reply is
        // rewired away from the receiving adapter+conversation, the RECEIVING
        // bot must not stream partial frames it will never finalize (the
        // sibling posts the final — the user would otherwise see an orphaned
        // duplicate preview).
        const outboundTarget = await resolveRespondViaTarget(
          routing.respondViaAdapterId,
          event,
          adapterRow
        )
        const streamsThroughReceiver =
          !requireAcceptance &&
          outboundTarget.adapterId === event.adapterId &&
          outboundTarget.conversationKey === event.conversationKey
        await createExecutionRun({
          id: executionRunId,
          ...(recoveryParentRunId ? { parentRunId: recoveryParentRunId } : {}),
          kind: "agent-turn",
          sourceId: storedMsg.id,
          sessionId: session.id,
          projectId: session.projectId,
          title: runTitle,
          status: "queued",
          initiator: {
            platformIdentityId: event.sender.id,
            remoteUserId: event.sender.remoteUserId,
            displayName: event.sender.displayName,
            ...(readResolvedPrincipal(event.channelData) ?? {}),
          },
          currentRevision: 0,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        })
        await routeContext.bindExecutionRun(executionRunId)
        if (liveActivityEnabled) {
          const teamId =
            typeof event.conversationRef.teamId === "string"
              ? event.conversationRef.teamId
              : undefined
          await putExecutionRunBinding({
            id: `execution-binding:${executionRunId}:${event.adapterId}:${event.conversationKey}`,
            runId: executionRunId,
            projectId: session.projectId,
            adapterId: event.adapterId,
            conversationKey: event.conversationKey,
            status: "active",
            deliveryMode: "native",
            locale: appSettings?.language,
            sourceMessageId: event.messageId,
            deliveryTarget: deliveryTargetFromEvent(event),
            recipientUserId: event.sender.remoteUserId,
            recipientTeamId: teamId,
            lastProjectedRevision: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        }
        const runProducer = new AgentRunEventProducer(executionRunId, undefined, {
          workspaceRoot,
        })
        let recoveryAnchor = buildAgentRunRecoveryAnchor({
          inboundJobId: routeContext.inboundJobId,
          sessionId: session.id,
          sdkSessionId: session.sdkSessionId,
          execution: recoveryExecution,
          journalRunId: executionRunId,
          candidateDeploymentIds: candidateDeploymentIds(sendOptions, recoveryExecution),
          restoredPermissions: previousRecoveryAnchor?.restoredPermissions,
          partialOutput: previousRecoveryAnchor?.partialOutput,
        })
        await runProducer.start(Date.now(), { recoveryAnchor })
        // Abort propagation: thread the per-adapter teardown signal (aborted
        // by the install teardown and by a lifecycle requeue/stop) into the
        // capture, so tearing the runtime down halts an in-flight turn instead
        // of letting it run to the 15-min timeout and write Dexie post-unmount.
        const adapterSignal = getRunningAdapter(event.adapterId)?.abortController.signal
        const runController = new AbortController()
        const unregisterRunController = registerAgentRunController(executionRunId, runController)
        const unregisterLiveSteer = opts.liveSteerCoordinator?.activate({
          conversationKey: event.conversationKey,
          sessionId: session.id,
          executionRunId,
          provider: sendOptions.provider ?? "anthropic",
        })
        const captureSignal = adapterSignal
          ? AbortSignal.any([adapterSignal, runController.signal])
          : runController.signal
        const envelope = createEnvelopeSequencer({
          sessionId: session.id,
          runId: executionRunId,
          attemptId: recoveryAnchor.attemptId,
          hostRef: recoveryExecution.hostRef,
          runtime: recoveryExecution.runtimeAdapter,
          turnId: crypto.randomUUID(),
        })
        let canonicalTail: Promise<unknown> = Promise.resolve()
        let canonicalFailure: unknown
        let recoveryMetadataTail: Promise<unknown> = Promise.resolve()
        const persistCanonicalEvent = (canonical: Parameters<typeof envelope>[0]) => {
          const nextEnvelope = envelope(canonical)
          canonicalTail = canonicalTail
            .catch(() => undefined)
            .then(() => appendCanonicalEnvelopes(executionRunId, [nextEnvelope]))
            .catch((error) => {
              canonicalFailure ??= error
              throw error
            })
          return canonicalTail
        }
        const basePermissionResponder = makeImPermissionResponder({
          runId: executionRunId,
          sessionId: session.id,
          adapterId: event.adapterId,
          conversationKey: event.conversationKey,
          conversationRef: event.conversationRef,
          initiatorUserId: event.sender.remoteUserId,
          deliveryTarget: deliveryTargetFromEvent(event),
          approvalMode: override?.approvalMode,
        })
        const restoredDeniedRequests = new Set(
          (previousRecoveryAnchor?.restoredPermissions ?? [])
            .filter((permission) => permission.state === "denied")
            .map((permission) => permission.requestId)
        )
        const cap: import("@/lib/claude/run-and-capture").RunAndCaptureOptions & {
          adapterId?: string
          conversationKey?: string
        } = {
          // Connector context for the injected PII gate (`safeSendPrompt`) and
          // its usage telemetry; ignored by the raw capture wrapper.
          adapterId: event.adapterId,
          conversationKey: event.conversationKey,
          timeoutMs: CONNECTOR_TURN_TIMEOUT_MS,
          idleTimeoutMs: CONNECTOR_TURN_IDLE_TIMEOUT_MS,
          signal: captureSignal,
          onPermissionRequest: async (request) => {
            await persistCanonicalEvent({
              kind: "permission-request",
              requestId: request.requestId,
              toolName: request.toolName,
              input: request.input,
            })
            const decision = restoredDeniedRequests.has(request.requestId)
              ? { decision: "deny" as const, message: "permission denied by recovered state" }
              : requireAcceptance
                ? // No human is in the loop at GENERATION time for a drafted
                  // turn — the human reviews the finished product. Asking now
                  // would project an Allow/Deny card into a conversation whose
                  // operator has said the bot does not speak unprompted.
                  { decision: "deny" as const, message: "ask-tier tools are denied while drafting" }
                : await basePermissionResponder(request)
            await persistCanonicalEvent({
              kind: "permission-resolved",
              requestId: request.requestId,
              behavior: decision.decision === "deny" ? "deny" : "allow",
            })
            return decision
          },
          onSdkSessionId: (sdkSessionId) => {
            recoveryAnchor = { ...recoveryAnchor, sdkSessionId }
            recoveryMetadataTail = recoveryMetadataTail
              .catch(() => undefined)
              .then(async () => {
                await setSdkSessionId(session.id, sdkSessionId)
                await runEventJournal.append(
                  executionRunId,
                  semanticRunEvent("resource.changed", {
                    resourceId: `sdk-session:${session.id}`,
                    recoveryAnchor,
                  })
                )
              })
          },
          onEvent: (ev: import("@/lib/claude/run-and-capture").CaptureStreamEvent) => {
            const canonical = canonicalEventFromCaptureEvent(ev)
            void runProducer.onCaptureEvent(ev, Date.now()).catch(() => undefined)
            if (canonical) void persistCanonicalEvent(canonical).catch(() => undefined)
          },
          ...(streamsThroughReceiver && typeof targetAdapter?.streamReply === "function"
            ? {
                onPartial: (text: string) => {
                  void targetAdapter.streamReply!({
                    conversationRef: event.conversationRef,
                    text,
                  }).catch(() => undefined)
                },
              }
            : {}),
        }

        const inboundPrompt = inboundEventToSendContent(event)
        const prompt =
          event.channelData?.dispatchIntent === "steer-replay"
            ? buildSteerPayload([{ text: event.plainText, blocks: steerBlocksOf(inboundPrompt) }])
            : inboundPrompt
        let captured: Awaited<ReturnType<RunAndCaptureFn>>
        try {
          captured = await opts.runAndCapture(session.id, prompt, sendOptions, cap)
          await Promise.all([
            canonicalTail.catch(() => undefined),
            recoveryMetadataTail.catch(() => undefined),
          ])
        } catch (err) {
          await Promise.all([
            canonicalTail.catch(() => undefined),
            recoveryMetadataTail.catch(() => undefined),
          ])
          // The PII gate (`safeSendPrompt`) throws `PiiGateBlocked` and has
          // ALREADY written the precise `adapter.error / pii_blocked` audit
          // row before throwing. Detect it by name (no heavy import) and skip
          // the generic `ai_run_capture_failed` row so we don't double-audit
          // or mislabel a deliberate PII block as a sidecar failure.
          const isPiiBlocked = err instanceof Error && err.name === "PiiGateBlocked"
          if (!isPiiBlocked) {
            await appendAudit({
              adapterId: event.adapterId,
              kind: "adapter.error",
              at: Date.now(),
              conversationKey: event.conversationKey,
              // The reason stays distinct even though the path is now shared:
              // an operator filtering for drafting failures would otherwise
              // lose that signal to the collapse, and "the draft never
              // appeared" is a different report from "the bot did not reply".
              reason: requireAcceptance ? "draft_prepare_capture_failed" : "ai_run_capture_failed",
              message: err instanceof Error ? err.message : String(err),
              fields: { sourceMessageId: storedMsg.id },
            })
          }
          try {
            await runProducer.finish(
              captureSignal.aborted ? "cancelled" : "failed",
              Date.now(),
              isPiiBlocked ? "Sensitive content was blocked" : "Agent run failed"
            )
          } catch {
            /* best-effort — the original error is what matters */
          }
          // Proactively surface the failure: the user otherwise gets silence
          // on a sidecar error.
          notifyImFailure(
            event.conversationKey,
            IM_FAILURE_NOTICE.replyFailed,
            `airun-error:${event.conversationKey}`
          )
          // Close the agent-trace root span on a failed capture so it doesn't
          // dangle. Idempotent + no-op when minting was skipped (suppressed).
          if (sendOptions.spanId) {
            endSpan(sendOptions.spanId, {
              errorType: isPiiBlocked ? "pii_blocked" : "ai_run_capture_failed",
              errorMessage: err instanceof Error ? err.message : String(err),
            })
          }
          unregisterRunController()
          unregisterLiveSteer?.()
          break
        }
        unregisterRunController()
        unregisterLiveSteer?.()

        if (canonicalFailure) {
          await markConnectorInboundJobRecoveryRequired(
            routeContext.inboundJobId,
            "canonical_log_write_failed",
            {
              error:
                canonicalFailure instanceof Error
                  ? canonicalFailure.message
                  : String(canonicalFailure),
            }
          )
          await runEventJournal.append(
            executionRunId,
            semanticRunEvent("run.recovery_required", {
              reason: "canonical-log-write-failed",
            })
          )
          notifyImFailure(
            event.conversationKey,
            IM_FAILURE_NOTICE.replyFailed,
            `airun-canonical:${event.conversationKey}`
          )
          break
        }

        if (captured.sdkSessionId) {
          await setSdkSessionId(session.id, captured.sdkSessionId).catch(() => undefined)
        }

        let terminalProjectionRecorded = false
        try {
          await runProducer.finish("completed", Date.now(), "Response ready")
          terminalProjectionRecorded = true
        } catch {
          /* best-effort — the final reply still flows through below */
        }
        if (terminalProjectionRecorded) {
          const frozen = await waitForExecutionRunPresentationFreeze(executionRunId)
          if (!frozen) {
            await appendAudit({
              adapterId: outboundTarget.adapterId,
              kind: "adapter.error",
              at: Date.now(),
              conversationKey: outboundTarget.conversationKey,
              reason: "run_projection_freeze_timeout",
              message: "Execution timeline freeze timed out before the final reply",
              fields: { runId: executionRunId },
            }).catch(() => undefined)
          }
        }

        // ── Project text + A2UI surfaces into MessageSegment[] ──
        // The captured reply may include any combination of plain text
        // and A2UI surfaces (created via the builtin:a2ui-bridge MCP
        // tools). `assistantReplyToSegments` projects each surface into
        // a {type:"a2ui", surfaceId, content, plainTextMirror} segment
        // and appends the trailing markdown text — adapter serialisers
        // then route a2ui segments through `_shared/a2ui-mapper.ts` per
        // platform (Slack Block Kit / Lark Interactive Card / Telegram
        // InlineKeyboardMarkup / Discord Embed+Components / OneBot
        // basic segments + plainTextMirror).
        const recoveredPrefix = previousRecoveryAnchor?.partialOutput ?? ""
        const recoveredText =
          recoveredPrefix && !captured.text.startsWith(recoveredPrefix)
            ? `${recoveredPrefix}${captured.text}`
            : captured.text
        const outboundSegments: MessageSegment[] = assistantReplyToSegments({
          text: recoveredText,
          a2uiSurfaces: captured.a2uiSurfaces,
          a2uiSurfaceOrder: captured.a2uiSurfaceOrder,
          telemetry: {
            adapterId: outboundTarget.adapterId,
            platform: outboundTarget.deliveryTarget.address.platform,
          },
        })
        const idempotencyKey = `airun:${captured.messageId}`
        // ── Reply quoting (ADR-0009 §3A.3) ──
        // In group / thread scopes, quote the triggering message so a busy
        // channel can tell which message the bot is answering. Only when the
        // reply goes back through the RECEIVING conversation (a respond-via
        // sibling posts into a conversation where `event.messageId` does not
        // exist), the platform declares `send.reply`, and neither the
        // conversation override nor the bot default opted out. Private chats
        // never quote — there is a single interlocutor.
        const quoteReply =
          streamsThroughReceiver &&
          event.channel.kind !== "private" &&
          hasEffectiveCapability(
            effectiveCapabilitiesForRow(adapterRow, { scopeKind: event.channel.kind }),
            "send.reply"
          ) &&
          (override?.replyQuoting ?? adapterRow.replyQuoting ?? true)
        // ── The one place acceptance changes anything ──
        //
        // The turn is finished and identical either way; what differs is
        // whether its product ships or waits for a human. That is why `draft`
        // stopped being a route: routing it separately meant deciding WHO runs
        // the turn from a flag about WHO signs off on it.
        if (requireAcceptance) {
          const draftSegments: MessageSegment[] = outboundSegments.length
            ? outboundSegments
            : [{ type: "text", text: recoveredText }]
          const draft = await createDraft({
            conversationKey: event.conversationKey,
            sessionId: session.id,
            segments: draftSegments,
            sourceMessageId: storedMsg.id,
          })
          await appendAudit({
            adapterId: event.adapterId,
            kind: "draft.prepared",
            at: Date.now(),
            conversationKey: event.conversationKey,
            fields: {
              draftId: draft.id,
              sourceMessageId: storedMsg.id,
              assistantMessageId: captured.messageId,
              // Recorded because the old branch could not: a draft now names
              // the target that produced it, so "the team was bound and the
              // draft came from one character anyway" is auditable rather than
              // invisible.
              ...(effectiveTeamId ? { teamId: effectiveTeamId } : {}),
              ...(effectiveWorkflowId ? { workflowId: effectiveWorkflowId } : {}),
            },
          })
          break
        }

        // Deliver through the respond-via target resolved above (falls back to
        // the receiving bot on any invalid target).
        await enqueueOutbound({
          adapterId: outboundTarget.adapterId,
          conversationKey: outboundTarget.conversationKey,
          request: {
            conversationRef: outboundTarget.conversationRef,
            deliveryTarget: outboundTarget.deliveryTarget,
            segments: outboundSegments,
            ...(quoteReply ? { replyTo: { messageId: event.messageId } } : {}),
            metadata: {
              idempotencyKey,
              sourceMessageId: storedMsg.id,
            },
          },
          source: "ai-run",
        })

        await appendAudit({
          adapterId: event.adapterId,
          kind: "outbound.ai_run_enqueued",
          at: Date.now(),
          conversationKey: event.conversationKey,
          idempotencyKey,
          message: captured.messageId,
          fields: {
            assistantMessageId: captured.messageId,
            sourceMessageId: storedMsg.id,
            ...(outboundTarget.adapterId !== event.adapterId
              ? { respondViaAdapterId: outboundTarget.adapterId }
              : {}),
          },
        })

        // Close the agent-trace root span with the turn's token usage + cost.
        // The inbound path routes through `safeSendPrompt`, which — ONLY when a
        // provider override is configured (`sendOptions.provider`) — records a
        // `recordProviderOutcome` child span under this same root that already
        // carries the LLM cost/usage. To avoid double-booking, the root span
        // owns the accounting only when there is NO provider child span; with a
        // provider set it closes with metadata alone. No-op when minting was
        // skipped (suppressed turns).
        if (sendOptions.spanId) {
          const u = captured.usage
          const ownsAccounting = !sendOptions.provider
          endSpan(sendOptions.spanId, {
            responseModel: sendOptions.model,
            ...(ownsAccounting && typeof u?.totalCostUsd === "number"
              ? { costUsdEstimate: u.totalCostUsd }
              : {}),
            ...(ownsAccounting && u
              ? {
                  usage: {
                    inputTokens: u.inputTokens ?? 0,
                    outputTokens: u.outputTokens ?? 0,
                    cacheCreationTokens: u.cacheCreationInputTokens ?? 0,
                    cacheReadTokens: u.cacheReadInputTokens ?? 0,
                  },
                }
              : {}),
            metadata: { assistantMessageId: captured.messageId },
          })
        }
        break
      }

      case "manual-store":
      case "store-only":
        // StoredMessage already inserted; nothing more to do.
        break
    }
  }
}
