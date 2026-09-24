"use client"

/**
 * New-instruction approval supersede.
 *
 * A pending approval is only meaningful under the instruction that produced
 * it. When the user sends a new instruction mid-turn — a live steer or a
 * queued follow-up — the question the modal is asking ("may the agent run
 * this for the thing you asked before?") no longer describes what the agent
 * is about to do. Codex 0.154 made the same call explicit: new user
 * instructions invalidate outstanding approvals.
 *
 * `supersedePendingApprovals` therefore answers every live approval for the
 * session with `deny` — through the SAME channel the approval arrived on, so
 * the sidecar/registry/agent waiter actually resolves instead of hanging —
 * and marks the entry `interrupted` with reason `superseded`. The card stays
 * as an honest notice ("denied because you sent a new instruction") with a
 * Dismiss action rather than vanishing silently.
 *
 * This is deliberately NOT a remembered refusal: a superseded ask says
 * nothing about whether the user would allow the call, so `session-denials`
 * and the always-allow rules are left untouched — the same call may ask
 * again under the new instruction.
 */

import { useChatStore } from "@/stores/chat"
import type { PendingApproval } from "@cognia/agent-config-types"
import type { AcpPermissionResponse } from "@/types/agent/external-agent"

/**
 * `interruptReason` value the decision surfaces translate into the
 * superseded-notice copy (`chat.toolApproval.supersededNotice`).
 */
export const APPROVAL_SUPERSEDED_REASON = "superseded"

/** Denial message sent to the sidecar/agent for audit — English, machine-ish. */
const SUPERSEDED_MESSAGE = "superseded by a new user instruction"

export interface SupersedeApprovalsDeps {
  /**
   * Execution-handle lookup for the session, injected by the chat controller
   * (`executionHandlesRef` + the agent execution-handle directory). The
   * handle is preferred over raw IPC because it records capability outcomes.
   */
  getExecutionHandle?: (sessionId: string) =>
    | {
        resolvePermission: (
          requestId: string,
          decision: "deny",
          options?: { message?: string }
        ) => Promise<void>
      }
    | undefined
}

/** Deny one in-renderer approval-registry waiter (lazy import keeps the
 * registry off this module's load path, same as the per-branch imports did). */
async function denyViaApprovalRegistry(sessionId: string, requestId: string): Promise<void> {
  const { resolveApproval } = await import("@/lib/connectors/hitl/approval-registry")
  resolveApproval(sessionId, requestId, { decision: "deny", message: SUPERSEDED_MESSAGE })
}

/**
 * Answer one pending approval with `deny` through the channel its requestId
 * belongs to — mirroring the dispatch in `respondToApproval`
 * (use-claude-chat-controller.ts), minus every `allow*` branch. Throws are
 * the caller's to handle; a resolved call — even one whose registry entry was
 * already gone — means there is no waiter left to answer.
 */
