"use client"

/**
 * What a schedule write will actually do, for the person approving it.
 *
 * The approval dialog used to show the agent's arguments as JSON. For
 * `scheduler_run_task_now`, `scheduler_set_task_status` and
 * `scheduler_delete_task` that JSON is a single opaque `taskId`, so the user
 * approved a deletion without being told which task it deleted; for
 * `scheduler_create_task` it was a cron string and a nested payload. This
 * names the task (live, from the local schedule the skills write to), says
 * the schedule in words, lists the next runs, and summarises what will run.
 * The raw arguments stay one click away.
 */

import { useLocale, useTranslations } from "next-intl"
import { AlertTriangleIcon } from "lucide-react"

import { CodeBlock } from "@/components/ai-elements/code-block"
import { ItemStatusBadge, KindPlate } from "@/components/scheduler/kind-visuals"
import { TriggerPreview } from "@/components/scheduler/trigger-preview"
import { useLiveScheduledTask } from "@/hooks/scheduler/use-live-scheduled-task"
import { cn } from "@/lib/utils"
import { describeCronExpression } from "@/lib/scheduler/cron-parser"
import { formatInterval } from "@/lib/scheduler/format-utils"
import { scheduleToolVerb, type ScheduleToolVerb } from "@/lib/skills/built-in/scheduler/tool-names"
import { AGENT_SCHEDULABLE_TASK_TYPES } from "@/lib/skills/built-in/scheduler/_core"
import type { ScheduledTask, TaskTrigger } from "@/types/scheduler"
import { unifiedKindForTaskType } from "@/types/scheduler/unified"

/** Payload keys that say WHAT runs, most telling first. */
const PAYLOAD_SUMMARY_KEYS = [
  "prompt",
  "objective",
  "text",
  "command",
  "workflowId",
  "planId",
  "teamId",
  "agentId",
  "skillId",
] as const

const PROMPT_EXCERPT_LIMIT = 280
/** Statuses `schedule.set_status` accepts, the only ones worth a label. */
const SETTABLE_STATUSES: ReadonlySet<string> = new Set(["active", "paused", "disabled"])
/** Types an agent may author; anything else the preview shows verbatim. */
const AUTHORABLE_TYPES: ReadonlySet<string> = new Set(AGENT_SCHEDULABLE_TASK_TYPES)
const DESTRUCTIVE_VERBS: ReadonlySet<ScheduleToolVerb> = new Set(["delete", "stopProcess"])

