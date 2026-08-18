"use client"

/**
 * Read-only plan tracker panel (ADR-0045 P5). Renders an executing /
 * terminal `AgentPlan`'s steps with live status + a progress summary. Pair
 * with `useSessionPlan` / `usePlanById` for a live view; mounted above the
 * composer by `PlanTrackerDock` and inside the unified runs detail pane.
 *
 * Presentation follows the SAME user preset as the approval editor
 * (`planSettings.interactiveHtmlStyle` → {@link PlanHtmlStyle}), so the visual
 * choice is a property of "how this user reads plans", not of one screen. The
 * presets are re-expressed here as Tailwind classes rather than reusing the
 * approval document's CSS: that document is a sandboxed iframe with its own
 * stylesheet, and importing it into React would mean shipping a second copy of
 * the whole plan editor just to get a rail.
 */

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { resolvePlanHtmlStyle, type PlanHtmlStyle } from "@/lib/agent/plan/plan-html"
import { useSettingsStore } from "@/stores/settings"
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

/** Per-preset row/list classes. `default` keeps the original look exactly. */
const STYLE_CLASSES: Record<PlanHtmlStyle, { list: string; row: string }> = {
  default: { list: "space-y-1 p-2", row: "" },
  compact: { list: "space-y-0 p-1", row: "py-0 leading-tight" },
  // The rail is drawn on the list; each row indents past it and gets a node.
  timeline: {
    list: "relative space-y-1 p-2 pl-5 before:absolute before:top-2 before:bottom-2 before:left-2.5 before:w-px before:bg-border",
    row: "relative before:absolute before:top-1.5 before:-left-[0.6875rem] before:size-1.5 before:rounded-full before:bg-border",
  },
  cards: { list: "space-y-1.5 p-2", row: "rounded-md border bg-background px-2 py-1.5" },
}

export interface PlanTrackerPanelProps {
  plan: AgentPlan
  /**
   * Override the visual preset. Omitted ⇒ the user's
   * `planSettings.interactiveHtmlStyle`, so every plan surface reads the same.
   */
  styleVariant?: PlanHtmlStyle
}

export function PlanTrackerPanel({ plan, styleVariant }: PlanTrackerPanelProps) {
  const t = useTranslations("plan")
  const persisted = useSettingsStore((s) => s.settings?.planSettings?.interactiveHtmlStyle)
  const variant = resolvePlanHtmlStyle(styleVariant ?? persisted)
  const styles = STYLE_CLASSES[variant]
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
          <ul className={styles.list} data-testid="plan-tracker-steps" data-style={variant}>
            {steps.map((s) => (
              <li
                key={s.id}
                className={cn("flex items-start gap-2 text-xs", styles.row)}
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
