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
 * Call `installScheduledOutboundHandlers()` once at app startup (after the bus
 * and runner are initialised).
 */

import { registerTaskExecutor } from "@/lib/scheduler/task-scheduler"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { getCharacter } from "@/lib/db/characters"
import { getSettings } from "@/lib/db/settings"
import { resolveSendOptions, type InboxSendPolicy } from "@/lib/claude/build-options"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import { tryBuildMemoryDeps } from "@/lib/memory/runtime/build-deps"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { parseConversationKey } from "@/types/connectors/event"
import { assistantReplyToSegments } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { safeSendPrompt, PiiGateBlocked } from "@/lib/connectors/ai-loop/safe-send-prompt"
import { findSessionByConversationKey } from "./runtime"
import { appendAudit } from "./audit"
import type { MessageSegment } from "@/types/connectors/segment"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import type { OutboundJobSource, OutboundJobWorkflowSource } from "@/lib/db/connector-types"

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

  // Recover platform from the conversationKey so we don't lie about the
  // ref shape (the prior stub hard-coded `"telegram"`, which corrupted
  // any non-Telegram adapter the operator scheduled an outbound on).
  const { platform } = parseConversationKey(conversationKey)

  try {
    const job = await enqueueOutbound({
      adapterId,
      conversationKey,
      request: {
        conversationRef: { platform, adapterId },
        segments,
        metadata: {
          idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
        },
      },
      source: payload.source ?? "manual",
      sourceWorkflow: payload.source === "workflow" ? payload.sourceWorkflow : undefined,
    })

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
}

export interface RunDigestResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

/**
 * Run one auto-mode AI turn against the given conversation. Pure async
 * function — no scheduler coupling — so the connector-callback handler
 * can call it directly without registering an extra task type.
 */
export async function runConnectorDigestTurn(input: RunDigestInput): Promise<RunDigestResult> {
  const { adapterId, conversationKey, characterId, prompt, sourceTaskId } = input
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
    characterId ? getCharacter(characterId).catch(() => undefined) : Promise.resolve(undefined),
  ])

  const inboxPolicy: InboxSendPolicy = {
    quietHours: adapterRow?.quietHours,
    muted: adapterRow?.muted,
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
  let captured: Awaited<ReturnType<DigestSendPromptFn>>
  try {
    captured = await injectedDigestSender(session.id, prompt, sendOptions, {
      adapterId,
      conversationKey,
    })
  } catch (err) {
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
  }

  // ── Step 5: project text + A2UI surfaces into outbound segments ─────
  const outboundSegments: MessageSegment[] = assistantReplyToSegments({
    text: captured.text,
    a2uiSurfaces: captured.a2uiSurfaces,
    a2uiSurfaceOrder: captured.a2uiSurfaceOrder,
  })
  const idempotencyKey = `airun:${captured.messageId}`

  // Re-derive the platform from the conversationKey rather than trusting
  // a payload field — the conversationKey format is the single source of
  // truth (it round-trips through `buildConversationKey`).
  const { platform } = parseConversationKey(conversationKey)

  try {
    const job = await enqueueOutbound({
      adapterId,
      conversationKey,
      request: {
        conversationRef: session.platformBinding?.conversationRef ?? { platform, adapterId },
        segments: outboundSegments,
        metadata: {
          idempotencyKey,
          scheduledTaskId: sourceTaskId,
        },
      },
      source: "ai-run",
    })

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

    return {
      success: true,
      output: {
        jobId: job.id,
        a2uiSurfaceCount: captured.a2uiSurfaceOrder?.length ?? 0,
        assistantMessageId: captured.messageId,
      },
    }
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
): Promise<{ success: boolean; output?: Record<string, unknown>; error?: string }> {
  if (signal?.aborted) {
    return { success: false, error: "Scheduled digest aborted" }
  }
  const payload = execution.input ?? task.payload
  if (!isScheduledDigestPayload(payload)) {
    return { success: false, error: "Invalid connection:scheduled:digest payload" }
  }
  return runConnectorDigestTurn({
    adapterId: payload.adapterId,
    conversationKey: payload.conversationKey,
    characterId: payload.characterId,
    prompt: payload.prompt,
    sourceTaskId: task.id,
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
