"use client"

/**
 * The main window's half of every island control that lands in a Cognia
 * surface: a conversation's approvals, Stop and reply, the plan-step and
 * budget gates, durable run approvals, and clearing a wait whose waiter is
 * gone.
 *
 * `executeIslandAction` has already re-validated the intent against the
 * current projection. These functions re-read the AUTHORITY behind it (the
 * chat store, the gate store, the run journal) at the moment of the press,
 * because the projection is a snapshot and the person may be answering an ask
 * another surface settled a second ago. Each one uses the exact path the
 * owning page uses, so the island is a second doorway, never a second
 * implementation.
 *
 * Every function resolves `null` when the action happened, else the
 * `fleet.island.actionError.*` reason to show.
 */

import type { ApprovalKey } from "@/lib/runtime/approval-bus"
import { answerChatApproval, stopChatTurn } from "@/hooks/chat/chat-control-bridge"
import { sendChatMessage } from "@/hooks/chat/chat-send-bridge"
import { decidePendingGate } from "@/lib/ai/agent/team/gates/decide-pending-gate"
import {
  dispatchRunControl,
  type RunControlOutcomeReason,
} from "@/lib/execution/run-control-dispatch"
import { detectHostProfile } from "@/lib/platform/capabilities"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useChatStore } from "@/stores/chat/chat-store"
import type { IslandActionReason } from "./actions"
import type { IslandDecisionBehavior, IslandRowProjection } from "./types"

/** Answer a conversation's live tool approval as its own approval card would. */
export async function respondToChatApproval(
  sessionId: string,
  requestId: string,
  behavior: IslandDecisionBehavior
): Promise<IslandActionReason | null> {
  const approval = useChatStore
    .getState()
    .sessions[sessionId]?.pendingApprovals.find(
      (candidate) => candidate.requestId === requestId && candidate.status !== "interrupted"
    )
  if (!approval) return "noLongerWaiting"
  if (behavior === "allow_always" && approval.suppressAlwaysAllowRule) return "notPermitted"
  try {
    return (await answerChatApproval(approval, behavior)) ? null : "callFailed"
  } catch {
    // Delivery failed and the ask is still pending in its conversation.
    return "callFailed"
  }
}

function findGate(key: ApprovalKey) {
  return usePendingGatesStore
    .getState()
    .gates.find((gate) => gate.key.scope === key.scope && gate.key.id === key.id)
}

/** Approve or reject an open plan-step or budget gate. */
export function decideGate(key: ApprovalKey, approve: boolean): IslandActionReason | null {
  const gate = findGate(key)
  if (!gate || gate.status !== "open") return "noLongerWaiting"
  const delivered = decidePendingGate(gate, { outcome: approve ? "approve" : "reject" })
  return delivered ? null : "noLongerWaiting"
}

/** The island's words for what the run control plane refused. */
export function runControlReason(reason: RunControlOutcomeReason | undefined): IslandActionReason {
  switch (reason) {
    case "revision_conflict":
      return "requestChanged"
    case "run_not_found":
    case "action_unavailable":
    case "interrupt_not_found":
    case "interrupt_expired":
    case "interrupt_resolved":
      return "noLongerWaiting"
    case "forbidden":
      return "notPermitted"
    case "host_consent_required":
      return "hostConsent"
    default:
      return "callFailed"
  }
}

/** Approve or deny a durable run approval through the run control plane. */
export async function decideRunApproval(
  runId: string,
  interruptId: string,
  approve: boolean
): Promise<IslandActionReason | null> {
  const outcome = await dispatchRunControl({
    runId,
    action: approve ? "approve" : "deny",
    surface: "island",
    hostProfile: detectHostProfile(),
    interruptId,
  })
  return outcome.accepted ? null : runControlReason(outcome.reason)
}

/** Stop a conversation's turn exactly as its composer's Stop would. */
export async function stopConversation(sessionId: string): Promise<IslandActionReason | null> {
  const status = useChatStore.getState().sessions[sessionId]?.status
  if (status !== "streaming" && status !== "awaiting_approval") return "turnFinished"
  try {
    return (await stopChatTurn(sessionId)) ? null : "callFailed"
  } catch {
    return "callFailed"
  }
}

/**
 * Send a reply into a conversation. The chat runtime's own routing decides
 * what it becomes: a live steer or a queued follow-up while a turn runs, a new
 * turn when the conversation is idle.
 */
export function replyToConversation(sessionId: string, text: string): IslandActionReason | null {
  return sendChatMessage(sessionId, text) ? null : "callFailed"
}

/**
 * Clear a pending item whose waiter is gone.
 *
 * Only sources that own a clearing path are reachable here, and the projection
 * only sets `dismissStale` for those, so a refusal below is a belt-and-braces
 * check rather than the primary gate.
 */
export async function dismissStaleRow(row: IslandRowProjection): Promise<boolean> {
  const { owner } = row
  if (owner.kind === "gate") {
    if (!row.stale) return false
    const gate = findGate(owner.gateKey)
    if (!gate || gate.status !== "interrupted") return false
    decidePendingGate(gate, { outcome: "dismiss" })
    return true
  }
  if (owner.kind === "chat" && owner.requestId) {
    useChatStore.getState().clearApproval(owner.requestId, owner.sessionId)
    return true
  }
  if (owner.kind === "run" && owner.interruptId) {
    const { expireRunInterruptFromSource } = await import("@/lib/execution/run-control")
    await expireRunInterruptFromSource(owner.runId, owner.interruptId)
    return true
  }
  return false
}
