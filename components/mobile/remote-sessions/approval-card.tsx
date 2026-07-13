"use client"

/**
 * Remote Session Control — mobile tool-use approval card.
 *
 * Renders a pending `permission_request` that the host routed to this device
 * and lets the operator allow / allow-for-session / deny it. Allowing is the
 * sensitive direction (it lets a host agent execute a tool — possibly
 * computer-use), so it is gated behind the biometric guard; denying applies
 * immediately. Resolves through `useRemoteSessionStream().respond`, which
 * calls `claude_approve` on the host.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import type { ApprovalDecision, PendingApproval } from "@cognia/agent-config-types"

export interface ApprovalCardProps {
  approval: PendingApproval
  onRespond: (decision: ApprovalDecision) => Promise<void>
}

export function ApprovalCard({ approval, onRespond }: ApprovalCardProps) {
  const t = useTranslations("mobile.remoteSessions.approval")
  const guard = useBiometricGuard()

  const onAllow = useCallback(
    async (decision: "allow" | "allow_always") => {
      const result = await guard(
        {
          reason: t("reason", { tool: approval.toolName }),
          title: t("title"),
          description: t("description"),
        },
        async () => {
          await onRespond(decision)
        }
      )
      if (result.kind === "blocked") {
        if (result.reason === "cancelled") return
        toast.error(t("blocked", { reason: result.reason }))
      }
    },
    [approval.toolName, guard, onRespond, t]
  )

  const onDeny = useCallback(async () => {
    await onRespond("deny")
  }, [onRespond])

  return (
    <Card data-testid="remote-approval-card" className="border-amber-500/40">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {t("heading", { tool: approval.displayName ?? approval.toolName })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {approval.description ? (
          <p className="text-xs text-muted-foreground">{approval.description}</p>
        ) : null}
        <pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-snug">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onAllow("allow")} data-testid="remote-approval-allow">
            {t("allow")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onAllow("allow_always")}
            data-testid="remote-approval-allow-always"
          >
            {t("allowAlways")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDeny}
            data-testid="remote-approval-deny"
          >
            {t("deny")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
