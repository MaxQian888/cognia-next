"use client"

/**
 * Control of a conversation's agent from outside the chat runtime's tree.
 *
 * Same shape as `chat-send-bridge.ts`, for the two controls that one does not
 * carry: answering a tool approval and stopping a turn. Both are closures over
 * the chat runtime's own refs (execution handles, abort controllers, the
 * streaming coalescer), so a caller outside `ClaudeChatRuntimeProvider` — the
 * island overlay's main-window half — could not reproduce them without
 * duplicating that runtime. The controller registers them once; this module
 * only forwards.
 */

import type { ApprovalDecision, PendingApproval } from "@cognia/agent-config-types"

import { routeChatApprovalDecision, type ChatApprovalResponder } from "@/lib/chat/approval-routing"

export type ChatStopBridge = (sessionId: string) => Promise<void>

let approvalBridge: ChatApprovalResponder | undefined
let stopBridge: ChatStopBridge | undefined

/** Register the chat runtime's approval responder (returns an unregister). */
export function registerChatApprovalBridge(respond: ChatApprovalResponder): () => void {
  approvalBridge = respond
  return () => {
    if (approvalBridge === respond) approvalBridge = undefined
  }
}

/** Register the chat runtime's per-session stop (returns an unregister). */
export function registerChatStopBridge(stop: ChatStopBridge): () => void {
  stopBridge = stop
  return () => {
    if (stopBridge === stop) stopBridge = undefined
  }
}

/**
 * Answer `approval` exactly as its own approval card would, including the
 * room-member routing. Resolves false when no chat runtime is mounted to
 * deliver it; rejects when delivery itself failed, leaving the ask pending.
 */
export async function answerChatApproval(
  approval: PendingApproval,
  decision: ApprovalDecision
): Promise<boolean> {
  const direct = approvalBridge
  if (!direct) return false
  await routeChatApprovalDecision(approval, decision, direct)
  return true
}

/**
 * Stop `sessionId`'s turn exactly as its composer's Stop would. Resolves false
 * when no chat runtime is mounted to stop it.
 */
export async function stopChatTurn(sessionId: string): Promise<boolean> {
  const stop = stopBridge
  if (!stop || !sessionId) return false
  await stop(sessionId)
  return true
}

export function __resetChatControlBridgeForTesting(): void {
  approvalBridge = undefined
  stopBridge = undefined
}
