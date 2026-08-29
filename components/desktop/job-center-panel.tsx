"use client"

import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react"
import {
  BriefcaseBusinessIcon,
  ExternalLinkIcon,
  EyeIcon,
  HistoryIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import type {
  BackgroundTaskJournalRecord,
  BackgroundTaskStatus,
} from "@/lib/background-tasks/registry-core"
import {
  cancelRendererBackgroundRun,
  collectRendererBackgroundResult,
} from "@/lib/background-tasks/renderer-subagent-registry"
import { redispatchBackgroundRun } from "@/lib/background-tasks/redispatch"
import { getBackgroundAgentManager } from "@/lib/ai/agent/background-agent-manager"
import { cancelSubagentRun } from "@/lib/claude/agents/cancel-subagent"
import { jobExecutionRunId } from "@/lib/execution/job-bridge"
import { clearSettledBackgroundTasks, listBackgroundTaskRecords } from "@/lib/db/background-tasks"
import {
  cancelBackgroundMonitor,
  killBackgroundJob,
  listBackgroundJobs,
  listBackgroundMonitors,
  readBackgroundJobTail,
  type BackgroundJobRecord,
  type BackgroundMonitorRecord,
} from "@/lib/jobs/background-jobs"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { useClientLiveQuery } from "@/hooks/data"
import { ExecutionMonitorPanel } from "@/components/execution/execution-monitor-panel"
import { useExecutionMonitor } from "@/components/execution/use-execution-monitor"
import { StatusBadge } from "@/components/status-badge"
import { BackgroundedRunControls } from "@/components/chat/message-parts/backgrounded-run-controls"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

const STATUS_VARIANTS: Record<
  BackgroundTaskStatus,
  ComponentProps<typeof StatusBadge>["fallbackVariant"]
> = {
  running: "default",
  done: "success",
  error: "destructive",
  interrupted: "warning",
}

const EMPTY_RECORDS: BackgroundTaskJournalRecord[] = []

/** Supervisor poll cadence with the sheet open — a list somebody is watching. */
const SUPERVISOR_POLL_OPEN_MS = 2_000
/** …and with it shut, where the only consumer is the trigger's badge count. */
const SUPERVISOR_POLL_CLOSED_MS = 30_000

export function JobCenterPanel({ compact = false }: { compact?: boolean }) {
  const t = useTranslations("desktop.jobCenter")
  const liveRecords =
    useClientLiveQuery(() => listBackgroundTaskRecords({ host: "renderer" }), [], EMPTY_RECORDS) ??
    EMPTY_RECORDS
  const records = liveRecords
  const [now, setNow] = useState(() => Date.now())
  const [jobs, setJobs] = useState<BackgroundJobRecord[]>([])
  const [monitors, setMonitors] = useState<BackgroundMonitorRecord[]>([])
  // This panel lives in the status bar (and the mobile shell), so it is mounted
  // for the whole life of the app while its sheet is shut almost all of it.
  // Both timers below are scoped to that fact.
  const [open, setOpen] = useState(false)

  const anyRunning =
    records.some((record) => record.status === "running") ||
    jobs.some((job) => job.status === "running") ||
    monitors.some((monitor) => monitor.status === "waiting")

  // The elapsed read-outs only exist inside the sheet, and only move while
  // something is live. Ticking regardless woke the renderer once a second for
  // the entire session to recompute text nobody was looking at.
  useEffect(() => {
    if (!open || !anyRunning) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [open, anyRunning])

  const refreshSupervisor = useCallback(async () => {
    try {
      const [nextJobs, nextMonitors] = await Promise.all([
        listBackgroundJobs(),
        listBackgroundMonitors(),
      ])
      setJobs(nextJobs)
      setMonitors(nextMonitors)
    } catch {
      // Web-only builds have no native supervisor. Keep this surface empty;
      // an active remote transport starts returning rows without remounting.
      setJobs([])
      setMonitors([])
    }
  }, [])

  // The supervisor list is native IPC (two calls per pass). It cannot stop
  // entirely while the sheet is shut — the trigger's badge counts these rows —
  // but 2s is a cadence for a list somebody is watching, not for a number in a
  // status bar, so a closed panel falls back to a slow heartbeat.
  useEffect(() => {
    const period = open ? SUPERVISOR_POLL_OPEN_MS : SUPERVISOR_POLL_CLOSED_MS
    const initialId = window.setTimeout(() => void refreshSupervisor(), 0)
    const id = window.setInterval(() => void refreshSupervisor(), period)
    return () => {
      window.clearTimeout(initialId)
      window.clearInterval(id)
    }
  }, [refreshSupervisor, open])

  // Live cross-subsystem executions (broker legs + workflow steps + scheduler),
  // governed by the ExecutionBroker — the same source the scheduler dashboard
  // renders, surfaced here so the global status-bar entry is the one place to see
  // everything running. SSR/static-export safe (server snapshot is empty).
  const { runningCount } = useExecutionMonitor()

  const active = useMemo(() => records.filter((record) => record.status === "running"), [records])
  const history = useMemo(() => records.filter((record) => record.status !== "running"), [records])
  const hasAttention =
    active.length > 0 ||
    runningCount > 0 ||
    jobs.some((job) => job.status === "running") ||
    monitors.some((monitor) => monitor.status === "waiting") ||
    history.some((record) => record.status === "interrupted")
  const supervisorCount = jobs.length + monitors.length
  const badgeCount = records.length + runningCount + supervisorCount
  const defaultTab =
    jobs.some((job) => job.status === "running") ||
    monitors.some((monitor) => monitor.status === "waiting")
      ? "supervisor"
      : runningCount > 0
        ? "running"
        : "active"

  const clearSettled = async () => {
    try {
      await clearSettledBackgroundTasks({ host: "renderer" })
      toast.success(t("toast.cleared"))
    } catch (err) {
      toast.error(t("toast.clearFailed", { error: errorMessage(err) }))
    }
  }

  return (
    <Sheet
      open={open}
      // Reseed the clock on the way in rather than from inside the interval's
      // effect: `now` can be minutes stale after a long stretch with the sheet
      // shut, and the first elapsed read-out would be wrong until the next tick.
      onOpenChange={(next) => {
        if (next) setNow(Date.now())
        setOpen(next)
      }}
    >
      <SheetTrigger asChild>
        <button
          type="button"
          data-testid="status-job-center"
          aria-label={t("open")}
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            compact ? "touch-target h-9 rounded-md px-2" : "h-6 px-2"
          )}
        >
          <BriefcaseBusinessIcon aria-hidden className={compact ? "size-5" : "size-3"} />
          <span className={compact ? "sr-only" : undefined}>{t("trigger")}</span>
          {badgeCount > 0 ? (
            <Badge
              variant={hasAttention ? "secondary" : "outline"}
              className="h-4 min-w-4 px-1 text-[10px]"
            >
              {badgeCount}
            </Badge>
          ) : null}
        </button>
      </SheetTrigger>
      <SheetContent className="w-[min(92vw,34rem)] gap-0 p-0 sm:max-w-none">
        <SheetHeader className="border-b">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>

        <Tabs defaultValue={defaultTab} className="min-h-0 flex-1 gap-0">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <TabsList>
              <TabsTrigger value="running">
                {t("tabs.running")}
                {runningCount > 0 ? (
                  <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 text-[10px]">
                    {runningCount}
                  </Badge>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="active">
                {t("tabs.active")}
                <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 text-[10px]">
                  {active.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="history">
                {t("tabs.history")}
                <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 text-[10px]">
                  {history.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="supervisor">
                {t("tabs.supervisor")}
                {supervisorCount > 0 ? (
                  <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 text-[10px]">
                    {supervisorCount}
                  </Badge>
                ) : null}
              </TabsTrigger>
            </TabsList>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void clearSettled()}
              disabled={history.length === 0}
            >
              <Trash2Icon data-icon="inline-start" />
              {t("actions.clearSettled")}
            </Button>
          </div>

          <TabsContent value="running" className="min-h-0">
            <ScrollArea className="h-[min(68vh,38rem)]">
              <div className="p-4">
                <ExecutionMonitorPanel />
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="active" className="min-h-0">
            <TaskList
              records={active}
              emptyTitle={t("empty.activeTitle")}
              emptyDescription={t("empty.activeDescription")}
              now={now}
            />
          </TabsContent>
          <TabsContent value="history" className="min-h-0">
            <TaskList
              records={history}
              emptyTitle={t("empty.historyTitle")}
              emptyDescription={t("empty.historyDescription")}
              now={now}
            />
          </TabsContent>
          <TabsContent value="supervisor" className="min-h-0">
            <SupervisorList
              jobs={jobs}
              monitors={monitors}
              now={now}
              onChanged={refreshSupervisor}
            />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

function SupervisorList({
  jobs,
  monitors,
  now,
  onChanged,
}: {
  jobs: BackgroundJobRecord[]
  monitors: BackgroundMonitorRecord[]
  now: number
  onChanged: () => Promise<void>
}) {
  const t = useTranslations("desktop.jobCenter")
  const [tails, setTails] = useState<Record<string, string>>({})
  const displayOwner = (owner: BackgroundJobRecord["owner"]) => {
    switch (owner.kind) {
      case "session":
        return t("supervisor.owner.session", { id: owner.sessionId })
      case "scheduledTask":
        return t("supervisor.owner.scheduledTask", { id: owner.taskId })
      default:
        return t("supervisor.owner.app")
    }
  }
  const displayDuration = (startedAt: number, endedAt?: number) => {
    const elapsed = elapsedParts(startedAt, endedAt, now)
    return elapsed.minutes > 0
      ? t("duration.minutesSeconds", { minutes: elapsed.minutes, seconds: elapsed.seconds })
      : t("duration.seconds", { seconds: elapsed.seconds })
  }

  if (jobs.length === 0 && monitors.length === 0) {
    return (
      <div className="flex min-h-[22rem] p-4">
        <Empty className="min-h-0 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BriefcaseBusinessIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{t("empty.supervisorTitle")}</EmptyTitle>
            <EmptyDescription>{t("empty.supervisorDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  const showTail = async (job: BackgroundJobRecord) => {
    try {
      const output = await readBackgroundJobTail(job)
      setTails((current) => ({ ...current, [job.id]: output.data || t("supervisor.noOutput") }))
    } catch (error) {
      toast.error(t("toast.logFailed", { error: errorMessage(error) }))
    }
  }

  const stopJob = async (jobId: string) => {
    try {
      await killBackgroundJob(jobId)
      await onChanged()
      toast.success(t("toast.jobStopped"))
    } catch (error) {
      toast.error(t("toast.jobStopFailed", { error: errorMessage(error) }))
    }
  }

  const stopMonitor = async (monitorId: string) => {
    try {
      await cancelBackgroundMonitor(monitorId)
      await onChanged()
      toast.success(t("toast.monitorCancelled"))
    } catch (error) {
      toast.error(t("toast.monitorCancelFailed", { error: errorMessage(error) }))
    }
  }

  return (
    <ScrollArea className="h-[min(68vh,38rem)]">
      <div className="flex flex-col gap-4 p-4">
        {jobs.length > 0 ? (
          <section className="space-y-2" aria-label={t("supervisor.jobs")}>
            <h3 className="text-sm font-semibold">{t("supervisor.jobs")}</h3>
            {jobs.map((job) => (
              <article key={job.id} className="space-y-2 rounded-md border bg-background p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {job.label ?? job.command}
                      </span>
                      <Badge variant={job.status === "running" ? "secondary" : "outline"}>
                        {t(`supervisor.jobStatus.${job.status}`)}
                      </Badge>
                      <Badge variant="outline">{displayOwner(job.owner)}</Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{job.cwd}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("fields.elapsed", {
                        value: displayDuration(job.startedAtMs, job.endedAtMs),
                      })}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void showTail(job)}
                    >
                      <EyeIcon data-icon="inline-start" />
                      {t("actions.logTail")}
                    </Button>
                    {job.status === "running" ? (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => void stopJob(job.id)}
                      >
                        <SquareIcon data-icon="inline-start" />
                        {t("actions.stop")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {tails[job.id] ? (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                    {tails[job.id]}
                  </pre>
                ) : null}
              </article>
            ))}
          </section>
        ) : null}

        {monitors.length > 0 ? (
          <section className="space-y-2" aria-label={t("supervisor.monitors")}>
            <h3 className="text-sm font-semibold">{t("supervisor.monitors")}</h3>
            {monitors.map((monitor) => (
              <article
                key={monitor.id}
                className="flex items-start justify-between gap-3 rounded-md border bg-background p-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {monitor.label ?? monitor.condition.kind}
                    </span>
                    <Badge variant={monitor.status === "waiting" ? "secondary" : "outline"}>
                      {t(`supervisor.monitorStatus.${monitor.status}`)}
                    </Badge>
                    <Badge variant="outline">{displayOwner(monitor.owner)}</Badge>
                  </div>
                  {monitor.detail ? (
                    <p className="mt-1 text-xs text-muted-foreground">{monitor.detail}</p>
                  ) : null}
                </div>
                {monitor.status === "waiting" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void stopMonitor(monitor.id)}
                  >
                    {t("actions.cancel")}
                  </Button>
                ) : null}
              </article>
            ))}
          </section>
        ) : null}
      </div>
    </ScrollArea>
  )
}

function TaskList({
  records,
  emptyTitle,
  emptyDescription,
  now,
}: {
  records: BackgroundTaskJournalRecord[]
  emptyTitle: string
  emptyDescription: string
  now: number
}) {
  if (records.length === 0) {
    return (
      <div className="flex min-h-[22rem] p-4">
        <Empty className="min-h-0 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HistoryIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{emptyTitle}</EmptyTitle>
            <EmptyDescription>{emptyDescription}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <ScrollArea className="h-[min(68vh,38rem)]">
      <div className="flex flex-col gap-2 p-4">
        {records.map((record) => (
          <TaskRow key={record.runId} record={record} now={now} />
        ))}
      </div>
    </ScrollArea>
  )
}

function TaskRow({ record, now }: { record: BackgroundTaskJournalRecord; now: number }) {
  const t = useTranslations("desktop.jobCenter")
  const router = useRouter()
  const [collecting, setCollecting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const isRunning = record.status === "running"
  const isForeground = record.mode === "foreground"
  const isSubagent = record.kind === "subagent"
  const isInterrupted = record.status === "interrupted"
  const alreadyRedispatched = !!record.resumedByRunId
  const pendingDelivery =
    (record.status === "done" || record.status === "error") && record.deliveryState === "pending"
  // Live telemetry for a running subagent run (runId === runtime-store id).
  const live = useSubagentRuntimeStore((s) => s.subAgents[record.runId])
  const liveTokens = live?.tokenUsage?.totalTokens
  const liveToolUses = live?.toolUses
  const elapsed = elapsedParts(record.startedAt, record.settledAt, now)
  const elapsedText =
    elapsed.minutes > 0
      ? t("duration.minutesSeconds", { minutes: elapsed.minutes, seconds: elapsed.seconds })
      : t("duration.seconds", { seconds: elapsed.seconds })

  const collect = async () => {
    setCollecting(true)
    try {
      const result = await collectRendererBackgroundResult(record.runId)
      if (!result) {
        toast.error(t("toast.collectMissing"))
        return
      }
      if (result.finishReason === "error") {
        toast.error(result.text)
      } else {
        toast.success(t("toast.collected"))
      }
    } catch (err) {
      toast.error(t("toast.collectFailed", { error: errorMessage(err) }))
    } finally {
      setCollecting(false)
    }
  }

  const cancel = async () => {
    setCancelling(true)
    try {
      // Route cancellation by kind/mode: background subagent runs through the
      // background registry; foreground subagent runs through the cancel
      // registry; plugin-agent / team-delegation rows through the manager.
      let cancelled = false
      if (isSubagent && isForeground) {
        cancelSubagentRun(record.runId)
        cancelled = true
      } else if (isSubagent) {
        cancelled = cancelRendererBackgroundRun(record.runId)
      } else {
        cancelled = getBackgroundAgentManager().cancelAgent(record.runId)
      }
      if (cancelled) toast.success(t("toast.cancelled"))
      else toast.error(t("toast.cancelUnavailable"))
    } finally {
      setCancelling(false)
    }
  }

  const rerun = async () => {
    setRerunning(true)
    try {
      const outcome = await redispatchBackgroundRun(record, { kind: "manual" })
      if (outcome.ok) toast.success(t("toast.rerunStarted"))
      else toast.error(t("toast.rerunFailed", { reason: outcome.message }))
    } finally {
      setRerunning(false)
    }
  }

  return (
    <article className="flex flex-col gap-3 rounded-md border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">
              {record.label ?? record.subagentId}
            </span>
            <StatusBadge
              value={record.status}
              labelNamespace="desktop.jobCenter.status"
              fallbackVariant={STATUS_VARIANTS[record.status]}
              pulse={isRunning}
              className="text-[10px]"
            />
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {t(`kind.${kindKey(record.kind)}`)}
            </Badge>
            {isForeground ? (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {t("mode.foreground")}
              </Badge>
            ) : null}
            {record.pluginId ? (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {record.pluginId}
              </Badge>
            ) : null}
            {pendingDelivery ? (
              <Badge
                variant="outline"
                className="text-[10px] text-amber-600"
                title={t("delivery.pendingHint")}
                data-testid={`job-pending-delivery-${record.runId}`}
              >
                {t("delivery.pending")}
              </Badge>
            ) : null}
            {alreadyRedispatched ? (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {t("actions.reDispatched")}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{record.prompt}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/*
            Into the cockpit, not into a detail view of its own. The job bridge
            projects this row onto `kind: "job"`, so the run's timeline, changes,
            tests and approvals already exist there — growing a second, thinner
            copy of them inside this sheet is what this link exists to avoid.
          */}
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t("actions.openInRuns")}
              title={t("actions.openInRuns")}
              data-testid={`job-open-run-${record.runId}`}
              onClick={() =>
                router.push(
                  `/agent-runs?run=${encodeURIComponent(jobExecutionRunId(record.runId))}`
                )
              }
            >
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          </SheetClose>
          {isInterrupted && isSubagent && !alreadyRedispatched ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void rerun()}
              disabled={rerunning}
              data-testid={`job-rerun-${record.runId}`}
            >
              {t("actions.rerun")}
            </Button>
          ) : null}
          <BackgroundedRunControls
            variant="labeled"
            isRunning={isRunning}
            // Foreground rows are awaited inline by their parent turn — never
            // collectable; only background subagent rows expose Collect.
            {...(isForeground || !isSubagent
              ? {}
              : {
                  onCollect: () => void collect(),
                  collecting,
                  collectLabel: t("actions.collect"),
                  collectAria: t("actions.collectAria", { runId: record.runId }),
                  collectTestId: `job-collect-${record.runId}`,
                })}
            onAbort={() => void cancel()}
            aborting={cancelling}
            abortLabel={t("actions.cancel")}
            abortAria={t("actions.cancelAria", { runId: record.runId })}
            abortTestId={`job-cancel-${record.runId}`}
          />
        </div>
      </div>

      <div className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
        <span>{t("fields.startedAt", { value: formatTime(record.startedAt) })}</span>
        <span>{t("fields.elapsed", { value: elapsedText })}</span>
        {isRunning && typeof liveTokens === "number" && liveTokens > 0 ? (
          <span data-testid={`job-tokens-${record.runId}`}>
            {t("fields.tokens", { value: liveTokens })}
          </span>
        ) : null}
        {isRunning && typeof liveToolUses === "number" && liveToolUses > 0 ? (
          <span data-testid={`job-tools-${record.runId}`}>
            {t("fields.toolCalls", { value: liveToolUses })}
          </span>
        ) : null}
      </div>

      <p
        className={cn(
          "min-h-8 rounded border bg-muted/30 p-2 text-xs leading-relaxed",
          record.status === "error" && "text-destructive"
        )}
      >
        {preview(record)}
      </p>
    </article>
  )
}

function preview(record: BackgroundTaskJournalRecord): string {
  return record.resultText ?? record.error ?? record.prompt
}

/** Journal kind → i18n key segment. */
function kindKey(kind: BackgroundTaskJournalRecord["kind"]): string {
  switch (kind) {
    case "plugin-agent":
      return "pluginAgent"
    case "team-delegation":
      return "teamDelegation"
    default:
      return "subagent"
  }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp))
}

function elapsedParts(
  startedAt: number,
  settledAt: number | undefined,
  now: number
): { minutes: number; seconds: number } {
  const end = settledAt ?? now
  const totalSeconds = Math.max(0, Math.floor((end - startedAt) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return { minutes, seconds }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
