"use client"

/**
 * When it fires and under what limits (ADR-0179 §1).
 *
 * Every kind has a trigger, a next run and a last run. Only an app-table row
 * carries the execution config (timeout, retries, overlap, end date, max
 * runs, catch-up, jitter, auto-pause), so those facts appear only when the
 * `task` is present.
 */

import { useTranslations } from "next-intl"

import { FactList, FactRow } from "@/components/surface/fact-list"
import { describeCronExpression } from "@/lib/scheduler/cron-parser"
import { formatInterval } from "@/lib/scheduler/format-utils"
import { resolveOverlapPolicy } from "@/lib/scheduler/runtime-policy"
import type { ScheduledTask, TaskOverlapPolicy } from "@/types/scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

import { useTriggerText } from "../../kind-visuals"

const OVERLAP_POLICY_KEYS: Record<TaskOverlapPolicy, string> = {
  skip: "skip",
  allow: "allow",
  "queue-one": "queueOne",
  "queue-all": "queueAll",
  "cancel-previous": "cancelPrevious",
}

export interface ScheduleSectionProps {
  item: UnifiedScheduledItem
  task?: ScheduledTask
}

export function ScheduleSection({ item, task }: ScheduleSectionProps) {
  const t = useTranslations("scheduler")
  const tCron = useTranslations("scheduler.cronDescribe")
  const triggerText = useTriggerText()

  const schedule = ((): string => {
    if (task?.trigger.type === "cron" && task.trigger.cronExpression) {
      return describeCronExpression(task.trigger.cronExpression, tCron)
    }
    if (item.triggerSummary.type === "cron" && item.triggerSummary.cron) {
      return describeCronExpression(item.triggerSummary.cron, tCron)
    }
    return triggerText(item.triggerSummary)
  })()

  return (
    <FactList>
      <FactRow label={t("triggerType")}>{t(`triggerTypes.${item.triggerSummary.type}`)}</FactRow>
      <FactRow label={t("schedule")}>{schedule}</FactRow>
      {item.triggerSummary.cron ? (
        <FactRow label={t("cron")} mono>
          {item.triggerSummary.cron}
        </FactRow>
      ) : null}
      <FactRow label={t("timezone")}>{item.triggerSummary.timezone ?? t("systemDefault")}</FactRow>
      <FactRow label={t("nextRun")}>
        {item.nextRunAt ? new Date(item.nextRunAt).toLocaleString() : t("noSchedule")}
      </FactRow>
      <FactRow label={t("lastRun")}>
        {item.lastRunAt ? new Date(item.lastRunAt).toLocaleString() : t("never")}
      </FactRow>
      {task ? (
        <>
          <FactRow label={t("timeout")}>
            {formatInterval(task.config.timeout) || `${Math.round(task.config.timeout / 1000)}s`}
          </FactRow>
          <FactRow label={t("maxRetries")}>{String(task.config.maxRetries)}</FactRow>
          <FactRow label={t("overlapPolicies.label")}>
            {t(`overlapPolicies.${OVERLAP_POLICY_KEYS[resolveOverlapPolicy(task.config)]}.title`)}
          </FactRow>
          {task.endAt ? (
            <FactRow label={t("lifecycle.endDate")}>
              {new Date(task.endAt).toLocaleString()}
            </FactRow>
          ) : null}
          {task.config.maxRuns && task.config.maxRuns > 0 ? (
            <FactRow
              label={t("lifecycle.maxRuns")}
            >{`${task.runCount}/${task.config.maxRuns}`}</FactRow>
          ) : null}
          {task.config.pauseAfterConsecutiveFailures &&
          task.config.pauseAfterConsecutiveFailures > 0 ? (
            <FactRow label={t("pauseAfterFailures.label")}>
              {String(task.config.pauseAfterConsecutiveFailures)}
            </FactRow>
          ) : null}
          {task.config.catchupWindowMs && task.config.catchupWindowMs > 0 ? (
            <FactRow label={t("catchupWindow.label")}>
              {`${Math.round(task.config.catchupWindowMs / 60_000)} min`}
            </FactRow>
          ) : null}
          {task.trigger.jitterMs && task.trigger.jitterMs > 0 ? (
            <FactRow
              label={t("jitter.label")}
            >{`${Math.round(task.trigger.jitterMs / 1_000)}s`}</FactRow>
          ) : null}
        </>
      ) : null}
    </FactList>
  )
}
