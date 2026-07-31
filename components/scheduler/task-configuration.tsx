"use client"

import { useTranslations } from "next-intl"
import { Settings } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { describeCronExpression } from "@/lib/scheduler/cron-parser"
import { resolveOverlapPolicy } from "@/lib/scheduler/runtime-policy"
import type { ScheduledTask, TaskOverlapPolicy } from "@/types/scheduler"

/** i18n sub-keys under `scheduler.overlapPolicies.*` per policy value. */
const OVERLAP_POLICY_KEYS: Record<TaskOverlapPolicy, string> = {
  skip: "skip",
  allow: "allow",
  "queue-one": "queueOne",
  "queue-all": "queueAll",
  "cancel-previous": "cancelPrevious",
}

interface TaskConfigurationProps {
  task: ScheduledTask
  className?: string
}

function getScheduleText(task: ScheduledTask, describeCron: (expr: string) => string): string {
  const { trigger } = task
  switch (trigger.type) {
    case "cron":
      return trigger.cronExpression ? describeCron(trigger.cronExpression) : "—"
    case "interval":
      return trigger.intervalMs !== undefined
        ? `${Math.round(trigger.intervalMs / 60000)} min`
        : "—"
    case "once":
      return trigger.runAt ? new Date(trigger.runAt).toLocaleString() : "—"
    case "event":
      return trigger.eventType ?? "—"
    default:
      return "—"
  }
}

export function TaskConfiguration({ task, className }: TaskConfigurationProps) {
  const t = useTranslations("scheduler")
  const tCron = useTranslations("scheduler.cronDescribe")

  const timeoutSeconds = `${Math.round(task.config.timeout / 1000)}s`

  const items = [
    {
      label: t("triggerType") || "Trigger Type",
      value: task.trigger.type,
    },
    {
      label: t("schedule") || "Schedule",
      value: getScheduleText(task, (expr) => describeCronExpression(expr, tCron)),
    },
    {
      label: t("timezone") || "Timezone",
      value: task.trigger.timezone || t("systemDefault") || "System default",
    },
    {
      label: t("maxRetries") || "Max Retries",
      value: String(task.config.maxRetries),
    },
    {
      label: t("timeout") || "Timeout",
      value: timeoutSeconds,
    },
    {
      label: t("overlapPolicies.label") || "Overlap policy",
      value:
        t(`overlapPolicies.${OVERLAP_POLICY_KEYS[resolveOverlapPolicy(task.config)]}.title`) ||
        resolveOverlapPolicy(task.config),
    },
  ]

  // Optional limits — rendered only when configured on the task.
  if (task.endAt) {
    items.push({
      label: t("lifecycle.endDate") || "End date",
      value: new Date(task.endAt).toLocaleString(),
    })
  }
  if (task.config.maxRuns && task.config.maxRuns > 0) {
    items.push({
      label: t("lifecycle.maxRuns") || "Max runs",
      value: `${task.runCount}/${task.config.maxRuns}`,
    })
  }
  if (task.config.pauseAfterConsecutiveFailures && task.config.pauseAfterConsecutiveFailures > 0) {
    items.push({
      label: t("pauseAfterFailures.label") || "Auto-pause after failures",
      value: String(task.config.pauseAfterConsecutiveFailures),
    })
  }
  if (task.config.catchupWindowMs && task.config.catchupWindowMs > 0) {
    items.push({
      label: t("catchupWindow.label") || "Catch-up window",
      value: `${Math.round(task.config.catchupWindowMs / 60_000)} min`,
    })
  }
  if (task.trigger.jitterMs && task.trigger.jitterMs > 0) {
    items.push({
      label: t("jitter.label") || "Jitter",
      value: `${Math.round(task.trigger.jitterMs / 1_000)}s`,
    })
  }

  return (
    <Card className={cn("border-border/50 bg-card/80", className)}>
      <CardContent className="p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Settings className="h-4 w-4 text-primary" />
          {t("configuration") || "Configuration"}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <div key={item.label} className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {item.label}
              </span>
              <span className="text-sm font-mono text-foreground">{item.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
