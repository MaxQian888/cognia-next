/**
 * HostState ⇄ WorkSubmission adapter (ADR-0123).
 *
 * An attached client (mobile, web, CLI) does not run the chat controller, so
 * the renderer's acceptance never happens for its turns. The Host is where
 * those turns become real, and this is where they become durable.
 *
 * **The wire protocol is untouched.** `AllowedHostStateIntent` gains nothing:
 * every guard in `host-state.ts` is a closed shape that rejects any field it
 * does not know, so smuggling a submission field through an action would fail
 * the guard outright. Instead the Host wraps the `message.enqueue` it already
 * receives.
 *
 * ## Why the idempotency key matches the renderer's
 *
 * Both paths key on `chat:{sessionId}:{messageId}`. A turn that somehow reaches
 * the Host twice — once through the client outbox and once locally — is the
 * same work and must collapse onto one submission, one run, and one reply.
 * Deriving the key from the transport's `actionId` instead would make those two
 * arrivals look like different turns.
 *
 * The run id *does* come from `actionId`, because the Host has no chat run
 * counter and the action id is already the dedup key the runtime command uses.
 */

import type { HostStateAction } from "@cognia/agent-config-types/host-state"
import type { WorkReceiptV1 } from "@cognia/agent-config-types/work-submission"
import type { SendOptions } from "@cognia/agent-config-types"

import {
  claimWorkSubmission,
  getWorkSubmission,
  type WorkSubmissionRow,
} from "@/lib/db/work-submissions"

import { chatIdempotencyKey } from "./chat-adapter"
import { planWorkSubmissionRecovery, type WorkRecoveryDeps } from "./recovery"
import {
  acceptWorkSubmission,
  bindWorkExecutionContext,
  markWorkSubmissionStarted,
  settleWorkSubmissionWithoutTranscript,
  WorkSubmissionRejectedError,
  type WorkSubmissionServiceDeps,
} from "./service"

export interface HostAdapterDeps extends WorkSubmissionServiceDeps, WorkRecoveryDeps {
  onError?: (error: unknown) => void
  /**
   * Stop the runtime a previous owner handed this turn to, before a takeover
   * dispatches it again. Defaults to interrupting the submission's session.
   */
  abortPrevious?: (submission: WorkSubmissionRow) => Promise<void>
}

/**
 * `detail` key of a frozen HostState context whose turn carried attachment
 * refs. The frozen input holds the message text alone (a ref is not a content
 * address), so a replay from the ledger would send the words without the
 * files; the stored-chat replay refuses such a turn instead.
 */
export const HOST_STATE_ATTACHMENT_REFS_DETAIL = "hostStateAttachmentRefs"

/** Deterministic per action, so a redelivered action maps to the same run. */
export function hostStateRunId(actionId: string): string {
  return `hoststate:${actionId}`
}

export function hostStateSubmissionId(actionId: string): string {
  return `work:${hostStateRunId(actionId)}`
}

/**
 * Durably accept a `message.enqueue` before the Host dispatches it.
 *
 * Returns `null` when the feature is off, the action is not a message enqueue,
 * or it carries no session — in every case the Host proceeds exactly as it does
 * today. A rejection is reported and also yields `null`: an attached client's
 * message must not be dropped because a ledger insert failed.
 */
export async function acceptHostStateChatTurn(
  action: HostStateAction,
  deps: HostAdapterDeps = {}
): Promise<WorkReceiptV1 | null> {
  if (action.action.kind !== "message.enqueue") return null
  const sessionId = action.sessionId
  if (!sessionId) return null

  try {
    return await acceptWorkSubmission(
      {
        intent: {
          contractVersion: 1,
          // Same shape the renderer uses, so the two arrival paths collapse.
          idempotencyKey: chatIdempotencyKey(sessionId, action.action.messageId),
          source: { kind: "chat", sourceId: sessionId, triggerId: action.actionId },
          scope: {
            accountId: action.accountId,
            runtimeTargetId: action.runtimeTargetId,
            sessionId,
          },
          availabilityPolicy: "wait",
        },
        runId: hostStateRunId(action.actionId),
        turnId: hostStateRunId(action.actionId),
        submissionId: hostStateSubmissionId(action.actionId),
        inputBatchId: `input:${hostStateRunId(action.actionId)}`,
        input: {
          content: action.action.text,
          visibleMessageIds: [action.action.messageId],
          // HostState attachment refs carry a display name and size but no
          // content address, and the renderer gate already excludes any turn
          // with attachments from this path. Recording them as frozen inputs
          // would claim a fidelity the wire format cannot supply.
          attachments: [],
        },
      },
      deps
    )
  } catch (error) {
    deps.onError?.(error)
    if (error instanceof WorkSubmissionRejectedError) return null
    throw error
  }
}

