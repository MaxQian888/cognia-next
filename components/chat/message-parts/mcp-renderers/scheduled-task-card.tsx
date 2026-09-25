"use client"

/**
 * The result of a `schedule.*` tool call, as a card instead of JSON.
 *
 * The assistant can list, create, change, run and remove scheduled tasks, and
 * every one of those answers used to render as the generic tool body: a raw
 * `{ "status": "ok", "data": { "task": { … } } }` with nowhere to go from it.
 * The card names the task (live, so a pause or a finished run shows up without
 * a reload), says when it runs next, and opens it on the scheduler page. A
 * refusal says why, with the way to the settings that caused it.
 *
 * `MCPToolCard` calls the card as a function and falls back to the generic body
 * when it returns `null`, so every hook here runs unconditionally before the
 * payload is judged, and anything unrecognised returns `null`.
 */

import { useLocale, useTranslations } from "next-intl"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowUpRightIcon, Trash2Icon } from "lucide-react"
import type { ToolUIPart } from "ai"

import { Button } from "@/components/ui/button"
import { RunStatusPill } from "@/components/workflow/runs/run-status-pill"
import { ItemStatusBadge, KindIcon, useTriggerText } from "@/components/scheduler/kind-visuals"
import { useLiveScheduledTask } from "@/hooks/scheduler/use-live-scheduled-task"
import { formatNextRun } from "@/lib/scheduler/format-utils"
import { schedulerItemHref } from "@/lib/scheduler/page-query"
import { mapTaskExecStatus } from "@/lib/scheduler/sources/run-mappers"
import {
  SCHEDULE_TOOL,
  type ScheduleToolName,
  type ScheduleToolVerb,
} from "@/lib/skills/built-in/scheduler/tool-names"
import type { TaskExecution, TaskTrigger } from "@/types/scheduler"
import { toRunStatusPill } from "@/types/scheduler/unified-runs"
import { unifiedKindForTaskType, type UnifiedItemStatus } from "@/types/scheduler/unified"
import { parseOutputJson, useParsedOutput } from "./common"

/** How many rows a `scheduler_list_tasks` card shows before "+N more". */
export const SCHEDULE_LIST_CARD_ROWS = 8

/** `AgentVisibleTask` from `lib/skills/built-in/scheduler/_core.ts`, as it arrives. */
interface VisibleTask {
  id: string
  name: string
  type: string
  status: string
  trigger?: TaskTrigger
  nextRunAt?: string
  lastRunAt?: string
  lastError?: string
}

interface InspectRun {
  id: string
  status: TaskExecution["status"]
  startedAt: string
}

type Envelope =
  | { status: "ok"; data: Record<string, unknown> }
  | { status: "denied" | "error"; message: string; reason?: string }

const SETTINGS_HREF = "/settings?section=scheduled-tasks"

/**
 * The skills answer the MODEL in English ("Use scheduler_inspect_task…"), so
 * the card shows its own words for each outcome and never that text.
 */
const OUTCOME_KEYS: Readonly<Record<string, string>> = {
  cancelled: "cancelled",
  "not-found": "notFound",
  "already-finished": "alreadyFinished",
  requested: "requested",
  unsupported: "unsupported",
  unreachable: "unreachable",
  stopped: "stopped",
  "not-applicable": "notApplicable",
  unavailable: "unavailable",
}

/** Dispatcher refusal reasons the card can put in the user's own words. */
const REFUSAL_KEYS: Readonly<Record<string, string>> = {
  hitl_rejected: "declined",
  invalid_args: "invalidArgs",
  pii_blocked: "piiBlocked",
  adapter_skill_ceiling: "notAllowedHere",
  not_allowed_for_channel: "notAllowedHere",
  destructive_opt_in_required: "notAllowedHere",
  not_in_allowlist: "notAllowedHere",
}

const EXECUTION_STATUSES: ReadonlySet<string> = new Set<TaskExecution["status"]>([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
])

function readEnvelope(parsed: unknown): Envelope | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.status === "ok" && record.data && typeof record.data === "object") {
    return { status: "ok", data: record.data as Record<string, unknown> }
  }
  if (
    (record.status === "denied" || record.status === "error") &&
    typeof record.message === "string"
  ) {
    return {
      status: record.status,
      message: record.message,
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    }
  }
  return null
}

function asVisibleTask(value: unknown): VisibleTask | null {
  if (!value || typeof value !== "object") return null
  const task = value as Partial<VisibleTask>
  return typeof task.id === "string" &&
    typeof task.name === "string" &&
    typeof task.type === "string"
    ? (task as VisibleTask)
    : null
}

function inputTaskId(part: ToolUIPart): string | undefined {
  const input = part.input as Record<string, unknown> | undefined
  return typeof input?.taskId === "string" ? input.taskId : undefined
}

