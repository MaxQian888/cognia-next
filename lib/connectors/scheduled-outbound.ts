/**
 * Proactive outbound via scheduler — Task 108 + IM-completion §G2.
 *
 * Registers two scheduler-event handlers:
 *
 *   connection:outbound:send
 *     Payload: { adapterId, conversationKey, segments, idempotencyKey? }
 *     Action:  Calls enqueueOutbound directly — no AI involved.
 *
 *   connection:scheduled:digest
 *     Payload: { adapterId, conversationKey, characterId, prompt }
 *     Action:  Drives a real AI turn via the full build-options pipeline:
 *              resolveSendOptions → safeSendPrompt (PII gate) →
 *              assistantReplyToSegments → enqueueOutbound. A2UI surfaces
 *              the assistant creates are projected into MessageSegment.a2ui
 *              segments so adapters can route them through the per-platform
 *              A2UI mappers.
 *
 * Call `installScheduledOutboundHandlers()` once at app startup — done
 * synchronously in `ConnectorBusProvider`'s boot effect, before the async
 * adapter/runner boot, so the executors are registered before any due
 * `connection:*` scheduler task can fire.
 */

import { registerTaskExecutor } from "@/lib/scheduler/task-scheduler"
import { enqueueAuthorized, type OutboundAuthorization } from "@/lib/connectors/delivery-gateway"
import {
  taskPlanOrigin,
  type ActionReviewPlanOrigin,
} from "@/lib/policy/action-review/plan-context"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { resolveCharacterById } from "@/lib/db/characters"
import { getSettings } from "@/lib/db/settings"
import { resolveSendOptions, type InboxSendPolicy } from "@/lib/claude/build-options"
import { resolveInboxSuppression } from "./policy-resolve"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import { tryBuildMemoryDeps } from "@/lib/memory/runtime/build-deps"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { assistantReplyToSegments } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { safeSendPrompt, PiiGateBlocked } from "@/lib/connectors/ai-loop/safe-send-prompt"
import {
  formatScheduledSlot,
  resolveScheduledNoticeI18n,
} from "@/lib/connectors/scheduled-notice-i18n"
import { isLateDelivery } from "@/lib/scheduler/catchup-policy"
import { findSessionByConversationKey } from "./runtime"
import { registerImElicitationContext } from "./hitl/im-elicitation-context"
import { makeImPermissionResponder } from "./hitl/tool-approval"
import {
  createUnattendedPermissionResponder,
  needsApprovalSummary,
  NEEDS_APPROVAL_STATUS,
} from "@/lib/claude/unattended-permission-responder"
import { createUnattendedPark } from "@/lib/claude/unattended-park"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import type { OutboundToolPlannerOptions } from "@/lib/policy/action-review/plan-tool-call"
import { holdExecutionClock } from "@/lib/scheduler/execution-clock"
import {
  AGENT_CAPABILITY_GRANT_SCHEMA_VERSION,
  type AgentCapabilityGrantV1,
} from "@cognia/agent-config-types/agent-capability-grant"
import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import { appendAudit } from "./audit"
import type { MessageSegment } from "@/types/connectors/segment"
import {
  parseConversationKey,
  type ConversationDeliveryTarget,
  type ConversationReference,
} from "@/types/connectors/event"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import type { OutboundJobSource, OutboundJobWorkflowSource } from "@/lib/db/connector-types"
import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"

// ---------------------------------------------------------------------------
// Payload shapes (informal — the scheduler passes Record<string,unknown>)
// ---------------------------------------------------------------------------

interface OutboundSendPayload {
  adapterId: string
  conversationKey: string
  segments: MessageSegment[]
  idempotencyKey?: string
  /**
   * Provenance override (added at schema v41). Workflows that drop a job
   * onto the scheduler MUST pass `source: "workflow"` + `sourceWorkflow`
   * so the inbox UI can show the right badge. Manual user schedules can
   * omit this; the handler defaults to `"manual"` because the dominant
   * use of the connector outbound scheduler is a human queuing a future
   * send (recurring reminder, time-zone-aware broadcast, etc.).
   */
  source?: OutboundJobSource
  sourceWorkflow?: OutboundJobWorkflowSource
}

