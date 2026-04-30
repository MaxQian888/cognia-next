"use client"

import { useTranslations } from "next-intl"
import { Settings } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { describeCronExpression } from "@/lib/scheduler/cron-parser"
import type { ScheduledTask } from "@/types/scheduler"

interface TaskConfigurationProps {
  task: ScheduledTask
  className?: string
}

function getScheduleText(task: ScheduledTask): string {
  const { trigger } = task
  switch (trigger.type) {
    case "cron":
      return trigger.cronExpression ? describeCronExpression(trigger.cronExpression) : "—"
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

  const timeoutSeconds = `${Math.round(task.config.timeout / 1000)}s`

  const items = [
    {
      label: t("triggerType") || "Trigger Type",
      value: task.trigger.type,
    },
    {
      label: t("schedule") || "Schedule",
      value: getScheduleText(task),
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
      label: t("concurrent") || "Concurrent",
      value: task.config.allowConcurrent
        ? t("allowed") || "Allowed"
        : t("disallowed") || "Disallowed",
    },
  ]

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
