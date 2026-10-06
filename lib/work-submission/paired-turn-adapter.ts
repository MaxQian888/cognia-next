/**
 * Paired direct-turn ⇄ WorkSubmission adapter (ADR-0123).
 *
 * A paired client sends its turns straight to this Host over Agent RPC
 * (`agent_send`), because only that path carries the turn's own options — the
 * provider and model it picked and a device-local key for this turn alone.
 * Nothing on the Host saw those turns arrive: the companion server wrote the
 * prompt to the sidecar and the brain only ever heard the frames that came
 * back. With no open submission for the session, the terminal-event persister
 * (`terminal-events.ts`) dropped every frame, and the reply was never kept on
 * the machine that produced it.
 *
 * The companion server now asks this module to admit each device-originated
 * turn before it hands the prompt over (`send_arm` in
 * `src-tauri/src/companion_api/rpc/chat.rs`). Admission writes the user's
 * message under the client's own id, accepts and claims a submission, and keeps
 * its lease alive until the persister settles it on `session_ended`.
 *
 * ## What is deliberately not stored
 *
 * The turn's `SendOptions` are never frozen into an execution-context bundle
 * (`bindWorkExecutionContext`): they may carry `providerCredentials`, and a
 * credential must not land in the Host's durable store. The cost is honest — a
 * Host that dies mid-turn cannot re-dispatch it, and recovery settles it as
 * `recovery_required` (`stored-chat-dispatch.ts`) rather than guessing options.
 *
 * Brain-originated sends (the HostState dispatcher) are already admitted by
 * `host-adapter.ts` and never reach here: the server skips the service scope.
 */

import type { UIMessage } from "ai"
import type { SendContent } from "@cognia/agent-config-types"

import { claimWorkSubmission } from "@/lib/db/work-submissions"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

import { chatSubmissionId } from "./chat-adapter"
import { startWorkSubmissionLeaseHeartbeat } from "./lease-heartbeat"
import {
  acceptWorkSubmission,
  markWorkSubmissionStarted,
  settleWorkSubmission,
  WorkSubmissionRejectedError,
  type WorkSubmissionServiceDeps,
} from "./service"

/** The internal bridge commands the companion server routes here. */
export const PAIRED_TURN_COMMANDS = ["paired_turn_admit", "paired_turn_abandon"] as const
export type PairedTurnCommand = (typeof PAIRED_TURN_COMMANDS)[number]

export function isPairedTurnCommand(command: string): command is PairedTurnCommand {
  return (PAIRED_TURN_COMMANDS as readonly string[]).includes(command)
}

/** Lease owner for the admitted row; distinct so a takeover names its origin. */
export const PAIRED_TURN_LEASE_OWNER = "paired-turn"

export type PairedTurnAdmission =
  | { admitted: true; submissionId: string }
  /** No runtime target on this Host: work submissions are off, as for local chat. */
  | { admitted: false; untracked: true }
  /** The Host will not run this turn; the server answers the client with `code`. */
  | { admitted: false; refusal: { code: string; message: string } }

export interface PairedTurnAdapterDeps extends WorkSubmissionServiceDeps {
  getSession?: (sessionId: string) => Promise<{ id: string; handoffLock?: unknown } | undefined>
  getMessage?: (messageId: string) => Promise<{ sessionId: string } | undefined>
  commitUserMessage?: (sessionId: string, message: UIMessage) => Promise<void>
  startHeartbeat?: (submissionId: string) => () => void
}

