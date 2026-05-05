/**
 * Proactive outbound via scheduler — Task 108.
 *
 * Registers two scheduler-event handlers:
 *
 *   connection:outbound:send
 *     Payload: { adapterId, conversationKey, segments, idempotencyKey? }
 *     Action:  Calls enqueueOutbound directly — no AI involved.
 *
 *   connection:scheduled:digest
 *     Payload: { adapterId, conversationKey, characterId, prompt }
 *     Action:  Phase 1 stub — records an audit entry and enqueues a placeholder
 *              outbound job. Full AI pipeline (sendPrompt → capture → enqueue)
 *              is deferred to Task 40+ when runtime.ts gets the real sendPrompt
 *              wiring. The stub ensures the queue machinery is exercisable today.
 *
 * Call `installScheduledOutboundHandlers()` once at app startup (after the bus
 * and runner are initialised).
 */

import { registerTaskExecutor } from "@/lib/scheduler/task-scheduler"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { appendAudit } from "./audit"
import type { MessageSegment } from "@/types/connectors/segment"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

// ---------------------------------------------------------------------------
// Payload shapes (informal — the scheduler passes Record<string,unknown>)
// ---------------------------------------------------------------------------

interface OutboundSendPayload {
  adapterId: string
  conversationKey: string
  segments: MessageSegment[]
  idempotencyKey?: string
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
  execution: TaskExecution
): Promise<{ success: boolean; output?: Record<string, unknown>; error?: string }> {
  const payload = execution.triggerData ?? task.config?.parameters
  if (!isOutboundSendPayload(payload)) {
    return { success: false, error: "Invalid connection:outbound:send payload" }
  }

  const { adapterId, conversationKey, segments, idempotencyKey } = payload
  const now = Date.now()

  try {
    const job = await enqueueOutbound({
      adapterId,
      conversationKey,
      request: {
        conversationRef: { platform: "telegram", adapterId },
        segments,
        metadata: {
          idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
        },
      },
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

async function handleScheduledDigest(
  task: ScheduledTask,
  execution: TaskExecution
): Promise<{ success: boolean; output?: Record<string, unknown>; error?: string }> {
  const payload = execution.triggerData ?? task.config?.parameters
  if (!isScheduledDigestPayload(payload)) {
    return { success: false, error: "Invalid connection:scheduled:digest payload" }
  }

  const { adapterId, conversationKey } = payload
  const now = Date.now()

  // TODO(phase 1+): invoke real sendPrompt, capture final text, then enqueue
  // with that text as segments. The streaming-completion pipeline is deferred
  // to Task 40+; for Phase 1 we record intent and enqueue a placeholder.
  await appendAudit({
    adapterId,
    kind: "outbound.enqueued",
    at: now,
    conversationKey,
    message: "scheduler:digest:stub (AI call deferred to Phase 1+)",
  })

  try {
    const job = await enqueueOutbound({
      adapterId,
      conversationKey,
      request: {
        conversationRef: { platform: "telegram", adapterId },
        segments: [{ type: "text", text: "[Scheduled digest placeholder]" }],
        metadata: { idempotencyKey: crypto.randomUUID() },
      },
    })

    return { success: true, output: { jobId: job.id, stub: true } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
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