export function isScheduleApprovalTool(toolName: string | undefined): boolean {
  const verb = scheduleToolVerb(toolName)
  return verb !== undefined && verb !== "list" && verb !== "inspect"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

/** The agent's wire trigger → the scheduler's own shape, leniently. */
function toTrigger(raw: unknown): TaskTrigger | null {
  const record = asRecord(raw)
  switch (record?.type) {
    case "cron":
      return {
        type: "cron",
        cronExpression: asString(record.cronExpression) ?? "",
        ...(asString(record.timezone) ? { timezone: asString(record.timezone) } : {}),
      }
    case "interval":
      return typeof record.intervalMs === "number"
        ? { type: "interval", intervalMs: record.intervalMs }
        : null
    case "once": {
      const runAt = asString(record.runAt) ? new Date(record.runAt as string) : undefined
      return runAt && !Number.isNaN(runAt.getTime()) ? { type: "once", runAt } : null
    }
    case "event":
      return { type: "event", eventType: asString(record.eventType) ?? "" }
    default:
      return null
  }
}

function useTriggerSentence(): (trigger: TaskTrigger) => string {
  const t = useTranslations("scheduler")
  const tCron = useTranslations("scheduler.cronDescribe")
  const locale = useLocale()
  return (trigger) => {
    switch (trigger.type) {
      case "cron":
        return trigger.cronExpression
          ? describeCronExpression(trigger.cronExpression, tCron)
          : t("triggerTypes.cron")
      case "interval":
        return t("every", { interval: formatInterval(trigger.intervalMs) })
      case "once":
        return trigger.runAt
          ? new Date(trigger.runAt).toLocaleString(locale)
          : t("triggerTypes.once")
      case "event":
        return trigger.eventType || t("triggerTypes.event")
      default:
        return trigger.type
    }
  }
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function PayloadSummary({ payload }: { payload: Record<string, unknown> | undefined }) {
  const t = useTranslations("chat.scheduleTools")
  if (!payload) return null
  const key = PAYLOAD_SUMMARY_KEYS.find((candidate) => asString(payload[candidate]))
  if (!key) return null
  const value = payload[key] as string
  const excerpt =
    value.length > PROMPT_EXCERPT_LIMIT ? `${value.slice(0, PROMPT_EXCERPT_LIMIT)}…` : value
  return (
    <Fact label={t(`payloadKeys.${key}`)}>
      <span
        className={cn(
          "whitespace-pre-wrap",
          key !== "prompt" && key !== "objective" && key !== "text" && "font-mono"
        )}
      >
        {excerpt}
      </span>
    </Fact>
  )
}

/** The existing task an update/status/run/delete names, as it is right now. */
function TaskRow({ taskId, task }: { taskId: string; task: ScheduledTask | null | undefined }) {
  const t = useTranslations("chat.scheduleTools")
  const tTypes = useTranslations("scheduler.taskTypes")
  if (task === undefined) {
    return <div className="h-9 animate-pulse rounded-md bg-muted/60" aria-hidden="true" />
  }
  if (task === null) {
    return (
      <p
        className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400"
        data-testid="schedule-approval-missing"
      >
        <AlertTriangleIcon className="size-3.5" aria-hidden="true" />
        {t("taskMissing", { id: taskId })}
      </p>
    )
  }
  return (
    <div className="flex items-center gap-2.5" data-testid="schedule-approval-task">
      <KindPlate kind={unifiedKindForTaskType(task.type)} className="size-8" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{task.name}</p>
        <p className="truncate text-xs text-muted-foreground">{tTypes(task.type as never)}</p>
      </div>
      <ItemStatusBadge status={task.status} />
    </div>
  )
}

export interface ScheduledTaskApprovalPreviewProps {
  toolName: string
  input: Record<string, unknown>
}

export function ScheduledTaskApprovalPreview({
  toolName,
  input,
}: ScheduledTaskApprovalPreviewProps) {
  const t = useTranslations("chat.scheduleTools")
  const tTypes = useTranslations("scheduler.taskTypes")
  const tStatuses = useTranslations("scheduler.statuses")
  const describeTrigger = useTriggerSentence()
  const verb = scheduleToolVerb(toolName) ?? "create"
  const taskId = asString(input.taskId)
  const existing = useLiveScheduledTask(verb === "create" ? null : taskId)
  const trigger = toTrigger(input.trigger)
  const payload = asRecord(input.payload)
  const destructive = DESTRUCTIVE_VERBS.has(verb)

  return (
    <div
      className={cn(
        "space-y-3 rounded-lg border p-3",
        destructive ? "border-destructive/40 bg-destructive/5" : "bg-muted/20"
      )}
      data-testid="schedule-approval-preview"
      data-verb={verb}
    >
      <p
        className={cn(
          "text-xs font-medium uppercase tracking-wide",
          destructive ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {t(`verbs.${verb}`)}
      </p>

      {verb === "create" ? (
        <div className="space-y-0.5">
          <p className="text-sm font-semibold" data-testid="schedule-approval-name">
            {asString(input.name) ?? t("untitled")}
          </p>
          {asString(input.description) ? (
            <p className="text-xs text-muted-foreground">{input.description as string}</p>
          ) : null}
        </div>
      ) : (
        <TaskRow taskId={taskId ?? ""} task={existing} />
      )}

      <dl className="space-y-1.5">
        {verb === "create" && asString(input.type) ? (
          <Fact label={t("runs")}>
            {AUTHORABLE_TYPES.has(input.type as string)
              ? tTypes(input.type as never)
              : (input.type as string)}
          </Fact>
        ) : null}
        {verb === "update" && asString(input.name) ? (
          <Fact label={t("newName")}>{input.name as string}</Fact>
        ) : null}
        {trigger ? (
          <Fact label={verb === "update" ? t("newSchedule") : t("schedule")}>
            {describeTrigger(trigger)}
            {trigger.type === "cron" && trigger.cronExpression ? (
              <span className="ml-1.5 font-mono text-muted-foreground">
                {trigger.cronExpression}
                {trigger.timezone ? ` · ${trigger.timezone}` : ""}
              </span>
            ) : null}
          </Fact>
        ) : null}
        {verb === "setStatus" && asString(input.status) ? (
          <Fact label={t("newStatus")}>
            {SETTABLE_STATUSES.has(input.status as string)
              ? tStatuses(input.status as never)
              : (input.status as string)}
          </Fact>
        ) : null}
        {verb === "cancelRun" && asString(input.runId) ? (
          <Fact label={t("run")}>
            <span className="font-mono">{input.runId as string}</span>
          </Fact>
        ) : null}
        {verb === "create" || (verb === "update" && payload) ? (
          <PayloadSummary payload={payload} />
        ) : null}
        {verb === "create" && input.paused === true ? (
          <Fact label={t("starts")}>{t("startsPaused")}</Fact>
        ) : null}
      </dl>

      {trigger ? <TriggerPreview trigger={trigger} className="bg-background" /> : null}

      <p className={cn("text-xs", destructive ? "text-destructive" : "text-muted-foreground")}>
        {t(`consequences.${verb}`)}
      </p>

      <details className="group text-xs" data-testid="schedule-approval-raw">
        <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
          {t("rawArguments")}
        </summary>
        <div className="mt-2">
          <CodeBlock code={JSON.stringify(input, null, 2) ?? ""} language="json" />
        </div>
      </details>
    </div>
  )
}
