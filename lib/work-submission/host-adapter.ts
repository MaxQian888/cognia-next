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

import { claimWorkSubmission, getWorkSubmission } from "@/lib/db/work-submissions"

import { chatIdempotencyKey } from "./chat-adapter"
import {
  acceptWorkSubmission,
  bindWorkExecutionContext,
  markWorkSubmissionStarted,
  WorkSubmissionRejectedError,
  type WorkSubmissionServiceDeps,
} from "./service"

export interface HostAdapterDeps extends WorkSubmissionServiceDeps {
  onError?: (error: unknown) => void
}

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
    const result = await bindWorkExecutionContext(
      {
        submissionId: hostStateSubmissionId(action.actionId),
        accountId: action.accountId,
        contextBundleId: `context:${runId}`,
        context: {
          ...(sendOptions.cwd ? { cwd: sendOptions.cwd } : {}),
          sendOptions,
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

export type HostStateTurnDispatchClaim = "legacy" | "claimed" | "owned_elsewhere"

/** Fence HostState assembly before resolving provider options or transport. */
export async function claimHostStateChatTurnForDispatch(
  actionId: string,
  now = Date.now(),
  deps: HostAdapterDeps = {}
): Promise<HostStateTurnDispatchClaim> {
  const submissionId = hostStateSubmissionId(actionId)
  try {
    const claimed = await claimWorkSubmission(submissionId, "host-state", now)
    if (claimed) return "claimed"
    return (await getWorkSubmission(submissionId)) ? "owned_elsewhere" : "legacy"
  } catch (error) {
    deps.onError?.(error)
    return "legacy"
  }
}
