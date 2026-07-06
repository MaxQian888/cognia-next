"use client"

/**
 * Per-run detail view. Joins the WorkflowRunRow + its WorkflowRunEventRow
 * stream into a Gantt timeline + step inspector. Offers two re-runs:
 *   • "Re-run" — replays the whole workflow from scratch.
 *   • "Re-run from step" — re-executes the selected step and its descendant
 *     subgraph, seeding the skipped ancestor cone with THIS run's completed
 *     outputs (via `runFromStep` → orchestrator `startStepId` + `seedOutputs`)
 *     so the start step sees the same inputs it saw originally.
 */

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  ArrowLeftIcon,
  DownloadIcon,
  LayoutDashboardIcon,
  RotateCcwIcon,
  StepForwardIcon,
  SquareIcon,
} from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { getDb } from "@/lib/db/schema"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import { runFromStep } from "@/lib/workflow/runtime/run-from-step"
import type { TriggerEvent, WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"
import { RunStatusPill } from "./run-status-pill"
import { RunTimeline } from "./run-timeline"
import { RunStepDetail } from "./run-step-detail"
import { RunStepBreakdown } from "./run-step-breakdown"
import { RunDurationSparkline } from "./run-duration-sparkline"
import { formatDurationMs, formatRunStartedAt } from "./format"
import { aggregateRunUsage, formatCostUsd, formatTokens } from "@/lib/workflow/runs/usage-aggregate"
import { downloadRunExport } from "@/lib/workflow/runs/run-export"
import { InteractivePageDialog } from "@/components/a2ui/from-execution/interactive-page-dialog"

export function RunDetail({ workflowId, runId }: { workflowId: string; runId: string }) {
  const t = useTranslations("workflows.runs.detail")
  const router = useRouter()
  const run = useLiveQuery(() => getDb().workflowRuns.get(runId), [runId])
  const events = useLiveQuery(
    async () =>
      getDb()
        .workflowRunEvents.where("[runId+ts]")
        .between([runId, 0], [runId, Number.MAX_SAFE_INTEGER])
        .toArray(),
    [runId]
  )

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Auto-pick the failed step (or last step) once data arrives so users land
  // on the diagnosis. Render-time setState — runs on first render where
  // `run` + `events` are loaded, then never again.
  const [didAutoPick, setDidAutoPick] = useState(false)
  if (!didAutoPick && !selectedStepId && run && events) {
    if (run.status === "failed" && run.error?.nodeId) {
      setDidAutoPick(true)
      setSelectedStepId(run.error.nodeId)
    } else if (events.length > 0) {
      const last = events.findLast?.((e) => !!e.stepId) ?? null
      if (last?.stepId) {
        setDidAutoPick(true)
        setSelectedStepId(last.stepId)
      }
    }
  }

  // Loading state — both run row and events.
  if (run === undefined || events === undefined) {
    return <RunDetailSkeleton />
  }

  if (run === null || run === undefined) {
    return (
      <Empty className="mx-auto max-w-md py-20">
        <EmptyHeader>
          <EmptyMedia>
            <SquareIcon className="size-8" aria-hidden="true" />
          </EmptyMedia>
        </EmptyHeader>
        <EmptyTitle>{t("notFound.title")}</EmptyTitle>
        <EmptyDescription>{t("notFound.description")}</EmptyDescription>
        <Button
          onClick={() => router.push(`/workflows/runs?id=${encodeURIComponent(workflowId)}`)}
          className="mt-2"
        >
          {t("backToRuns")}
        </Button>
      </Empty>
    )
  }

  return (
    <RunDetailInner
      run={run}
      workflowId={workflowId}
      events={events as WorkflowRunEventRow[]}
      selectedStepId={selectedStepId}
      setSelectedStepId={setSelectedStepId}
      busy={busy}
      setBusy={setBusy}
    />
  )
}

function RunDetailInner({
  run,
  workflowId,
  events,
  selectedStepId,
  setSelectedStepId,
  busy,
  setBusy,
}: {
  run: WorkflowRunRow
  workflowId: string
  events: WorkflowRunEventRow[]
  selectedStepId: string | null
  setSelectedStepId: (id: string) => void
  busy: boolean
  setBusy: (v: boolean) => void
}) {
  const t = useTranslations("workflows.runs.detail")
  const tPage = useTranslations("a2ui.interactivePage")
  const tToast = useTranslations("workflows.canvasToast")
  const totalDuration = useMemo(
    () => (run.completedAt ? formatDurationMs(run.completedAt - run.startedAt) : t("running")),
    [run.startedAt, run.completedAt, t]
  )
  // Run-level token/cost rollup from step_usage events (LLM-backed steps).
  const usageSummary = useMemo(() => aggregateRunUsage(events), [events])

  const handleReRun = async () => {
    if (busy) return
    setBusy(true)
    let toastId: string | number | undefined
    try {
      toastId = toast.loading(t("rerunning"))
      const trigger: TriggerEvent = {
        workflowId: run.workflowId,
        kind: "trigger.manual",
        payload: run.triggerPayload,
        originAt: Date.now(),
      }
      const result = await runWorkflow({
        workflow: run.workflowSnapshot,
        trigger,
      })
      if (result.status === "succeeded") {
        toast.success(tToast("completed"), { id: toastId })
      } else {
        toast.error(`${tToast("runFailed")}: ${result.error?.message ?? "unknown error"}`, {
          id: toastId,
        })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tToast("runFailed"), {
        id: toastId,
      })
    } finally {
      setBusy(false)
    }
  }

  const handleReRunFromStep = async () => {
    if (busy || !selectedStepId) return
    setBusy(true)
    let toastId: string | number | undefined
    try {
      toastId = toast.loading(t("rerunning"))
      const trigger: TriggerEvent = {
        workflowId: run.workflowId,
        kind: "trigger.manual",
        payload: run.triggerPayload,
        originAt: Date.now(),
      }
      const result = await runFromStep({
        workflow: run.workflowSnapshot,
        startStepId: selectedStepId,
        seedFromRunId: run.id,
        trigger,
      })
      if (result.status === "succeeded") {
        toast.success(tToast("completed"), { id: toastId })
      } else {
        toast.error(`${tToast("runFailed")}: ${result.error?.message ?? "unknown error"}`, {
          id: toastId,
        })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tToast("runFailed"), {
        id: toastId,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* `flex-wrap` so the action cluster drops to a second row on a phone
          instead of overflowing the viewport; desktop has the width to stay
          on one line, so wrapping never triggers there. */}
      <header className="safe-area-pt flex flex-wrap items-center gap-3 border-b px-4 py-4 sm:px-6">
        <Button asChild size="icon" variant="ghost" aria-label={t("backToRuns")}>
          <Link href={`/workflows/runs?id=${encodeURIComponent(workflowId)}`}>
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold leading-tight truncate">
              {run.workflowSnapshot.name}
            </h1>
            <RunStatusPill status={run.status} />
          </div>
          <p className="text-xs text-muted-foreground">
            {formatRunStartedAt(run.startedAt)} · {totalDuration} · {run.triggerKind}
            {usageSummary.totalTokens > 0 ? (
              <span data-testid="run-usage-pill">
                {" · "}
                {t("totalTokens", { tokens: formatTokens(usageSummary.totalTokens) })}
                {usageSummary.totalCostUsd !== undefined
                  ? ` · ${t("totalCost", { cost: formatCostUsd(usageSummary.totalCostUsd) })}${usageSummary.hasUnknownCost ? "+" : ""}`
                  : ""}
              </span>
            ) : null}
          </p>
        </div>
        <div className="hidden sm:block">
          <RunDurationSparkline workflowId={run.workflowId} />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadRunExport(run, events, run.workflowSnapshot.name)}
          data-testid="run-detail-export"
        >
          <DownloadIcon className="size-4 mr-1.5" />
          {t("export")}
        </Button>
        <InteractivePageDialog
          source={{ kind: "workflow-run", run, events, workflowName: run.workflowSnapshot.name }}
          trigger={
            <Button variant="outline" size="sm" data-testid="run-detail-interactive-page">
              <LayoutDashboardIcon className="size-4 mr-1.5" />
              {tPage("openAction")}
            </Button>
          }
        />
        <Button
          variant="outline"
          size="sm"
          onClick={handleReRunFromStep}
          disabled={busy || !selectedStepId}
          title={selectedStepId ? undefined : t("rerunFromStepHint")}
          data-testid="run-detail-rerun-from-step"
        >
          <StepForwardIcon className="size-4 mr-1.5" />
          {t("rerunFromStep")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleReRun}
          disabled={busy}
          data-testid="run-detail-rerun"
        >
          <RotateCcwIcon className="size-4 mr-1.5" />
          {busy ? t("rerunning") : t("rerun")}
        </Button>
      </header>
      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="min-h-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="px-4 py-4 sm:px-6">
              <RunTimeline
                events={events}
                workflow={run.workflowSnapshot}
                startedAt={run.startedAt}
                completedAt={run.completedAt}
                selectedStepId={selectedStepId}
                onSelectStep={setSelectedStepId}
              />
              <RunStepBreakdown
                workflow={run.workflowSnapshot}
                events={events}
                startedAt={run.startedAt}
                completedAt={run.completedAt}
              />
            </div>
          </ScrollArea>
        </div>
        {/* Step inspector: a side rail on desktop; below the timeline (capped
            height, scrollable) on mobile so step I/O stays reachable. */}
        <aside className="min-h-0 shrink-0 overflow-y-auto border-t bg-card/40 max-lg:max-h-[45%] lg:w-96 lg:border-t-0 lg:border-l">
          <RunStepDetail workflow={run.workflowSnapshot} events={events} stepId={selectedStepId} />
        </aside>
      </div>
    </div>
  )
}

function RunDetailSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Skeleton className="size-8" />
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-3 w-40" />
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 px-6 py-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
        <Skeleton className="m-4 hidden h-full w-96 lg:block" />
      </div>
    </div>
  )
}
