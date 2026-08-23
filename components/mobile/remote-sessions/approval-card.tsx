"use client"

/**
 * Remote Session Control — mobile tool-use decision card.
 *
 * Renders a pending `permission_request` the host routed to this device and
 * lets the operator allow / allow-for-session / deny it. Resolves through
 * `useRemoteSessionStream().respond`, which calls `claude_approve` on the host.
 *
 * The body and the actions come from the shared
 * `PendingDecisionSurface` — this file used to reimplement both, and did it
 * worse: a `<pre>{JSON.stringify(input)}</pre>` with no truncation where the
 * desktop showed a diff or a shell block, no subagent attribution, and no
 * handling of an interrupted decision. What remains here is what is genuinely
 * mobile: the card, and the biometric guard on the allow direction.
 *
 * Allowing is the sensitive direction (it lets a host agent execute a tool —
 * possibly computer-use), so it is gated behind the biometric guard; denying
 * applies immediately. The guard is passed to the shared surface as
 * `confirmAllow` rather than reimplemented there, so the shared presentation
 * layer can never swallow it.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PendingDecisionSurface } from "@/components/chat/decisions/pending-decision-surface"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import type { ApprovalDecision, PendingApproval } from "@cognia/agent-config-types"

export interface ApprovalCardProps {
  approval: PendingApproval
  onRespond: (decision: ApprovalDecision) => Promise<void>
  /**
   * An observer sees that a decision exists but cannot answer it, and its
   * arguments stay redacted. Defaults to `control` so an older caller that has
   * not been taught about attach modes keeps working.
   */
  mode?: "control" | "observe"
}

export function ApprovalCard({ approval, onRespond, mode = "control" }: ApprovalCardProps) {
  const t = useTranslations("mobile.remoteSessions.approval")
  const guard = useBiometricGuard()

  const confirmAllow = useCallback(
    async (run: () => Promise<void>) => {
      const result = await guard(
        {
          reason: t("reason", { tool: approval.toolName }),
          title: t("title"),
          description: t("description"),
        },
        run
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(t("blocked", { reason: result.reason }))
      }
    },
    [approval.toolName, guard, t]
  )

  return (
    <Card data-testid="remote-approval-card" className="border-amber-500/40">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {t("heading", { tool: approval.displayName ?? approval.toolName })}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <PendingDecisionSurface
          decision={{ kind: "tool-approval", approval }}
          status={approval.status === "interrupted" ? "interrupted" : "pending"}
          mode={mode}
          onApprovalRespond={onRespond}
          confirmAllow={confirmAllow}
        />
      </CardContent>
    </Card>
  )
}
