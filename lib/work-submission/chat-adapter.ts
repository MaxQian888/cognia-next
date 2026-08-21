/**
 * Direct Chat ⇄ WorkSubmission adapter (ADR-0123).
 *
 * The chat controller is a 2,000-line hook; putting freeze logic inline there
 * would make it untestable and would bury the one thing that matters. This
 * module owns that logic instead, and the controller calls three functions at
 * three precise points.
 *
 * ## The two freeze points, and why they are not one
 *
 * Reading `hooks/chat/use-claude-chat-controller.ts` top to bottom:
 *
 *   • `effectiveContent` is final at the Workbench payload gate — after plugin
 *     prompt hooks, pipe rewrites, and redaction. Nothing downstream changes
 *     what the model will be shown.
 *   • `sendOptions` keeps changing for hundreds of lines afterwards: the project
 *     root, the task workspace, the task execution root, and finally routing.
 *     It is only final immediately before `sendPrompt`.
 *
 * Freezing both at the first point would capture a context that is not yet
 * decided; freezing both at the second would leave the user's message
 * un-owned across everything in between — exactly the crash window this
 * feature exists to close. So {@link acceptChatTurn} runs at the first point
 * and {@link bindChatTurnContext} at the second.
 *
 * ## Degrading is a feature
 *
 * Every entry point returns `null`/`false` rather than throwing when the
 * feature is off, no runtime target is active, or the account is unknown. The
 * caller then behaves exactly as it does today. That is what makes the flag a
 * real kill switch instead of a code path nobody has exercised.
 */

import type { WorkReceiptV1 } from "@cognia/agent-config-types/work-submission"

import {
  claimWorkSubmission,
  getWorkSubmission,
  listWorkSubmissions,
} from "@/lib/db/work-submissions"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import type { WorkAttachmentRefV1 } from "@cognia/agent-config-types/work-submission"

import {
  acceptWorkSubmission,
  bindWorkExecutionContext,
  markWorkSubmissionStarted,
  settleWorkSubmission,
  WorkSubmissionRejectedError,
  type FrozenExecutionContext,
  type WorkSubmissionServiceDeps,
} from "./service"

export interface ChatTurnIdentity {
  sessionId: string
  /** The chat run id, already derived by the controller (`runIdForTurn`). */
  runId: string
  /** The user message id — stable, and what makes a resend idempotent. */
  messageId: string
}

export interface ChatTurnScope {
  accountId: string
  runtimeTargetId: string
}

export interface AcceptChatTurnInput extends ChatTurnIdentity {
  /** Exactly what the model will receive, captured at the content freeze point. */
  content: unknown
  visibleMessageIds: string[]
  attachments?: WorkAttachmentRefV1[]
  projectId?: string
  targetAvailable?: boolean
  writeTranscript?: () => Promise<void>
  now?: number
}

export interface ChatAdapterDeps extends WorkSubmissionServiceDeps {
  resolveScope?: () => ChatTurnScope | null
  onError?: (error: unknown) => void
}

/**
 * A chat turn's idempotency key.
 *
 * Keyed on the *message* rather than a fresh id per attempt: a resend of the
 * same composed message — a double-tapped send, a replayed HostState action,
 * a retried outbox entry — is the same work, and must resolve to the same
 * receipt rather than a second turn.
 */
export function chatIdempotencyKey(sessionId: string, messageId: string): string {
  return `chat:${sessionId}:${messageId}`
}

export function chatSubmissionId(runId: string): string {
  return `work:${runId}`
}

function defaultScope(): ChatTurnScope | null {
  const scope = getActiveRuntimeTargetContext()
  return scope ? { accountId: scope.accountId, runtimeTargetId: scope.targetId } : null
}

function resolve(deps: ChatAdapterDeps): ChatTurnScope | null {
  return (deps.resolveScope ?? defaultScope)()
}

/**
 * Phase A — durably accept the turn before anything is dispatched.
 *
 * Returns the receipt, or `null` when the adapter is not taking over. A
 * rejection (invalid intent, backlog full) is reported and also yields `null`:
 * refusing to send a message the user typed because a ledger insert failed
 * would be a worse outcome than running the turn the legacy way.
 */
export async function acceptChatTurn(
  input: AcceptChatTurnInput,
  deps: ChatAdapterDeps = {}
): Promise<WorkReceiptV1 | null> {
  const scope = resolve(deps)
  if (!scope) return null

  try {
    return await acceptWorkSubmission(
      {
        intent: {
          contractVersion: 1,
          idempotencyKey: chatIdempotencyKey(input.sessionId, input.messageId),
          source: { kind: "chat", sourceId: input.sessionId },
          scope: {
            accountId: scope.accountId,
            runtimeTargetId: scope.runtimeTargetId,
            sessionId: input.sessionId,
            ...(input.projectId ? { projectId: input.projectId } : {}),
          },
          // A person is watching this turn and can cancel it, so waiting for an
          // absent host beats failing the send out from under them.
          availabilityPolicy: "wait",
        },
        runId: input.runId,
        turnId: input.runId,
        submissionId: chatSubmissionId(input.runId),
        inputBatchId: `input:${input.runId}`,
        input: {
          content: input.content,
          visibleMessageIds: input.visibleMessageIds,
          attachments: input.attachments ?? [],
        },
        ...(input.targetAvailable === undefined ? {} : { targetAvailable: input.targetAvailable }),
        ...(input.writeTranscript ? { writeTranscript: input.writeTranscript } : {}),
        ...(input.now === undefined ? {} : { now: input.now }),
      },
      deps
    )
  } catch (error) {
    deps.onError?.(error)
    if (error instanceof WorkSubmissionRejectedError) return null
    throw error
  }
}