function hrefFor(task: { id: string; type: string }, runId?: string): string {
  return schedulerItemHref({ kind: unifiedKindForTaskType(task.type), sourceId: task.id }, runId)
}

function OpenButton({ href, label }: { href: string; label: string }) {
  const router = useRouter()
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="shrink-0"
      onClick={() => router.push(href)}
      data-testid="schedule-card-open"
    >
      <ArrowUpRightIcon className="size-3" aria-hidden="true" />
      {label}
    </Button>
  )
}

/** Opens a task (by id alone) under the kind its live row is listed as. */
function OpenTaskButton({
  taskId,
  runId,
  label,
}: {
  taskId: string
  runId?: string
  label: string
}) {
  const live = useLiveScheduledTask(taskId)
  return <OpenButton href={hrefFor({ id: taskId, type: live?.type ?? "" }, runId)} label={label} />
}

/** One task, live when it still exists; the tool's own snapshot otherwise. */
function TaskLine({ snapshot, taskId }: { snapshot: VisibleTask | null; taskId?: string }) {
  const t = useTranslations("chat.scheduleTools")
  const tScheduler = useTranslations("scheduler")
  const triggerText = useTriggerText()
  const live = useLiveScheduledTask(snapshot?.id ?? taskId)
  const task = live ?? snapshot
  if (!task) return null

  const nextRunSource = live ? live.nextRunAt : snapshot?.nextRunAt
  const nextRunAt = nextRunSource ? new Date(nextRunSource) : undefined
  const trigger = live?.trigger ?? snapshot?.trigger
  const status = (live?.status ?? snapshot?.status ?? "unknown") as UnifiedItemStatus
  const kind = unifiedKindForTaskType(task.type)

  return (
    <div className="flex items-center gap-2" data-testid="schedule-card-task">
      <KindIcon kind={kind} className="text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{task.name}</p>
        <p className="truncate text-muted-foreground">
          {trigger
            ? triggerText({
                type: trigger.type,
                cron: trigger.cronExpression,
                intervalMs: trigger.intervalMs,
                runAtMs: trigger.runAt ? new Date(trigger.runAt).getTime() : undefined,
                eventType: trigger.eventType,
                timezone: trigger.timezone,
              })
            : null}
          {nextRunAt && status === "active" ? (
            <>
              {" · "}
              {t("nextRun", {
                when: formatNextRun(nextRunAt, {
                  noSchedule: tScheduler("noSchedule"),
                  overdue: tScheduler("overdue"),
                  lessThanMinute: tScheduler("lessThanMinute"),
                }),
              })}
            </>
          ) : null}
        </p>
      </div>
      {live === null ? (
        <span className="text-muted-foreground" data-testid="schedule-card-gone">
          {t("gone")}
        </span>
      ) : (
        <ItemStatusBadge status={status} />
      )}
    </div>
  )
}

function Refusal({
  envelope,
  verb,
}: {
  envelope: Extract<Envelope, { status: "denied" | "error" }>
  verb: ScheduleToolVerb
}) {
  const t = useTranslations("chat.scheduleTools")
  const reads = verb === "list" || verb === "inspect"
  const key =
    envelope.reason && REFUSAL_KEYS[envelope.reason]
      ? REFUSAL_KEYS[envelope.reason]
      : envelope.status === "denied"
        ? "denied"
        : "failed"
  // A declined dialog is the user's own answer; there is no setting to fix.
  const offerSettings = !reads && key !== "declined"
  return (
    <div className="space-y-1.5" data-testid="schedule-card-refusal" data-reason={key}>
      <p className="text-muted-foreground">{t(`refusals.${key}`)}</p>
      {/* The skill's own words say exactly what was wrong (which field, which
          rule); kept one click away rather than shown untranslated. */}
      <details className="text-muted-foreground" data-testid="schedule-card-refusal-detail">
        <summary className="cursor-pointer select-none hover:text-foreground">
          {t("refusalDetail")}
        </summary>
        <p className="mt-1 whitespace-pre-wrap break-words">{envelope.message}</p>
      </details>
      {offerSettings ? <OpenButton href={SETTINGS_HREF} label={t("openSettings")} /> : null}
    </div>
  )
}

