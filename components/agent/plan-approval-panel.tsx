"use client"

/**
 * Plan-approval panel.
 *
 * Renders a team's currently-proposed plan and the two buttons that resolve
 * the runtime's `waitForDecision` promise via the plan-approval-bus.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { approve, reject } from "@/lib/ai/agent/plan-approval-bus"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

export interface PlanApprovalPanelProps {
  team: AgentTeam
  lead?: AgentTeammate
}

export function PlanApprovalPanel({ team, lead }: PlanApprovalPanelProps) {
  const t = useTranslations("agentTeamsWorkspace.planApproval")
  const [feedback, setFeedback] = useState("")

  const planText = lead?.proposedPlan ?? ""

  return (
    <Card className="space-y-3 p-3" data-testid="plan-approval-panel">
      <Label className="text-sm font-semibold">{t("title")}</Label>
      {planText ? (
        <pre className="max-h-48 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
          {planText}
        </pre>
      ) : (
        <p className="text-xs italic text-muted-foreground">{t("noPlan")}</p>
      )}
      <Textarea
        rows={2}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder={t("feedbackPlaceholder")}
        className="text-xs"
        data-testid="plan-approval-feedback"
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            reject(team.id, feedback || undefined)
            setFeedback("")
          }}
          disabled={!planText}
          data-testid="plan-approval-reject"
        >
          {t("reject")}
        </Button>
        <Button
          size="sm"
          onClick={() => approve(team.id)}
          disabled={!planText}
          data-testid="plan-approval-approve"
        >
          {t("approve")}
        </Button>
      </div>
    </Card>
  )
}