export interface BindChatTurnContextInput {
  runId: string
  context: FrozenExecutionContext
  executionFingerprint?: string
  now?: number
}

/**
 * Phase B — freeze the execution context immediately before dispatch.
 *
 * The spec is recorded as `shadow`: while the unified resolver is still rolling
 * out (ADR-0090), Direct Chat's routing is still the legacy path, and a
 * fingerprint stored here describes an observation rather than the decision
 * that governed the turn. Labelling it prevents it being read back as evidence
 * it never was.
 */
export async function bindChatTurnContext(
  input: BindChatTurnContextInput,
  deps: ChatAdapterDeps = {}
): Promise<boolean> {
  const scope = resolve(deps)
  if (!scope) return false

  try {
    const result = await bindWorkExecutionContext(
      {
        submissionId: chatSubmissionId(input.runId),
        accountId: scope.accountId,
        contextBundleId: `context:${input.runId}`,
        context: input.context,
        ...(input.executionFingerprint ? { executionFingerprint: input.executionFingerprint } : {}),
        specAuthority: "shadow",
        ...(input.now === undefined ? {} : { now: input.now }),
      },
      deps
    )
    return result.bound
  } catch (error) {
    // A missing submission means phase A declined or rolled back; the turn is
    // running the legacy way and must not be interrupted for a ledger write.
    deps.onError?.(error)
    return false
  }
}

/** Record that the live chat path successfully handed the frozen turn off. */
export async function markChatTurnStarted(
  runId: string,
  now = Date.now(),
  deps: ChatAdapterDeps = {}
): Promise<boolean> {
  if (!resolve(deps)) return false
  try {
    await markWorkSubmissionStarted(chatSubmissionId(runId), now)
    return true
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}

export type ChatTurnDispatchClaim = "legacy" | "claimed" | "owned_elsewhere"

/** Fence the live sender against the recovery outbox before transport handoff. */
export async function claimChatTurnForDispatch(
  runId: string,
  now = Date.now(),
  deps: ChatAdapterDeps = {}
): Promise<ChatTurnDispatchClaim> {
  if (!resolve(deps)) return "legacy"
  const submissionId = chatSubmissionId(runId)
  try {
    const claimed = await claimWorkSubmission(submissionId, "live-chat", now)
    if (claimed) return "claimed"
    return (await getWorkSubmission(submissionId)) ? "owned_elsewhere" : "legacy"
  } catch (error) {
    deps.onError?.(error)
    return "legacy"
  }
}

export interface SettleChatTurnInput {
  runId: string
  outcome: "completed" | "no_response" | "failed" | "cancelled"
  errorCode?: string
  writeTranscript?: () => Promise<void>
  now?: number
}

/**
 * Terminal — seal the turn exactly once.
 *
 * Four places in `claude-chat-events.ts` can observe a turn ending. All four
 * route here, and only the first wins: `writeTranscript` runs for that caller
 * alone, which is what makes a duplicate terminal event unable to produce a
 * duplicate assistant message.
 */
/**
 * Seal whichever turn is currently open in a session.
 *
 * The terminal call sites in `claude-chat-events.ts` only carry a session id —
 * the run id lives in module state inside `direct-chat-run.ts`. Resolving the
 * open submission from the session keeps those call sites unchanged rather
 * than threading a run id through four of them.
 *
 * Picks the newest unsettled submission: a session has at most one turn in
 * flight, and if an older one were somehow still open it is not the turn this
 * terminal event describes.
 */
export async function settleChatTurnForSession(
  sessionId: string,
  input: Omit<SettleChatTurnInput, "runId">,
  deps: ChatAdapterDeps = {}
): Promise<boolean> {
  if (!resolve(deps)) return false
  try {
    const [open] = await listWorkSubmissions({
      sessionId,
      dispatchStates: ["pending", "blocked", "claimed", "dispatched"],
      limit: 1,
    })
    if (!open) return false
    return await settleChatTurn({ ...input, runId: open.runId }, deps)
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}

export async function settleChatTurn(
  input: SettleChatTurnInput,
  deps: ChatAdapterDeps = {}
): Promise<boolean> {
  if (!resolve(deps)) return false
  try {
    return await settleWorkSubmission(
      {
        submissionId: chatSubmissionId(input.runId),
        outcome: input.outcome,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.writeTranscript ? { writeTranscript: input.writeTranscript } : {}),
        ...(input.now === undefined ? {} : { now: input.now }),
      },
      deps
    )
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}