interface ScheduledDigestPayload {
  adapterId: string
  conversationKey: string
  characterId: string
  prompt: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isOutboundSendPayload(d: unknown): d is OutboundSendPayload {
  if (!d || typeof d !== "object") return false
  const p = d as Record<string, unknown>
  return (
    typeof p.adapterId === "string" &&
    typeof p.conversationKey === "string" &&
    Array.isArray(p.segments)
  )
}

function isScheduledDigestPayload(d: unknown): d is ScheduledDigestPayload {
  if (!d || typeof d !== "object") return false
  const p = d as Record<string, unknown>
  return (
    typeof p.adapterId === "string" &&
    typeof p.conversationKey === "string" &&
    typeof p.characterId === "string" &&
    typeof p.prompt === "string"
  )
}

// ---------------------------------------------------------------------------
// Handler: connection:outbound:send
// ---------------------------------------------------------------------------

async function handleOutboundSend(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<{ success: boolean; output?: Record<string, unknown>; error?: string }> {
  if (signal?.aborted) {
    return { success: false, error: "Outbound send aborted" }
  }
  const payload = execution.input ?? task.payload
  if (!isOutboundSendPayload(payload)) {
    return { success: false, error: "Invalid connection:outbound:send payload" }
  }

  const { adapterId, conversationKey, segments, idempotencyKey } = payload
  const now = Date.now()

  const deliveryTarget = (await getConnectorConversationState(conversationKey))?.deliveryTarget
  if (!deliveryTarget || deliveryTarget.address.adapterId !== adapterId) {
    return {
      success: false,
      error: "No persisted delivery target is available for this scheduled conversation",
    }
  }

  try {
    const result = await enqueueAuthorized({
      adapterId,
      conversationKey,
      request: {
        conversationRef: deliveryTarget.conversationRef,
        deliveryTarget,
        segments,
        metadata: {
          idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
        },
      },
      source: payload.source ?? "manual",
      sourceWorkflow: payload.source === "workflow" ? payload.sourceWorkflow : undefined,
      // Whoever wrote the task, nobody is watching when it fires (ADR-0239).
      authorization: {
        kind: "unattended",
        ownerRef: `task:${task.id}`,
        origin: taskPlanOrigin(task),
      },
    })
    if (result.kind === "drafted") {
      // Held for a person to approve: the task did what it can, so it is not
      // retried into a second draft.
      return { success: true, output: { draftId: result.draft.id, heldAsDraft: true } }
    }
    const job = result.job

    await appendAudit({
      adapterId,
      kind: "outbound.enqueued",
      at: now,
      conversationKey,
      message: `scheduler:outbound:send jobId=${job.id}`,
    })

    return { success: true, output: { jobId: job.id } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

// ---------------------------------------------------------------------------
// Handler: connection:scheduled:digest
// ---------------------------------------------------------------------------

/**
 * The runAndCapture-style wrapper the digest handler drives. Defaults to
 * `safeSendPrompt` (PII gate + the production capture). Tests inject a
 * mock returning a deterministic `{text, messageId, a2uiSurfaces?}`.
 */
type DigestSendPromptFn = typeof safeSendPrompt

let injectedDigestSender: DigestSendPromptFn = safeSendPrompt

/**
 * Test hook — swap the sendPrompt implementation. Exported so the
 * connector test suite can drive deterministic AI replies without
 * spinning up the sidecar.
 */
export function __setDigestSendPromptForTesting(fn: DigestSendPromptFn | null): void {
  injectedDigestSender = fn ?? safeSendPrompt
}

/**
 * Who answers the digest turn's tool requests (ADR-0239). It also decides how
 * the turn's outbound calls are planned: attended in the conversation a person
 * clicked in, unattended otherwise.
 *
 * - `parked`: a scheduled digest. A request waits for a person on the desktop
 *   or a paired phone (ADR-0224 A7); the wait stops the turn's and the
 *   execution's clocks, and the park bounds it.
 * - `conversation`: a turn a person started in the conversation by clicking a
 *   card. A request becomes an approval card there, like an IM reply's.
 * - `none`: nobody can answer (an external agent asked for the turn). A request
 *   is denied at once.
 *
 * Whatever answers, a request that went unapproved for want of an answer ends
 * the run `needs_approval`.
 */
export type DigestApprover =
  | {
      kind: "parked"
      /** Shown on the parked approval. */
      label: string
      /** The origin the turn's outbound calls are planned in. */
      outboundOrigin: () => Promise<ActionReviewPlanOrigin>
      /** The scheduled execution's signal: it holds the execution's clock. */
      signal?: AbortSignal
    }
  | {
      kind: "conversation"
      /** remoteUserId of the person who clicked; they may answer the cards. */
      initiatorUserId?: string
    }
  | {
      kind: "none"
      /** Where the turn came from, for the message the model is given. */
      surface: string
    }

/**
 * Input shape for the core AI-loop runner. Used by both the scheduled
 * task executor and the connector-callback handler so both code paths
 * share one production-grade implementation (resolveSendOptions →
 * safeSendPrompt → assistantReplyToSegments → enqueueOutbound).
 */
export interface RunDigestInput {
  adapterId: string
  conversationKey: string
  /** Optional character override; falls back to session.characterId. */
  characterId?: string
  /** The user-visible prompt the assistant should respond to. */
  prompt: string
  /** Optional id surfaced in audit fields (scheduled task id, callback trigger id, etc.). */
  sourceTaskId?: string
  /**
   * The slot this run was supposed to fire at, when it fired LATE (catch-up or
   * backfill). Set it and the reply carries a "delayed" note, because a digest
   * that lands at 09:12 otherwise reads as the 09:12 state. Leave undefined for
   * on-time runs and for callback-driven turns, which are never late.
   */
  lateForSlot?: Date
  /**
   * What authorizes delivering the reply (ADR-0239): the task's origin for a
   * scheduled digest, the clicked conversation for a callback turn. Default:
   * an unattended send in the bound session's origin.
   */
  authorization?: OutboundAuthorization
  /** Who answers the turn's tool requests. Default: nobody (`none`). */
  approver?: DigestApprover
  /** Customise the turn (a scheduled digest's unattended permission profile). */
  capabilityGrants?: AgentCapabilityGrantV1[]
  /** Cancels the turn (the scheduled execution's signal). */
  signal?: AbortSignal
}

export interface RunDigestResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
  /** `needs-approval` when a tool request went unapproved for want of an answer. */
  terminalReason?: "needs-approval"
}

/** The digest turn's permission handling, built from its {@link DigestApprover}. */
interface DigestPermissions {
  onPermissionRequest: (request: PermissionRequestEvent) => Promise<CapturePermissionDecision>
  outboundPolicy: OutboundToolPlannerOptions
  pauseTimeoutWhileAwaitingPermission: boolean
  /** True once a request went unapproved for want of an answer. */
  needsApproval: () => boolean
  /** One line for the run list: `needs approval: im_broadcast`. */
  summary: () => string
  /** The requests nobody approved, in arrival order. */
  denials: () => readonly { requestId: string; toolName: string }[]
  finish: (status: "completed" | "failed" | "cancelled") => Promise<void>
}

function digestPermissions(
  approver: DigestApprover,
  turn: {
    sessionId: string
    projectId?: string
    adapterId: string
    conversationKey: string
    /** Absent when the conversation's platform is unknown: no card can reach it. */
    conversationRef?: ConversationReference
    deliveryTarget?: ConversationDeliveryTarget
    approvalMode?: "prompt" | "yolo"
    signal: AbortSignal
  }
): DigestPermissions {
  if (approver.kind === "parked") {
    const responder = createUnattendedPermissionResponder("scheduled digest", {
      park: createUnattendedPark({
        origin: "scheduler",
        sessionId: turn.sessionId,
        label: approver.label,
        ...(turn.projectId ? { projectId: turn.projectId } : {}),
        signal: turn.signal,
      }),
    })
    return {
      onPermissionRequest: async (request) => {
        // A parked request is a person's think-time, not the task running long.
        const release = holdExecutionClock(approver.signal)
        try {
          return await responder.onPermissionRequest(request)
        } finally {
          release()
        }
      },
      outboundPolicy: { unattended: true, origin: approver.outboundOrigin },
      pauseTimeoutWhileAwaitingPermission: true,
      needsApproval: responder.needsApproval,
      summary: () => needsApprovalSummary(responder),
      denials: () => responder.denials,
      finish: (status) => responder.finish(status),
    }
  }
  // Records what nobody approved: every request without a park, and a card
  // nobody answered before it expired.
  const unanswered = createUnattendedPermissionResponder(
    approver.kind === "none" ? approver.surface : "connector callback"
  )
  const conversationRef = turn.conversationRef
  const common = {
    needsApproval: unanswered.needsApproval,
    summary: () => needsApprovalSummary(unanswered),
    denials: () => unanswered.denials,
    finish: async () => undefined,
  }
  if (approver.kind === "none" || !conversationRef) {
    return {
      ...common,
      onPermissionRequest: async (request) => unanswered.onPermissionRequest(request),
      outboundPolicy: { unattended: true },
      pauseTimeoutWhileAwaitingPermission: false,
    }
  }
  const card = makeImPermissionResponder({
    sessionId: turn.sessionId,
    adapterId: turn.adapterId,
    conversationKey: turn.conversationKey,
    conversationRef,
    ...(turn.deliveryTarget ? { deliveryTarget: turn.deliveryTarget } : {}),
    ...(turn.approvalMode ? { approvalMode: turn.approvalMode } : {}),
    ...(approver.initiatorUserId ? { initiatorUserId: approver.initiatorUserId } : {}),
    signal: turn.signal,
    onUnanswered: (request) => unanswered.onPermissionRequest(request),
  })
  return {
    ...common,
    onPermissionRequest: card,
    // The person who clicked is in the conversation and answers asks there.
    outboundPolicy: { unattended: false },
    // The card waits for a tap; its TTL bounds the wait.
    pauseTimeoutWhileAwaitingPermission: true,
  }
}

/**
 * Run one auto-mode AI turn against the given conversation. Pure async
 * function — no scheduler coupling — so the connector-callback handler
 * can call it directly without registering an extra task type.
 */
export async function runConnectorDigestTurn(input: RunDigestInput): Promise<RunDigestResult> {
  const { adapterId, conversationKey, characterId, prompt, sourceTaskId, lateForSlot } = input
  const now = Date.now()

  // ── Step 1: resolve the ChatSession bound to this conversation ────────
  // The session must already exist — scheduled digests don't auto-create
  // a session because there is no inbound user event to seed conversation
  // context. If the session is missing the task fails loud so the
  // operator can repair the binding.
  const session = await findSessionByConversationKey(conversationKey)
  if (!session) {
    await appendAudit({
      adapterId,
      kind: "adapter.error",
      at: now,
      conversationKey,
      reason: "session_missing",
      message: `scheduler:digest: no ChatSession for ${conversationKey}`,
    })
    return { success: false, error: `No ChatSession for ${conversationKey}` }
  }

  // ── Step 2: load adapter / override / character / settings ───────────
  // All best-effort. Missing rows degrade gracefully — resolveSendOptions
  // tolerates absent character/appSettings and the inbox policy reads
  // optional fields.
  const [adapterRow, overrideRow, appSettings, character] = await Promise.all([
    getAdapterInstance(adapterId).catch(() => undefined),
    readForResolution(conversationKey).catch(() => undefined),
    getSettings().catch(() => undefined),
    characterId
      ? resolveCharacterById(characterId).catch(() => undefined)
      : Promise.resolve(undefined),
  ])

  // Same resolver the inbound turn uses, so the digest cannot reach a
  // different conclusion about the same conversation. The mute half used to be
  // adapter-only here: a muted CONVERSATION still had its digest composed, and
  // the reply was only held at delivery.
  const suppression = resolveInboxSuppression(adapterRow ?? {}, overrideRow)
  const inboxPolicy: InboxSendPolicy = {
    quietHours: suppression.quietHours,
    muted: suppression.muted,
    forcedMode: overrideRow?.mode,
  }

  // Twin runtime injection (parity with runtime.ts ai-run + the in-app chat
  // path): ground a twin-bound character's digest reply in the twin's
  // knowledge. Best-effort — undefined when the twin runtime is disabled or
  // the character is not twin-bound.
  const twinHandshake = character?.twinId && prompt.trim() ? await tryBuildTwinDeps() : undefined

  // Long-term memory recall parity (see runtime.ts): ground the scheduled
  // digest reply in the operator's memory store. No-ops when memory is off.
  const memoryHandshake = prompt.trim()
    ? await tryBuildMemoryDeps(resolveMemoryConfig(appSettings?.memory))
    : undefined

  const sendOptions = await resolveSendOptions({
    session,
    character,
    appSettings,
    conversationKey,
    platformBinding: session.platformBinding,
    inboxPolicy,
    twinDeps: twinHandshake,
    twinUserMessage: twinHandshake ? prompt : undefined,
    memoryDeps: memoryHandshake,
    memoryUserMessage: memoryHandshake ? prompt : undefined,
    ...(input.capabilityGrants?.length ? { capabilityGrants: input.capabilityGrants } : {}),
  })

  // ── Step 3: suppression gate (quiet hours / muted / forced manual) ───
  if (sendOptions.suppressedReason) {
    await appendAudit({
      adapterId,
      kind:
        sendOptions.suppressedReason === "quiet_hours"
          ? "inbound.deferred_quiet_hours"
          : sendOptions.suppressedReason === "muted"
            ? "inbound.deferred_muted"
            : "inbound.deferred_manual_mode",
      at: now,
      conversationKey,
      reason: sendOptions.suppressedReason,
      message: "scheduler:digest suppressed",
    })
    return { success: true, output: { suppressed: sendOptions.suppressedReason } }
  }

  // ── Step 4: drive the AI turn (PII gate + capture) ──────────────────
  // Register the IM elicitation context for the duration of the capture so a
  // digest/callback-fed `ask_user` call lands on an interactive card in this
  // conversation instead of the unwatched desktop dialog. Digest turns have
  // no single requester — anyone in the conversation may answer, hence the
  // explicit `conversation` actor scope. When the platform cannot be resolved
  // at all (no adapter row, malformed key) the card could never be addressed,
  // so the registration is skipped and the tool falls back to the desktop.
  const digestDeliveryTarget = session.platformBinding?.deliveryTarget
  let elicitationPlatform: PlatformKind | undefined =
    adapterRow?.type ?? digestDeliveryTarget?.address.platform
  if (!elicitationPlatform) {
    try {
      elicitationPlatform = parseConversationKey(conversationKey).platform
    } catch {
      elicitationPlatform = undefined
    }
  }
  const elicitationController = new AbortController()
  const turnSignal = input.signal
    ? AbortSignal.any([elicitationController.signal, input.signal])
    : elicitationController.signal
  const permissions = digestPermissions(
    input.approver ?? { kind: "none", surface: "connector digest" },
    {
      sessionId: session.id,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      adapterId,
      conversationKey,
      // A card can only be answered where it can be addressed.
      ...(elicitationPlatform
        ? {
            conversationRef: digestDeliveryTarget?.conversationRef ?? {
              platform: elicitationPlatform,
              adapterId,
            },
          }
        : {}),
      ...(digestDeliveryTarget ? { deliveryTarget: digestDeliveryTarget } : {}),
      ...(overrideRow?.approvalMode ? { approvalMode: overrideRow.approvalMode } : {}),
      signal: turnSignal,
    }
  )
  const unregisterImElicitation = elicitationPlatform
    ? registerImElicitationContext({
        sessionId: session.id,
        adapterId,
        conversationKey,
        conversationRef: digestDeliveryTarget?.conversationRef ?? {
          platform: elicitationPlatform,
          adapterId,
        },
        ...(digestDeliveryTarget ? { deliveryTarget: digestDeliveryTarget } : {}),
        actorScope: { mode: "conversation" },
        signal: elicitationController.signal,
      })
    : undefined
  let captured: Awaited<ReturnType<DigestSendPromptFn>>
  try {
    captured = await injectedDigestSender(session.id, prompt, sendOptions, {
      adapterId,
      conversationKey,
      ...(input.signal ? { signal: input.signal } : {}),
      onPermissionRequest: permissions.onPermissionRequest,
      outboundPolicy: permissions.outboundPolicy,
      ...(permissions.pauseTimeoutWhileAwaitingPermission
        ? { pauseTimeoutWhileAwaitingPermission: true }
        : {}),
    })
  } catch (err) {
    await permissions.finish(input.signal?.aborted ? "cancelled" : "failed")
    const reason = err instanceof PiiGateBlocked ? "pii_blocked" : "ai_run_capture_failed"
    const msg = err instanceof Error ? err.message : String(err)
    await appendAudit({
      adapterId,
      kind: "adapter.error",
      at: Date.now(),
      conversationKey,
      reason,
      message: msg,
    })
    return { success: false, error: msg }
  } finally {
    // The context dies with the turn — abort settles a prompt still pending
    // (defensive; a suspended ask_user blocks the capture above) and hides
    // the registration from any late plugin_tool_exec event.
    elicitationController.abort()
    unregisterImElicitation?.()
  }
  // The turn is over: close the run a parked request opened.
  await permissions.finish("completed")
  // A request nobody approved: the reply (which says what is still pending) is
  // delivered as usual, and the run is marked `needs_approval`.
  const settle = (result: RunDigestResult): RunDigestResult =>
    result.success && permissions.needsApproval()
      ? {
          success: false,
          error: permissions.summary(),
          terminalReason: "needs-approval",
          output: {
            ...result.output,
            status: NEEDS_APPROVAL_STATUS,
            needsApproval: [...permissions.denials()],
          },
        }
      : result

  // ── Step 5: project text + A2UI surfaces into outbound segments ─────
  const deliveryTarget = session.platformBinding?.deliveryTarget
  if (!deliveryTarget || deliveryTarget.address.adapterId !== adapterId) {
    return { success: false, error: "Scheduled digest has no persisted delivery target" }
  }
  const platform = deliveryTarget.address.platform
  // A run that fired from a missed slot is labelled before projection, so the
  // note rides the same `text` segment every adapter already knows how to send
  // (rather than needing a per-platform surface). See `catchup-policy.ts` for
  // which task types can be late at all.
  const locale = appSettings?.language
  const deliveredText = lateForSlot
    ? `${resolveScheduledNoticeI18n(locale).lateDelivery(
        formatScheduledSlot(lateForSlot, locale)
      )}\n\n${captured.text}`
    : captured.text
  const outboundSegments: MessageSegment[] = assistantReplyToSegments({
    text: deliveredText,
    a2uiSurfaces: captured.a2uiSurfaces,
    a2uiSurfaceOrder: captured.a2uiSurfaceOrder,
    telemetry: { adapterId, platform },
  })
  const idempotencyKey = `airun:${captured.messageId}`

  // Re-derive the platform from the conversationKey rather than trusting
  // a payload field — the conversationKey format is the single source of
  // truth (it round-trips through `buildConversationKey`).
  try {
    const delivered = await enqueueAuthorized({
      adapterId,
      conversationKey,
      request: {
        conversationRef: deliveryTarget.conversationRef,
        deliveryTarget,
        segments: outboundSegments,
        metadata: {
          idempotencyKey,
          scheduledTaskId: sourceTaskId,
        },
      },
      source: "ai-run",
      authorization: input.authorization ?? {
        kind: "unattended",
        ownerRef: `digest:${sourceTaskId ?? conversationKey}`,
        sessionId: session.id,
      },
    })
    if (delivered.kind === "drafted") {
      return settle({
        success: true,
        output: {
          draftId: delivered.draft.id,
          heldAsDraft: true,
          assistantMessageId: captured.messageId,
        },
      })
    }
    const job = delivered.job

    await appendAudit({
      adapterId,
      kind: "outbound.ai_run_enqueued",
      at: Date.now(),
      conversationKey,
      idempotencyKey,
      message: captured.messageId,
      fields: {
        scheduledTaskId: sourceTaskId,
        a2uiSurfaceCount: captured.a2uiSurfaceOrder?.length ?? 0,
      },
    })

    return settle({
      success: true,
      output: {
        jobId: job.id,
        a2uiSurfaceCount: captured.a2uiSurfaceOrder?.length ?? 0,
        assistantMessageId: captured.messageId,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

/**
 * Thin task-executor adapter: unpacks the scheduler payload and calls
 * the shared `runConnectorDigestTurn`. Keeps the scheduler/executor
 * contract decoupled from the core AI-loop logic so the connector
 * callback channel can call the same core without going through the
 * scheduler.
 */
async function handleScheduledDigest(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<RunDigestResult> {
  if (signal?.aborted) {
    return { success: false, error: "Scheduled digest aborted" }
  }
  const payload = execution.input ?? task.payload
  if (!isScheduledDigestPayload(payload)) {
    return { success: false, error: "Invalid connection:scheduled:digest payload" }
  }
  // `scheduledFor` is the slot the scheduler intended; on a catch-up/backfill run
  // it is in the past, and the reply says so. Absent it there is nothing honest
  // to claim, so the note is skipped even for a late trigger source.
  const lateForSlot =
    isLateDelivery(execution.triggerSource) && execution.scheduledFor
      ? execution.scheduledFor
      : undefined
  return runConnectorDigestTurn({
    adapterId: payload.adapterId,
    conversationKey: payload.conversationKey,
    characterId: payload.characterId,
    prompt: payload.prompt,
    sourceTaskId: task.id,
    lateForSlot,
    authorization: {
      kind: "unattended",
      ownerRef: `task:${task.id}`,
      origin: taskPlanOrigin(task),
    },
    // Nobody is watching: a tool request parks for a person instead of going
    // unanswered, and the turn runs under the unattended permission profile.
    approver: {
      kind: "parked",
      label: `Scheduled digest: ${task.name}`,
      outboundOrigin: async () => taskPlanOrigin(task),
      signal,
    },
    capabilityGrants: [
      {
        schemaVersion: AGENT_CAPABILITY_GRANT_SCHEMA_VERSION,
        source: { kind: "scheduler", id: task.id },
        permissionProfile: {},
      },
    ],
    signal,
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register the two connector scheduler-event handlers.
 * Safe to call multiple times (registerTaskExecutor overwrites).
 */
export function installScheduledOutboundHandlers(): void {
  registerTaskExecutor("connection:outbound:send", handleOutboundSend)
  registerTaskExecutor("connection:scheduled:digest", handleScheduledDigest)
}
