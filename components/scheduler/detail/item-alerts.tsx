"use client"

/**
 * What is wrong with this item, stated above its sections (ADR-0179 §1).
 *
 * The same `AttentionSignal`s the overview and the list row show, plus the
 * two facts only the detail knows: a deprecated type with no executor, and
 * an OS task the platform reports as degraded.
 */

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, InfoIcon, OctagonAlertIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { cn } from "@/lib/utils"
import type { AttentionSignal } from "@/lib/scheduler/attention"
import { isDeprecatedTaskType } from "@/lib/scheduler/host-support"
import type { ScheduledTask } from "@/types/scheduler"
import type { SystemTask } from "@/types/scheduler/system-scheduler"

import { useAttentionSentence } from "../overview/attention-block"

export interface ItemAlertsProps {
  signals: readonly AttentionSignal[]
  task?: ScheduledTask
  systemTask?: SystemTask
  className?: string
}

const ICON = {
  critical: OctagonAlertIcon,
  attention: AlertTriangleIcon,
  info: InfoIcon,
} as const

export function ItemAlerts({ signals, task, systemTask, className }: ItemAlertsProps) {
  const t = useTranslations("scheduler")
  const sentence = useAttentionSentence()

  const alerts: {
    id: string
    severity: AttentionSignal["severity"]
    title: string
    body?: string
  }[] = []

  if (task && isDeprecatedTaskType(task.type)) {
    alerts.push({
      id: "deprecated",
      severity: "attention",
      title: t("hostSupport.deprecatedBanner", { type: task.type }),
    })
  }
  for (const signal of signals) {
    // The deprecated banner above already says what `unsupported-type` would.
    if (signal.kind === "unsupported-type" && task && isDeprecatedTaskType(task.type)) continue
    alerts.push({
      id: signal.id,
      severity: signal.severity,
      title: sentence(signal),
      body:
        signal.kind === "unsupported-type" && signal.reason
          ? t(`hostSupport.reason.${signal.reason}`, { missing: signal.missing ?? "" })
          : signal.kind === "needs-approval"
            ? [
                signal.tools ? t("approval.hintTools") : null,
                signal.roots ? t("approval.hintTrust") : null,
              ]
                .filter((line): line is string => line !== null)
                .join("\n") || undefined
            : undefined,
    })
  }
  if (systemTask?.degraded_reasons?.length) {
    alerts.push({
      id: "degraded",
      severity: "attention",
      title: t("detail.degradedReasons"),
      body: systemTask.degraded_reasons.join(" "),
    })
  }

  if (alerts.length === 0) return null

  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="item-alerts">
      {alerts.map((alert) => {
        const Icon = ICON[alert.severity]
        return (
          <Alert
            key={alert.id}
            variant={alert.severity === "critical" ? "destructive" : "default"}
            data-testid={`item-alert-${alert.id}`}
            data-severity={alert.severity}
          >
            <Icon className="size-4" aria-hidden="true" />
            <AlertTitle className="text-xs">{alert.title}</AlertTitle>
            {alert.body ? (
              <AlertDescription className="whitespace-pre-line text-xs">
                {alert.body}
              </AlertDescription>
            ) : null}
          </Alert>
        )
      })}
    </div>
  )
}
