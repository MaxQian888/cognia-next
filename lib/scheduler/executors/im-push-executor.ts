/**
 * `im-push` scheduled-task executor.
 *
 * Pushes a message into an already-bound IM conversation on a schedule
 * (daily digest text, a reminder, a status line). It converges on the SAME
 * governed outbound primitive as `connection:outbound:send`
 * (`enqueueGoverned` in `lib/connectors/delivery-gateway`) but is meant for
 * hand-authored tasks, so it is deliberately stricter than the connector's
 * own bulk task type:
 *
 *   1. the delivery target is resolved from the persisted
 *      `connectorConversationState` — the payload only names the conversation
 *      (no `adapterId` to get wrong);
 *   2. the per-conversation proactive-push opt-in
 *      (`ConversationOverrideRow.proactivePush`) is enforced fail-closed,
 *      exactly like the Notification Center's IM channel
 *      (`lib/notifications/im-deliver.ts`) — a customer-facing chat never
 *      gets a surprise push;
 *   3. the text passes the PII gate (`hasNoLeakingPii`, the cross-cutting
 *      redaction gate from CLAUDE.md) before it leaves the app;
 *   4. the job is idempotency-keyed on `<taskId>:<executionId>` (overridable)
 *      so a retried execution never double-sends.
 *
 * Every refusal is audited under the same `notify.im_*` kinds the center uses
 * so operators see one consistent trail. Host requirement:
 * `connector-runtime` (desktop / headless brain) — see `host-support.ts`.
 */

import type {
  ImPushTaskPayload,
  ScheduledTask,
  TaskExecution,
  TaskExecutorResult,
} from "@/types/scheduler"
import type { MessageSegment } from "@/types/connectors/segment"
import { hasNoLeakingPii } from "@cognia/redact"
import { loggers } from "@cognia/logging"
import { assertTaskTypeSupportedOnHost } from "../host-support"

const log = loggers.scheduler

/** Injectable collaborators (tests / alternate hosts). */
export interface ImPushExecutorDeps {
  getConversationState?: typeof import("@/lib/db/connector-conversation-state").getConnectorConversationState
  readOverride?: typeof import("@/lib/db/conversation-overrides").readForResolution
  enqueue?: typeof import("@/lib/connectors/delivery-gateway").enqueueGoverned
  audit?: typeof import("@/lib/connectors/audit").appendAudit
  /** PII gate; returns true when SAFE to send. Defaults to `hasNoLeakingPii`. */
  isPiiSafe?: (text: string) => boolean
}

function normalizePayload(
  raw: unknown
):
  | { conversationKey: string; segments: MessageSegment[]; idempotencyKey?: string }
  | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "im-push task requires a payload with `conversationKey`" }
  }
  const payload = raw as Partial<ImPushTaskPayload>
  if (typeof payload.conversationKey !== "string" || payload.conversationKey.trim().length === 0) {
    return { error: "im-push task requires `conversationKey` in payload" }
  }
  let segments: MessageSegment[] | undefined
  if (Array.isArray(payload.segments) && payload.segments.length > 0) {
    const invalid = payload.segments.find(
      (segment) => !segment || typeof segment !== "object" || typeof segment.type !== "string"
    )
    if (invalid) return { error: "im-push task `segments` must be MessageSegment objects" }
    segments = payload.segments
  } else if (typeof payload.text === "string" && payload.text.trim().length > 0) {
    segments = [{ type: "text", text: payload.text }]
  }
  if (!segments) {
    return { error: "im-push task requires a non-empty `text` or `segments` in payload" }
  }
  const idempotencyKey =
    typeof payload.idempotencyKey === "string" && payload.idempotencyKey.trim().length > 0
      ? payload.idempotencyKey.trim()
      : undefined
  return { conversationKey: payload.conversationKey.trim(), segments, idempotencyKey }
}

/** Text the PII gate inspects: every text segment joined (rich segments carry text too). */
function collectText(segments: MessageSegment[]): string {
  const parts: string[] = []
  for (const segment of segments) {
    if (segment.type === "text") parts.push(segment.text)
    else parts.push(JSON.stringify(segment))
  }
  return parts.join("\n")
}

