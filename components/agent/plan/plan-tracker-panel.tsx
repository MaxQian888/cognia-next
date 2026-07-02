"use client"

/**
 * Read-only plan tracker panel (ADR-0045 P5). Renders an executing /
 * terminal `AgentPlan`'s steps with live status + a progress summary. Pair
 * with `useSessionPlan` / `usePlanById` for a live view; designed to live in
 * the agent workspace beside the plan-mode tasks sheet.
 */

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { AgentPlan, PlanStepStatus } from "@/types/agent/plan"
import { stepStatusIcon } from "./plan-approval-card"

const STEP_STATUS_LABEL_KEY: Record<PlanStepStatus, string> = {
  pending: "tracker.statusPending",
  ready: "tracker.statusReady",
  in_progress: "tracker.statusInProgress",
  completed: "tracker.statusCompleted",
  failed: "tracker.statusFailed",
  skipped: "tracker.statusSkipped",
  blocked: "tracker.statusBlocked",
}

export interface PlanTrackerPanelProps {
  plan: AgentPlan
}

export function PlanTrackerPanel({ plan }: PlanTrackerPanelProps) {
  const t = useTranslations("plan")
  const steps = [...plan.steps].sort((a, b) => a.order - b.order)
  const pct = plan.totalSteps > 0 ? Math.round((plan.completedSteps / plan.totalSteps) * 100) : 0

  return (
    <Card className="space-y-3 p-3" data-testid="plan-tracker-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold break-words">{plan.title}</span>
        <Badge variant="secondary">{t(`status.${plan.status}`)}</Badge>
      </div>

      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          {t("tracker.progress", { completed: plan.completedSteps, total: plan.totalSteps })}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
            data-testid="plan-tracker-progress"
            aria-valuenow={pct}
            role="progressbar"
          />
        </div>
      </div>

      {steps.length > 0 ? (
        // Native overflow, not Radix ScrollArea: persistent grabbable thumb
        // that keeps working while text is selected (see plan-approval-card).
        <div className="max-h-64 overflow-y-auto overscroll-contain rounded-md bg-muted/40">
          <ul className="space-y-1 p-2" data-testid="plan-tracker-steps">
            {steps.map((s) => (
              <li
                key={s.id}
                className="flex items-start gap-2 text-xs"
                data-status={s.status}
                data-current={plan.currentStepId === s.id ? "true" : undefined}
              >
                {stepStatusIcon(s.status)}
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words",
                    s.status === "completed" && "text-muted-foreground line-through",
                    plan.currentStepId === s.id && "font-medium"
                  )}
                >
                  {s.title}
                </span>
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {t(STEP_STATUS_LABEL_KEY[s.status])}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs italic text-muted-foreground">{t("tracker.empty")}</p>
      )}
    </Card>
  )
}