function ListBody({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations("chat.scheduleTools")
  const tasks = (Array.isArray(data.tasks) ? data.tasks : [])
    .map(asVisibleTask)
    .filter(Boolean) as VisibleTask[]
  const total = typeof data.total === "number" ? data.total : tasks.length
  if (tasks.length === 0) {
    return <p className="text-muted-foreground">{t("listEmpty")}</p>
  }
  const shown = tasks.slice(0, SCHEDULE_LIST_CARD_ROWS)
  return (
    <div className="space-y-1">
      <ul className="divide-y rounded-md border">
        {shown.map((task) => (
          <li key={task.id} data-testid="schedule-card-list-row">
            <Link
              href={hrefFor(task)}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted/50"
            >
              <KindIcon
                kind={unifiedKindForTaskType(task.type)}
                className="text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate">{task.name}</span>
              <ItemStatusBadge status={task.status as UnifiedItemStatus} />
            </Link>
          </li>
        ))}
      </ul>
      {total > shown.length ? (
        <p className="text-muted-foreground">{t("listMore", { count: total - shown.length })}</p>
      ) : null}
    </div>
  )
}

function ScheduledTaskCardBody({ part, verb }: { part: ToolUIPart; verb: ScheduleToolVerb }) {
  const t = useTranslations("chat.scheduleTools")
  const locale = useLocale()
  const parsed = useParsedOutput<unknown>(part.output)
  const envelope = readEnvelope(parsed)
  if (!envelope) return null

  if (envelope.status !== "ok") {
    return (
      <div className="my-1 text-xs" data-testid="schedule-card" data-verb={verb}>
        <Refusal envelope={envelope} verb={verb} />
      </div>
    )
  }

  const { data } = envelope
  const taskId = inputTaskId(part)
  const snapshot = asVisibleTask(data.task)

  let body: React.ReactNode = null
  let action: React.ReactNode = null
  switch (verb) {
    case "list":
      body = <ListBody data={data} />
      break
    case "create":
    case "update":
    case "setStatus":
    case "inspect": {
      if (!snapshot) return null
      body = (
        <>
          <TaskLine snapshot={snapshot} />
          {verb === "inspect" && Array.isArray(data.runs) && data.runs.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1" data-testid="schedule-card-runs">
              {(data.runs as InspectRun[]).slice(0, 5).map((run) => (
                <Link
                  key={run.id}
                  href={hrefFor(snapshot, run.id)}
                  title={new Date(run.startedAt).toLocaleString(locale)}
                >
                  <RunStatusPill status={toRunStatusPill(mapTaskExecStatus(run.status))} />
                </Link>
              ))}
            </div>
          ) : null}
        </>
      )
      action = <OpenButton href={hrefFor(snapshot)} label={t("openInScheduler")} />
      break
    }
    case "runNow":
    case "cancelRun":
    case "stopProcess": {
      if (!taskId) return null
      const runId = typeof data.runId === "string" ? data.runId : undefined
      const runStatus = typeof data.status === "string" ? data.status : undefined
      const known = runStatus !== undefined && EXECUTION_STATUSES.has(runStatus)
      body = (
        <>
          <TaskLine snapshot={null} taskId={taskId} />
          <div className="mt-1.5 flex items-center gap-2">
            {verb === "runNow" && known ? (
              <RunStatusPill
                status={toRunStatusPill(mapTaskExecStatus(runStatus as TaskExecution["status"]))}
              />
            ) : (
              <span className="text-muted-foreground" data-testid="schedule-card-outcome">
                {runStatus && OUTCOME_KEYS[runStatus]
                  ? t(`outcomes.${OUTCOME_KEYS[runStatus]}`)
                  : t(`outcomes.${verb}`)}
              </span>
            )}
          </div>
        </>
      )
      action = (
        <OpenTaskButton
          taskId={taskId}
          runId={runId}
          label={runId ? t("viewRun") : t("openInScheduler")}
        />
      )
      break
    }
    case "delete": {
      const name = typeof data.name === "string" ? data.name : taskId
      body = (
        <p
          className="flex items-center gap-1.5 text-muted-foreground"
          data-testid="schedule-card-deleted"
        >
          <Trash2Icon className="size-3.5" aria-hidden="true" />
          {t("deleted", { name: name ?? "" })}
        </p>
      )
      break
    }
  }

  return (
    <div
      className="my-1 flex items-start gap-3 text-xs"
      data-testid="schedule-card"
      data-verb={verb}
    >
      <div className="min-w-0 flex-1">{body}</div>
      {action}
    </div>
  )
}

function cardFor(verb: ScheduleToolVerb) {
  function ScheduledTaskCard({ part }: { part: ToolUIPart; sessionId?: string }) {
    // Rendered as an element, so the body's hooks are its own even though
    // `MCPToolCard` invokes this wrapper as a plain function.
    if (!readEnvelope(parseOutputJson(part.output))) return null
    return <ScheduledTaskCardBody part={part} verb={verb} />
  }
  return ScheduledTaskCard
}

/** One card per `schedule.*` tool, keyed by the bare tool name for the MCP card registry. */
export const SCHEDULED_TASK_CARDS = Object.fromEntries(
  (Object.entries(SCHEDULE_TOOL) as [ScheduleToolVerb, ScheduleToolName][]).map(([verb, name]) => [
    name,
    cardFor(verb),
  ])
) as Record<
  ScheduleToolName,
  (props: { part: ToolUIPart; sessionId?: string }) => React.JSX.Element | null
>