export function createImPushExecutor(deps: ImPushExecutorDeps = {}) {
  return async function executeImPushTask(
    task: ScheduledTask,
    execution: TaskExecution,
    signal: AbortSignal
  ): Promise<TaskExecutorResult> {
    const refused = assertTaskTypeSupportedOnHost(task.type)
    if (refused) return refused

    const normalized = normalizePayload(execution.input ?? task.payload)
    if ("error" in normalized) return { success: false, error: normalized.error }
    const { conversationKey, segments } = normalized
    if (signal.aborted) return { success: false, error: "IM push aborted before start" }

    // Lazy imports keep the connector runtime graph out of the scheduler
    // executor module graph at load time.
    const [conversationStateMod, overridesMod, gatewayMod, auditMod] = await Promise.all([
      import("@/lib/db/connector-conversation-state"),
      import("@/lib/db/conversation-overrides"),
      import("@/lib/connectors/delivery-gateway"),
      import("@/lib/connectors/audit"),
    ])
    const getConversationState =
      deps.getConversationState ?? conversationStateMod.getConnectorConversationState
    const readOverride = deps.readOverride ?? overridesMod.readForResolution
    const enqueue = deps.enqueue ?? gatewayMod.enqueueGoverned
    const audit = deps.audit ?? auditMod.appendAudit
    const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
    const now = Date.now()

    const deliveryTarget = (await getConversationState(conversationKey))?.deliveryTarget
    if (!deliveryTarget) {
      return {
        success: false,
        error: `No persisted delivery target for conversation "${conversationKey}" — the bot must have exchanged at least one message with it.`,
      }
    }
    const adapterId = deliveryTarget.address.adapterId

    const override = await readOverride(conversationKey).catch(() => undefined)
    if (override?.proactivePush !== true) {
      await audit({
        adapterId,
        kind: "notify.im_skipped",
        at: now,
        conversationKey,
        reason: "opt_in_off",
        fields: { taskId: task.id, executionId: execution.id },
      })
      return {
        success: false,
        output: { conversationKey, adapterId, reason: "opt_in_off" },
        error:
          "Proactive push is switched off for this conversation — enable it in the conversation's settings before scheduling an IM push.",
      }
    }

    if (!isPiiSafe(collectText(segments))) {
      await audit({
        adapterId,
        kind: "notify.im_pii_blocked",
        at: now,
        conversationKey,
        reason: "pii_blocked",
        fields: { taskId: task.id, executionId: execution.id },
      })
      return {
        success: false,
        output: { conversationKey, adapterId, reason: "pii_blocked" },
        error:
          "IM push blocked by the PII gate — the message contains data that must not leave the app.",
      }
    }

    const idempotencyKey = normalized.idempotencyKey ?? `${task.id}:${execution.id}`
    try {
      const job = await enqueue({
        adapterId,
        conversationKey,
        request: {
          conversationRef: deliveryTarget.conversationRef,
          deliveryTarget,
          segments,
          metadata: { idempotencyKey },
        },
        source: "manual",
      })
      await audit({
        adapterId,
        kind: "notify.im_pushed",
        at: now,
        conversationKey,
        message: `scheduler:im-push jobId=${job.id}`,
        fields: { taskId: task.id, executionId: execution.id },
      })
      log.info("Scheduler im-push enqueued", {
        taskId: task.id,
        executionId: execution.id,
        conversationKey,
        jobId: job.id,
      })
      return {
        success: true,
        output: {
          jobId: job.id,
          adapterId,
          conversationKey,
          segments: segments.length,
          idempotencyKey,
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error("Scheduler im-push failed to enqueue", { taskId: task.id, error: message })
      return { success: false, output: { conversationKey, adapterId }, error: message }
    }
  }
}

/** Default executor registered by `registerBuiltInExecutors()`. */
export const executeImPushTask = createImPushExecutor()
