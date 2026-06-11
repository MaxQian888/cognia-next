"use client"

/**
 * Inline plan approval card (ADR-0045 P5). A controlled component: it renders
 * a draft / awaiting-approval `AgentPlan` and surfaces approve / reject /
 * refine actions as callbacks, so the host wires them to the plan runtime
 * (and, for refine, an LlmClient). Mirrors the team `PlanApprovalPanel`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, CircleIcon, ClockIcon, MinusCircleIcon, XCircleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  computePlanCounts,
  type AgentPlan,
  type PlanRefinementType,
  type PlanStepStatus,
} from "@/types/agent/plan"

const REFINE_TYPES: PlanRefinementType[] = ["optimize", "simplify", "expand", "reorder"]

const REFINE_LABEL_KEY: Record<PlanRefinementType, string> = {
  optimize: "approval.refineOptimize",
  simplify: "approval.refineSimplify",
  expand: "approval.refineExpand",
  reorder: "approval.refineReorder",
  repair: "approval.refineRepair",
}

export function stepStatusIcon(status: PlanStepStatus) {
  switch (status) {
    case "completed":
      return <CheckCircle2Icon className="size-3.5 shrink-0 text-green-600" />
    case "in_progress":
      return <ClockIcon className="size-3.5 shrink-0 animate-pulse text-yellow-600" />
    case "failed":
    case "blocked":
      return <XCircleIcon className="size-3.5 shrink-0 text-rose-600" />
    case "skipped":
      return <MinusCircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
    default:
      return <CircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
  }
}

export interface PlanApprovalCardProps {
  plan: AgentPlan
  onApprove: () => void
  onReject: (feedback?: string) => void
  /** When provided, refine controls are shown. */
  onRefine?: (type: PlanRefinementType, feedback?: string) => void
}

export function PlanApprovalCard({ plan, onApprove, onReject, onRefine }: PlanApprovalCardProps) {
  const t = useTranslations("plan")
  const [feedback, setFeedback] = useState("")
  const steps = [...plan.steps].sort((a, b) => a.order - b.order)
  const trimmed = () => feedback.trim() || undefined
  const { totalSteps, completedSteps } = computePlanCounts(plan.steps)
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0

  return (
    <Card className="space-y-3 p-3" data-testid="plan-approval-card">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{t("approval.title")}</span>
        <Badge variant="secondary">{t(`status.${plan.status}`)}</Badge>
      </div>

      <div>
        <div className="text-sm font-medium break-words">{plan.title}</div>
        <div className="text-xs text-muted-foreground">
          {t("approval.sourceLabel", { source: plan.source })}
        </div>
      </div>

      {totalSteps > 0 && (
        <div className="space-y-1" data-testid="plan-approval-progress">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("approval.progressLabel")}</span>
            <span className="tabular-nums">
              {completedSteps}/{totalSteps}
            </span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("approval.progressLabel")}
          >
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {steps.length > 0 ? (
        <ScrollArea className="max-h-48 rounded-md bg-muted/40">
          <ul className="space-y-1 p-2" data-testid="plan-approval-steps">
            {steps.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-xs" data-status={s.status}>
                {stepStatusIcon(s.status)}
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words",
                    s.status === "completed" && "text-muted-foreground line-through"
                  )}
                >
                  {s.title}
                </span>
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {s.kind}
                </Badge>
              </li>
            ))}
          </ul>
        </ScrollArea>
      ) : (
        <p className="text-xs italic text-muted-foreground">{t("approval.noSteps")}</p>
      )}

      <Textarea
        rows={2}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder={t("approval.feedbackPlaceholder")}
        className="text-xs"
        data-testid="plan-approval-feedback"
      />

      <div className="flex flex-wrap items-center justify-end gap-2">
        {onRefine
          ? REFINE_TYPES.map((rt) => (
              <Button
                key={rt}
                size="sm"
                variant="ghost"
                onClick={() => onRefine(rt, trimmed())}
                data-testid={`plan-refine-${rt}`}
              >
                {t(REFINE_LABEL_KEY[rt])}
              </Button>
            ))
          : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => onReject(trimmed())}
          data-testid="plan-approval-reject"
        >
          {t("approval.reject")}
        </Button>
        <Button size="sm" onClick={onApprove} data-testid="plan-approval-approve">
          {t("approval.approve")}
        </Button>
      </div>
    </Card>
  )
}