async function denyThroughChannel(
  approval: PendingApproval,
  deps?: SupersedeApprovalsDeps
): Promise<void> {
  const { requestId, sessionId } = approval

  // In-renderer waiters: the Promise lives in this process's approval
  // registry, so `approveTool` must never see these request ids — there is no
  // sidecar-side permission waiting on them.
  const { RENDERER_TOOL_HOST_APPROVAL_PREFIX } =
    await import("@/lib/ai/agent/external/session/renderer-tool-host")
  if (requestId.startsWith(RENDERER_TOOL_HOST_APPROVAL_PREFIX)) {
    await denyViaApprovalRegistry(sessionId, requestId)
    return
  }
  const { isBuiltInSkillApprovalRequestId } = await import("@/lib/skills/built-in/desktop-hitl")
  if (isBuiltInSkillApprovalRequestId(requestId)) {
    await denyViaApprovalRegistry(sessionId, requestId)
    return
  }
  const { isRealtimeToolApprovalRequestId } = await import("@/lib/voice/live/approval")
  if (isRealtimeToolApprovalRequestId(requestId)) {
    await denyViaApprovalRegistry(sessionId, requestId)
    return
  }

  // External agent (Codex app-server / ACP): the answer travels to the
  // adapter that asked — as a host RPC when the run lives on a paired host,
  // or through the local manager otherwise.
  const { isExternalAgentApprovalRequestId, getExternalApprovalTarget, resolveExternalApproval } =
    await import("@/lib/ai/agent/external/session/chat-decision-bridge")
  if (isExternalAgentApprovalRequestId(requestId)) {
    const remoteDecisionId = getExternalApprovalTarget(requestId)?.remoteDecisionId
    const respond = remoteDecisionId
      ? async () => {
          const { resolveRemotePermission } =
            await import("@/lib/ai/agent/external/runtimes/remote/remote-run-client")
          const outcome = await resolveRemotePermission(remoteDecisionId, "deny")
          // `unknown` means the host already decided — nothing left to wait
          // for; `wrong-device` is a genuine routing failure.
          if (!outcome.resolved && outcome.reason === "wrong-device") {
            throw new Error("This device is not the one that was asked.")
          }
        }
      : async (
          agentId: string,
          agentSessionId: string,
          response: AcpPermissionResponse
        ): Promise<void> => {
          const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
          await getExternalAgentManager().respondToPermission(agentId, agentSessionId, response)
        }
    // An unknown id means the turn already released the ask — the card is
    // stale either way, so a false return still counts as answered here.
    await resolveExternalApproval(requestId, "deny", respond)
    return
  }

  // Sidecar lane — the same ladder `respondToApproval` climbs: durable
  // host-state intent when a host channel is negotiated, then the execution
  // handle (capability-audited), then the plain `claude_approve` IPC.
  const { enqueueHostStateIntentIfAvailable } = await import("@/lib/db/mobile-outbound-queue")
  try {
    const queued = await enqueueHostStateIntentIfAvailable({
      sessionId,
      action: { kind: "approval.respond", requestId, decision: "deny" },
    })
    if (queued) return
  } catch {
    // The outbox being full or unwritable must not strand the waiter — fall
    // through to the direct answer.
  }
  const handle = deps?.getExecutionHandle?.(sessionId)
  if (handle) {
    await handle.resolvePermission(requestId, "deny", { message: SUPERSEDED_MESSAGE })
    return
  }
  const { approveTool } = await import("@/lib/claude/ipc")
  await approveTool(sessionId, requestId, "deny", SUPERSEDED_MESSAGE)
}

/**
 * Deny every live pending approval for `sessionId` because the user just sent
 * a new instruction. Entries already `interrupted` are left alone. Returns
 * the number superseded; an approval whose channel throws stays `pending` —
 * marking it interrupted would claim a denial that never happened.
 *
 * The enumeration reads the session's store slice: team sub-session and
 * dispatched-subagent asks are re-bucketed there by `pushApproval`, and each
 * entry keeps its own `sessionId` for channel routing.
 */
export async function supersedePendingApprovals(
  sessionId: string,
  deps?: SupersedeApprovalsDeps
): Promise<number> {
  if (!sessionId) return 0
  const store = useChatStore.getState()
  const approvals = (
    store.sessions[sessionId]?.pendingApprovals ??
    (sessionId === store.activeSessionId ? store.pendingApprovals : [])
  ).filter((a) => a.status !== "interrupted")
  if (approvals.length === 0) return 0

  let superseded = 0
  for (const approval of approvals) {
    try {
      // Shared sessions gate who may answer an approval through the run's
      // approval bridge. A steer from a participant without that authority
      // must not deny another member's pending ask — a veto (or a dead
      // lease) simply leaves the entry answerable.
      const { authorizeSharedSessionApproval } = await import("@/lib/collab/shared-run-coordinator")
      const authorized = await authorizeSharedSessionApproval(approval, "deny")
      if (authorized !== "deny") continue
      await denyThroughChannel(approval, deps)
      superseded += 1
      useChatStore
        .getState()
        .markApprovalInterrupted(approval.requestId, approval.sessionId, APPROVAL_SUPERSEDED_REASON)
    } catch (error) {
      // Honest failure: the waiter may still be alive, so the entry stays
      // pending and answerable rather than showing a denial that never ran.
      console.warn("approval supersede failed", {
        sessionId,
        requestId: approval.requestId,
        error,
      })
    }
  }
  return superseded
}
