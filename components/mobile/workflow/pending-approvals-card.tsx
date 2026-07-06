"use client"

/**
 * Pending workflow-approval card for the mobile workflow surface (ADR 0061
 * P2). Lists `action.approval.request` gates currently blocked on the
 * desktop and resolves them via the control-gated
 * `workflow_approval_respond` RPC (direct `transport.call` — immediate
 * feedback, deliberately not the offline outbound queue: a response against
 * a dead orchestrator is meaningless, the RPC must round-trip live).
 *
 * Live updates ride the `workflow://approval-request` / `-resolved` WS
 * frames; a push tap lands here via the workflows deep-link and the mount
 * fetch picks the pending list up.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CheckIcon, UserCheckIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { transport } from "@/lib/tauri/transport-instance"
import { cn } from "@/lib/utils"

export interface PendingApprovalRow {
  approvalId: string
  runId: string
  workflowId: string
  stepId: string
  title: string
  message?: string
  requestedAt: number
  timeoutAt?: number
}

export const APPROVAL_EVENT_CHANNELS = [
  "workflow://approval-request",
  "workflow://approval-resolved",
] as const

export function PendingApprovalsCard({ className }: { className?: string }) {
  const t = useTranslations("mobile.workflow.approvals")
  const [approvals, setApprovals] = useState<PendingApprovalRow[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const result = (await transport.call("workflow_approval_list", {})) as {
        approvals?: PendingApprovalRow[]
      } | null
      setApprovals(Array.isArray(result?.approvals) ? result.approvals : [])
    } catch {
      // Desktop unreachable — keep whatever we last saw; sync banners cover
      // the connectivity story.
    }
  }, [])

  useEffect(() => {
    // Initial fetch deferred a tick — reload's setState is already async
    // (post-RPC), but react-hooks/set-state-in-effect can't see through the
    // call, so give it an explicit callback boundary.
    const kickoff = setTimeout(() => void reload(), 0)
    const unsubs = APPROVAL_EVENT_CHANNELS.map((channel) =>
      transport.subscribe(channel, () => void reload())
    )
    return () => {
      clearTimeout(kickoff)
      for (const off of unsubs) off()
    }
  }, [reload])

  const respond = useCallback(
    async (approvalId: string, decision: "approved" | "rejected") => {
      setBusyId(approvalId)
      try {
        const result = (await transport.call("workflow_approval_respond", {
          approvalId,
          decision,
        })) as { ok?: boolean } | null
        if (result?.ok) {
          setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId))
          toast.success(decision === "approved" ? t("approvedToast") : t("rejectedToast"))
        } else {
          toast.info(t("goneToast"))
          void reload()
        }
      } catch {
        toast.error(t("respondFailedToast"))
      } finally {
        setBusyId(null)
      }
    },
    [reload, t]
  )

  if (approvals.length === 0) return null

  return (
    <Card className={cn("p-3 space-y-3", className)} data-testid="pending-approvals-card">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <UserCheckIcon className="size-4 text-amber-500" aria-hidden="true" />
        {t("heading", { count: approvals.length })}
      </div>
      <ul className="space-y-3">
        {approvals.map((a) => (
          <li key={a.approvalId} className="space-y-1.5" data-testid={`approval-${a.approvalId}`}>
            <p className="text-sm font-medium leading-tight">{a.title}</p>
            {a.message ? (
              <p className="text-xs text-muted-foreground line-clamp-3">{a.message}</p>
            ) : null}
            <div className="flex gap-2 pt-0.5">
              <Button
                size="sm"
                className="flex-1"
                disabled={busyId === a.approvalId}
                onClick={() => void respond(a.approvalId, "approved")}
                data-testid={`approve-${a.approvalId}`}
              >
                <CheckIcon className="size-4" aria-hidden="true" />
                {t("approve")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                disabled={busyId === a.approvalId}
                onClick={() => void respond(a.approvalId, "rejected")}
                data-testid={`reject-${a.approvalId}`}
              >
                <XIcon className="size-4" aria-hidden="true" />
                {t("reject")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
