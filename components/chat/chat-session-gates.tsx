"use client"

import { useCallback } from "react"
import type { ApprovalDecision, PendingApproval } from "@cognia/agent-config-types"
import { useChatStore, useSessionPendingApprovals } from "@/stores/chat"
import {
  useExternalElicitationStore,
  useSessionPendingElicitation,
} from "@/stores/agent/external-elicitation-store"
import { ExternalAgentElicitationDialog } from "@/components/agent/external-agent/elicitation-dialog"
import { ToolApprovalDialog } from "./tool-approval-dialog"
import { routeChatApprovalDecision } from "@/lib/chat/approval-routing"

/** Blocking decisions belong to the conversation, independent of its host page. */
export function ChatSessionGates({
  sessionId,
  respondToApproval,
}: {
  sessionId: string
  respondToApproval: (approval: PendingApproval, decision: ApprovalDecision) => Promise<void>
}) {
  const approvals = useSessionPendingApprovals(sessionId)
  const approval = approvals.find((a) => a.status !== "interrupted") ?? approvals[0] ?? null
  const pending = useSessionPendingElicitation(sessionId)
  const respond = useCallback(
    async (decision: ApprovalDecision) => {
      if (!approval) return
      await routeChatApprovalDecision(approval, decision, respondToApproval)
    },
    [approval, respondToApproval]
  )
  return (
    <>
      <ToolApprovalDialog
        approval={approval}
        onRespond={respond}
        onDismiss={() =>
          approval && useChatStore.getState().clearApproval(approval.requestId, sessionId)
        }
        onCancelRun={(runId) => {
          void import("@/lib/claude/agents/cancel-subagent").then(({ cancelSubagentRun }) =>
            cancelSubagentRun(runId)
          )
        }}
      />
      <ExternalAgentElicitationDialog
        key={sessionId}
        request={pending?.request ?? null}
        onRespond={async (response) => {
          if (!pending) return
          const { deliverExternalElicitation } =
            await import("@/lib/ai/agent/external/session/chat-decision-bridge")
          await deliverExternalElicitation(pending, response, { strict: true })
          useExternalElicitationStore.getState().remove(sessionId, pending.request.id)
        }}
      />
    </>
  )
}