function refusal(code: string, message: string): PairedTurnAdmission {
  return { admitted: false, refusal: { code, message } }
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isSendContent(value: unknown): value is SendContent {
  return typeof value === "string" || Array.isArray(value)
}

/** The run id the server minted from this turn's remote execution context. */
export function pairedTurnSubmissionId(runId: string): string {
  return chatSubmissionId(runId)
}

export async function admitPairedChatTurn(
  payload: Record<string, unknown>,
  deps: PairedTurnAdapterDeps = {}
): Promise<PairedTurnAdmission> {
  const sessionId = stringField(payload, "sessionId")
  const runId = stringField(payload, "runId")
  const prompt = payload.prompt
  if (!sessionId || !runId || !isSendContent(prompt)) {
    throw new Error("paired_turn_invalid_request")
  }
  const messageId = stringField(payload, "messageId") ?? `${runId}:user`

  const active = getActiveRuntimeTargetContext()
  if (!active) return { admitted: false, untracked: true }
  // The server binds the caller's account from its own session, overwriting
  // anything the client sent; a mismatch is a pairing for another account.
  if (stringField(payload, "callerAccountId") !== active.accountId) {
    return refusal("host_state_scope_mismatch", "The caller is not paired to this Host's account.")
  }

  const [{ getSession: defaultGetSession }, { getDb }] = await Promise.all([
    import("@/lib/db/sessions"),
    import("@/lib/db/schema"),
  ])
  const session = await (deps.getSession ?? defaultGetSession)(sessionId)
  if (!session) return refusal("session_not_found", "The session does not exist on this Host.")
  const { assertSessionWritable, SessionHandoffLockedError } =
    await import("@/lib/chat/session-write-guard")
  try {
    assertSessionWritable(session as Parameters<typeof assertSessionWritable>[0], "send-message")
  } catch (error) {
    if (error instanceof SessionHandoffLockedError) {
      return refusal(error.code, "The session is read-only during a handoff.")
    }
    throw error
  }

  // A retry re-sends the turn the session already holds; only a new message is
  // written. A message id that belongs to another session is refused outright.
  const existing = await (deps.getMessage ?? ((id: string) => getDb().messages.get(id)))(messageId)
  if (existing && existing.sessionId !== sessionId) {
    return refusal("host_state_message_id_exists", "The message id already exists.")
  }
  const commit =
    deps.commitUserMessage ??
    (async (id: string, message: UIMessage) => {
      const { commitMessageDelta } = await import("@/lib/db/messages")
      await commitMessageDelta(id, { upserts: [message] })
    })
  const { makeUserMessage } = await import("@/lib/claude/adapter")
  const userMessage = makeUserMessage(prompt, messageId)

  const submissionId = pairedTurnSubmissionId(runId)
  const now = deps.now?.() ?? Date.now()
  try {
    await acceptWorkSubmission(
      {
        intent: {
          contractVersion: 1,
          idempotencyKey: `paired:${sessionId}:${runId}`,
          source: { kind: "chat", sourceId: sessionId },
          scope: { accountId: active.accountId, runtimeTargetId: active.targetId, sessionId },
          // The device is waiting on this RPC; the turn runs now or not at all.
          availabilityPolicy: "fail",
        },
        runId,
        turnId: runId,
        submissionId,
        inputBatchId: `input:${runId}`,
        input: { content: prompt, visibleMessageIds: [messageId], attachments: [] },
        ...(existing ? {} : { writeTranscript: () => commit(sessionId, userMessage) }),
        now,
      },
      deps
    )
  } catch (error) {
    if (error instanceof WorkSubmissionRejectedError) {
      return refusal(`work_submission_${error.code}`, error.message)
    }
    throw error
  }

  if (!(await claimWorkSubmission(submissionId, PAIRED_TURN_LEASE_OWNER, now))) {
    return refusal("paired_turn_owned_elsewhere", "The turn is already being dispatched.")
  }
  // Runs until the persister settles the row; `lease-heartbeat` stops itself
  // once it finds the row settled, so there is nothing to tear down on success.
  ;(
    deps.startHeartbeat ??
    ((id: string) =>
      startWorkSubmissionLeaseHeartbeat(id, PAIRED_TURN_LEASE_OWNER, {
        onError: (error) => console.error("paired turn lease renewal failed", error),
      }))
  )(submissionId)
  await markWorkSubmissionStarted(submissionId, now)
  return { admitted: true, submissionId }
}

/**
 * The server could not hand an admitted turn to the runtime. Seal it as failed
 * so the session is not left with an open submission that nothing will end.
 */
export async function abandonPairedChatTurn(
  payload: Record<string, unknown>,
  deps: WorkSubmissionServiceDeps = {}
): Promise<{ settled: boolean }> {
  const submissionId = stringField(payload, "submissionId")
  if (!submissionId) throw new Error("paired_turn_invalid_request")
  const settled = await settleWorkSubmission(
    {
      submissionId,
      outcome: "failed",
      errorCode: stringField(payload, "errorCode") ?? "dispatch_failed",
    },
    deps
  )
  return { settled }
}

export async function dispatchPairedTurnCommand(
  command: PairedTurnCommand,
  payload: Record<string, unknown>
): Promise<unknown> {
  return command === "paired_turn_admit"
    ? admitPairedChatTurn(payload)
    : abandonPairedChatTurn(payload)
}
