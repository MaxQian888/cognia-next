"use client"

/**
 * Per-run detail view. Joins the WorkflowRunRow + its WorkflowRunEventRow
 * stream into a Gantt timeline + step inspector. Includes "Re-run from this
 * step" which clears completed-step events from the runId onwards and
 * re-invokes the orchestrator with the existing runId so the
 * IdempotencyCache replays everything before the chosen step.
 */

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ArrowLeftIcon, RotateCcwIcon, SquareIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { getDb } from "@/lib/db/schema"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import type { TriggerEvent, WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"
import { RunStatusPill } from "./run-status-pill"
import { RunTimeline } from "./run-timeline"
import { RunStepDetail } from "./run-step-detail"
import { formatDurationMs, formatRunStartedAt } from "./format"

export function RunDetail({ workflowId, runId }: { workflowId: string; runId: string }) {
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
        <EmptyTitle>Run not found</EmptyTitle>
        <EmptyDescription>
          The run you tried to open doesn&apos;t exist or has been cleared.
        </EmptyDescription>
        <Button onClick={() => router.push(`/workflows/${workflowId}/runs`)} className="mt-2">
          Back to runs
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
  const totalDuration = useMemo(
    () => (run.completedAt ? formatDurationMs(run.completedAt - run.startedAt) : "running"),
    [run.startedAt, run.completedAt]
  )

  const handleReRun = async () => {
    if (busy) return
    setBusy(true)
    let toastId: string | number | undefined
    try {
      toastId = toast.loading("Re-running workflow…")
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
        toast.success("Workflow completed", { id: toastId })
      } else {
        toast.error(`Re-run failed: ${result.error?.message ?? "unknown error"}`, {
          id: toastId,
        })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Re-run failed", {
        id: toastId,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Button asChild size="icon" variant="ghost" aria-label="Back to runs">
          <Link href={`/workflows/${workflowId}/runs`}>
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
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleReRun}
          disabled={busy}
          data-testid="run-detail-rerun"
        >
          <RotateCcwIcon className="size-4 mr-1.5" />
          Re-run
        </Button>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="px-6 py-4">
              <RunTimeline
                events={events}
                workflow={run.workflowSnapshot}
                startedAt={run.startedAt}
                completedAt={run.completedAt}
                selectedStepId={selectedStepId}
                onSelectStep={setSelectedStepId}
              />
            </div>
          </ScrollArea>
        </div>
        <aside className="w-96 shrink-0 border-l bg-card/40">
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
        <Skeleton className="m-4 h-full w-96" />
      </div>
    </div>
  )
}
