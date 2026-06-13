"use client"

/**
 * RunsTab — execution history + per-step output inside the editor's right
 * sidebar (n8n "Executions" parity, rail-sized).
 *
 * Reuses the substantive run components (`RunStatusPill`, `RunTimeline`,
 * `RunStepDetail`, the `format` helpers) — only the rail-shaped shell (compact
 * run list + back navigation + reveal-on-canvas) lives here. Live updates come
 * for free from the Dexie `useLiveQuery` subscriptions.
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import type { ReactFlowInstance } from "@xyflow/react"
import { ArrowLeftIcon, CrosshairIcon, PlayCircleIcon } from "lucide-react"
import { getDb } from "@/lib/db/schema"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import type { EditorStore } from "@/lib/workflow/editor/store"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"
import { RunStatusPill } from "@/components/workflow/runs/run-status-pill"
import { RunTimeline } from "@/components/workflow/runs/run-timeline"
import { RunStepDetail } from "@/components/workflow/runs/run-step-detail"
import { DeadLetterPanel } from "@/components/workflow/runs/dead-letter-panel"
import { formatRunStartedAt, formatRunDuration } from "@/components/workflow/runs/format"

export interface RunsTabProps {
  useStore: EditorStore
  workflowId: string
  reactFlowInstance?: ReactFlowInstance | null
}

export function RunsTab({ useStore, workflowId, reactFlowInstance }: RunsTabProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  if (selectedRunId) {
    return (
      <RunDetailRail
        runId={selectedRunId}
        onBack={() => setSelectedRunId(null)}
        useStore={useStore}
        reactFlowInstance={reactFlowInstance}
      />
    )
  }
  return <RunListRail workflowId={workflowId} onSelectRun={setSelectedRunId} />
}

function RunListRail({
  workflowId,
  onSelectRun,
}: {
  workflowId: string
  onSelectRun: (runId: string) => void
}) {
  const t = useTranslations("workflowEditor.runs")
  const runs = useLiveQuery(
    async () =>
      getDb()
        .workflowRuns.where("[workflowId+startedAt]")
        .between([workflowId, 0], [workflowId, Number.MAX_SAFE_INTEGER])
        .reverse()
        .toArray(),
    [workflowId]
  )

  if (runs === undefined) {
    return (
      <div className="space-y-2 p-3" data-testid="runs-tab">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"
        data-testid="runs-tab"
      >
        <PlayCircleIcon className="size-8" aria-hidden="true" />
        <p>{t("empty")}</p>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full" data-testid="runs-tab">
      <DeadLetterPanel workflowId={workflowId} />
      <ul className="divide-y">
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => onSelectRun(run.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
              data-testid={`runs-tab-row-${run.id}`}
            >
              <RunStatusPill status={run.status} />
              <span className="flex-1 min-w-0">
                <span className="block truncate text-xs text-muted-foreground">
                  {formatRunStartedAt(run.startedAt)}
                </span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {run.triggerKind}
                </span>
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatRunDuration(run)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  )
}

function RunDetailRail({
  runId,
  onBack,
  useStore,
  reactFlowInstance,
}: {
  runId: string
  onBack: () => void
  useStore: EditorStore
  reactFlowInstance?: ReactFlowInstance | null
}) {
  const t = useTranslations("workflowEditor.runs")
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

  // Reveal-on-canvas — mirrors `spotlight-search.tsx:handleSelect`.
  const revealOnCanvas = (stepId: string) => {
    const state = useStore.getState()
    const node = state.nodes.find((n) => n.id === stepId)
    if (node && reactFlowInstance && typeof window !== "undefined") {
      const zoom = 1.2
      const w = node.width ?? node.measured?.width ?? 240
      const h = node.height ?? node.measured?.height ?? 80
      const cxFlow = node.position.x + w / 2
      const cyFlow = node.position.y + h / 2
      reactFlowInstance.setViewport(
        {
          x: window.innerWidth / 2 - cxFlow * zoom,
          y: window.innerHeight / 2 - cyFlow * zoom,
          zoom,
        },
        { duration: 240 }
      )
    }
    state.setSelectedNodes([stepId])
    state.pulseNode(stepId, 3000)
  }

  return (
    <div className="flex h-full flex-col" data-testid="runs-tab-detail">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button size="icon" variant="ghost" onClick={onBack} aria-label={t("backToList")}>
          <ArrowLeftIcon className="size-4" />
        </Button>
        {run ? <RunStatusPill status={run.status} /> : null}
        {selectedStepId ? (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => revealOnCanvas(selectedStepId)}
            data-testid="runs-tab-reveal"
          >
            <CrosshairIcon className="mr-1 size-3.5" />
            {t("revealOnCanvas")}
          </Button>
        ) : null}
      </header>
      {run === undefined || events === undefined ? (
        <div className="space-y-2 p-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : run === null ? (
        <p className="p-6 text-center text-sm text-muted-foreground">{t("notFound")}</p>
      ) : (
        <ScrollArea className="flex-1">
          <div className="space-y-3 px-3 py-3">
            <RunTimeline
              events={events as WorkflowRunEventRow[]}
              workflow={run.workflowSnapshot}
              startedAt={run.startedAt}
              completedAt={run.completedAt}
              selectedStepId={selectedStepId}
              onSelectStep={setSelectedStepId}
            />
            <div className="rounded-md border bg-card/40">
              <RunStepDetail
                workflow={run.workflowSnapshot}
                events={events as WorkflowRunEventRow[]}
                stepId={selectedStepId}
              />
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
