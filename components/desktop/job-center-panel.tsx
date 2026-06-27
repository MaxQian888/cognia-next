"use client"

import { useEffect, useMemo, useState, type ComponentProps } from "react"
import {
  BriefcaseBusinessIcon,
  DownloadIcon,
  HistoryIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react"
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
import { clearSettledBackgroundTasks, listBackgroundTaskRecords } from "@/lib/db/background-tasks"
import { useClientLiveQuery } from "@/hooks/data"
import { ExecutionMonitorPanel } from "@/components/execution/execution-monitor-panel"
import { useExecutionMonitor } from "@/components/execution/use-execution-monitor"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
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

export function JobCenterPanel() {
  const t = useTranslations("desktop.jobCenter")
  const liveRecords =
    useClientLiveQuery(() => listBackgroundTaskRecords({ host: "renderer" }), [], EMPTY_RECORDS) ??
    EMPTY_RECORDS
  const records = liveRecords
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

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
    history.some((record) => record.status === "interrupted")
  const badgeCount = records.length + runningCount
  const defaultTab = runningCount > 0 ? "running" : "active"

  const clearSettled = async () => {
    try {
      await clearSettledBackgroundTasks({ host: "renderer" })
      toast.success(t("toast.cleared"))
    } catch (err) {
      toast.error(t("toast.clearFailed", { error: errorMessage(err) }))
    }
  }

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          data-testid="status-job-center"
          aria-label={t("open")}
          className="flex h-6 shrink-0 items-center gap-1.5 px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <BriefcaseBusinessIcon aria-hidden className="size-3" />
          <span>{t("trigger")}</span>
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
        </Tabs>
      </SheetContent>
    </Sheet>
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
  const [collecting, setCollecting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const isRunning = record.status === "running"
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
      const cancelled = cancelRendererBackgroundRun(record.runId)
      if (cancelled) toast.success(t("toast.cancelled"))
      else toast.error(t("toast.cancelUnavailable"))
    } finally {
      setCancelling(false)
    }
  }

  return (
    <article className="flex flex-col gap-3 rounded-md border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{record.subagentId}</span>
            <StatusBadge
              value={record.status}
              labelNamespace="desktop.jobCenter.status"
              fallbackVariant={STATUS_VARIANTS[record.status]}
              pulse={isRunning}
              className="text-[10px]"
            />
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{record.prompt}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void collect()}
            disabled={collecting}
            data-testid={`job-collect-${record.runId}`}
            aria-label={t("actions.collectAria", { runId: record.runId })}
          >
            <DownloadIcon data-icon="inline-start" />
            {t("actions.collect")}
          </Button>
          {isRunning ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void cancel()}
              disabled={cancelling}
              data-testid={`job-cancel-${record.runId}`}
              aria-label={t("actions.cancelAria", { runId: record.runId })}
            >
              <XCircleIcon data-icon="inline-start" />
              {t("actions.cancel")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
        <span>{t("fields.startedAt", { value: formatTime(record.startedAt) })}</span>
        <span>{t("fields.elapsed", { value: elapsedText })}</span>
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
