"use client"

/**
 * Where a person's decision on a chat tool approval has to go.
 *
 * One rule, shared by every surface that answers an approval — the approval
 * card in the conversation and the island overlay — so they cannot disagree
 * about which runtime is waiting on it.
 */

import type {
  ApprovalDecision,
  ApprovalResponseOptions,
  PendingApproval,
} from "@cognia/agent-config-types"

import { decodeSubSession } from "@/lib/claude/team-session-id"
import { isCompanionShell } from "@/lib/chat/room/shell"

/** A runtime's own way of answering one of its approvals. */
export type ChatApprovalResponder = (
  approval: PendingApproval,
  decision: ApprovalDecision,
  options?: ApprovalResponseOptions
) => Promise<void>

/** The reason a deny carries, trimmed; `undefined` for an allow or a bare deny. */
export function denialReasonOf(
  decision: ApprovalDecision,
  options?: ApprovalResponseOptions
): string | undefined {
  if (decision !== "deny") return undefined
  const reason = options?.message?.trim()
  return reason ? reason : undefined
}

/**
 * The refusal text the model reads as the denied tool's result. English, like
 * all prompt scaffolding: it is read by the model, not shown to the user.
 */
export function denialMessageForModel(reason: string): string {
  return `The user denied this tool call. Their reason, or what to do instead: ${reason}`
}

/**
 * Deliver `decision` to the runtime that asked.
 *
 * A team room member's ask (a `…::char::…` sub-session) belongs to the room
 * runner: the host's own, or the companion projector's on a companion shell,
 * which forwards it to the host that runs the room. Every other ask goes to
 * `direct`, the chat runtime's responder.
 */
export async function routeChatApprovalDecision(
  approval: PendingApproval,
  decision: ApprovalDecision,
  direct: ChatApprovalResponder,
  options?: ApprovalResponseOptions
): Promise<void> {
  // Options ride along only when there are some, so a plain answer reaches a
  // responder exactly as it always did.
  const extra = options ? ([options] as const) : ([] as const)
  if (!decodeSubSession(approval.sessionId)) {
    await direct(approval, decision, ...extra)
    return
  }
  const { getHostRoomRunner, getCompanionRoomProjector } =
    await import("@/lib/chat/room/runner-host")
  const runner = isCompanionShell() ? getCompanionRoomProjector().runner : getHostRoomRunner()
  await runner.respondToApproval(approval, decision, ...extra)
}