/** Freeze the exact options the HostState production path is about to send. */
export async function bindHostStateChatTurnContext(
  action: HostStateAction,
  sendOptions: SendOptions,
  deps: HostAdapterDeps = {}
): Promise<boolean> {
  if (action.action.kind !== "message.enqueue" || !action.sessionId) return false
  try {
    const runId = hostStateRunId(action.actionId)
    const attachmentRefs = action.action.attachments.filter(
      (attachment) => typeof attachment.ref === "string" && attachment.ref.length > 0
    ).length
    const result = await bindWorkExecutionContext(
      {
        submissionId: hostStateSubmissionId(action.actionId),
        accountId: action.accountId,
        contextBundleId: `context:${runId}`,
        context: {
          ...(sendOptions.cwd ? { cwd: sendOptions.cwd } : {}),
          sendOptions,
          ...(attachmentRefs > 0
            ? { detail: { [HOST_STATE_ATTACHMENT_REFS_DETAIL]: attachmentRefs } }
            : {}),
        },
      },
      deps
    )
    return result.bound
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}

/** Record that the live HostState path successfully handed the turn off. */
export async function markHostStateChatTurnStarted(
  actionId: string,
  now = Date.now(),
  deps: HostAdapterDeps = {}
): Promise<boolean> {
  try {
    await markWorkSubmissionStarted(hostStateSubmissionId(actionId), now)
    return true
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}

/**
 * `legacy` — no submission exists, so the Host dispatches as it always has.
 * `claimed` — this Host owns the attempt and may send.
 * `owned_elsewhere` — another owner holds it, or it already settled.
 * `recovery_required` — an earlier attempt may have had effects; the
 * submission was settled for an explicit resume and must not be re-sent.
 */
export type HostStateTurnDispatchClaim =
  "legacy" | "claimed" | "owned_elsewhere" | "recovery_required"

/**
 * Fence HostState assembly before resolving provider options or transport.
 *
 * A HostState redrive (startup recovery, a periodic retry) reaches this with a
 * submission an earlier attempt may already have handed to the runtime. That
 * attempt is ambiguous in exactly the way the work outbox's is, so it gets the
 * same decision: the replay-safety plan runs before the claim, and a takeover
 * of a dispatched turn stops the previous runtime before anything is re-sent.
 * Two recovery paths with two policies is how a turn that already ran a tool
 * ends up running it again.
 */
export async function claimHostStateChatTurnForDispatch(
  actionId: string,
  now = Date.now(),
  deps: HostAdapterDeps = {}
): Promise<HostStateTurnDispatchClaim> {
  const submissionId = hostStateSubmissionId(actionId)
  let row: WorkSubmissionRow | undefined
  try {
    row = await getWorkSubmission(submissionId)
  } catch (error) {
    deps.onError?.(error)
    return "legacy"
  }
  if (!row) return "legacy"
  // From here the submission is known to exist, so a failure must not fall
  // back to an unfenced send: the work outbox owns the row and will decide.
  try {
    if (row.dispatchState === "settled") return "owned_elsewhere"
    // A live lease is a live owner. Planning against its row could settle a
    // turn that owner is handing off right now.
    if (
      (row.dispatchState === "claimed" || row.dispatchState === "dispatched") &&
      (row.leaseExpiresAt ?? 0) > now
    ) {
      return "owned_elsewhere"
    }
    const plan = await planWorkSubmissionRecovery(row, deps)
    if (plan.action === "recovery_required") {
      await settleWorkSubmissionWithoutTranscript(
        submissionId,
        "recovery_required",
        now,
        plan.reason
      )
      return "recovery_required"
    }
    const claimed = await claimWorkSubmission(submissionId, "host-state", now)
    if (!claimed) return "owned_elsewhere"
    if (claimed.takeoverRequired) {
      try {
        await (deps.abortPrevious ?? abortSubmissionSession)(claimed)
      } catch (error) {
        deps.onError?.(error)
        await settleWorkSubmissionWithoutTranscript(
          submissionId,
          "recovery_required",
          now,
          "takeover_abort_failed"
        )
        return "recovery_required"
      }
    }
    return "claimed"
  } catch (error) {
    deps.onError?.(error)
    return "owned_elsewhere"
  }
}

async function abortSubmissionSession(submission: WorkSubmissionRow): Promise<void> {
  if (!submission.sessionId) return
  const { interruptSession } = await import("@/lib/claude/ipc")
  await interruptSession(submission.sessionId)
}
