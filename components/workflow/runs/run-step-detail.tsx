"use client"

/**
 * Right-rail step inspector for a run. Surfaces input params, output value,
 * any logs, and final status for a selected step. Reads only from the
 * durable event log so the data is identical to what the orchestrator
 * actually produced.
 */

import { useMemo } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import {
  workflowNodeCategory,
  type VisualWorkflow,
  type WorkflowRunEventRow,
} from "@/types/workflow/visual"
import { nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import { formatDurationMs } from "./format"

const CATEGORY_BADGE = {
  trigger: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  action: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  ai: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  flow: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  data: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  io: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  annotation: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
} as const

export function RunStepDetail({
  workflow,
  events,
  stepId,
}: {
  workflow: VisualWorkflow
  events: WorkflowRunEventRow[]
  stepId: string | null
}) {
  const { node, stepEvents, summary } = useMemo(() => {
    if (!stepId) return { node: null, stepEvents: [], summary: null }
    const node = workflow.nodes.find((n) => n.id === stepId) ?? null
    const stepEvents = events.filter((e) => e.stepId === stepId)
    const started = stepEvents.find((e) => e.type === "step_started")
    const terminal = [...stepEvents]
      .reverse()
      .find(
        (e) => e.type === "step_completed" || e.type === "step_failed" || e.type === "step_skipped"
      )
    // For a running step we estimate elapsed time from the most recent event
    // in the run rather than `Date.now()` so the render stays pure.
    const latestTs = events.reduce((m, e) => (e.ts > m ? e.ts : m), started?.ts ?? 0)
    const summary =
      started && terminal
        ? {
            durationMs: terminal.ts - started.ts,
            terminalType: terminal.type,
          }
        : started
          ? {
              durationMs: Math.max(0, latestTs - started.ts),
              terminalType: "running" as const,
            }
          : null
    return { node, stepEvents, summary }
  }, [stepId, workflow.nodes, events])

  if (!stepId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Select a step to inspect its input, output, and logs.
      </div>
    )
  }

  if (!node) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Step {stepId} is not in the run snapshot.
      </div>
    )
  }

  const entry = nodeCatalogEntry(node.type)
  const category = workflowNodeCategory(node.type)
  const startedEv = stepEvents.find((e) => e.type === "step_started")
  const completedEv = stepEvents.find((e) => e.type === "step_completed")
  const failedEv = stepEvents.find((e) => e.type === "step_failed")
  const skippedEv = stepEvents.find((e) => e.type === "step_skipped")
  const logEvents = stepEvents.filter((e) => e.type === "run_log")

  const startParams = (startedEv?.payload as { params?: unknown } | undefined)?.params
  const completedOutput = (completedEv?.payload as { output?: unknown } | undefined)?.output
  const failedError =
    (failedEv?.payload as { message?: string; retryable?: boolean } | undefined) ?? null
  const skippedReason = (skippedEv?.payload as { reason?: string } | undefined)?.reason

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-5">
        <div className="space-y-1.5">
          <Badge variant="outline" className={cn("font-normal", CATEGORY_BADGE[category])}>
            {entry.kind}
          </Badge>
          <h3 className="text-base font-semibold leading-tight">{node.data.label}</h3>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
        </div>

        {summary ? (
          <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 text-xs">
            <Stat label="Duration" value={formatDurationMs(summary.durationMs)} />
            <Stat label="Status" value={summary.terminalType.replace("step_", "")} />
            {startedEv ? (
              <Stat label="Started" value={new Date(startedEv.ts).toLocaleTimeString()} />
            ) : null}
            {(completedEv ?? failedEv ?? skippedEv) ? (
              <Stat
                label="Ended"
                value={new Date((completedEv ?? failedEv ?? skippedEv)!.ts).toLocaleTimeString()}
              />
            ) : null}
          </div>
        ) : null}

        {failedError ? (
          <Section title="Error">
            <pre className="whitespace-pre-wrap rounded-md border border-rose-500/40 bg-rose-500/5 p-3 text-xs">
              {failedError.message ?? "Unknown error"}
            </pre>
            {failedError.retryable === false ? (
              <p className="text-[11px] text-muted-foreground mt-1">
                The executor flagged this error as non-retryable.
              </p>
            ) : null}
          </Section>
        ) : null}

        {skippedReason ? (
          <Section title="Skip reason">
            <p className="text-sm text-muted-foreground">{skippedReason}</p>
          </Section>
        ) : null}

        <Section title="Resolved params">
          <JsonView value={startParams ?? node.data.params} />
        </Section>

        {completedOutput !== undefined ? (
          <Section title="Output">
            <JsonView value={completedOutput} />
          </Section>
        ) : null}

        {logEvents.length > 0 ? (
          <Section title="Logs">
            <div className="space-y-1.5 rounded-md border bg-muted/30 p-2">
              {logEvents.map((e) => {
                const payload = e.payload as { message?: string; data?: unknown } | undefined
                return (
                  <div key={e.id} className="flex items-start gap-2 text-xs">
                    <Badge
                      variant="outline"
                      className={cn(
                        "shrink-0 font-mono uppercase",
                        e.level === "error" && "text-rose-600 dark:text-rose-400",
                        e.level === "warn" && "text-amber-600 dark:text-amber-400"
                      )}
                    >
                      {e.level ?? "info"}
                    </Badge>
                    <div className="flex-1 min-w-0 break-words">
                      {payload?.message ?? "—"}
                      {payload?.data !== undefined ? (
                        <pre className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
                          {safeStringify(payload.data)}
                        </pre>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </Section>
        ) : null}

        <Separator />
        <p className="text-[11px] text-muted-foreground">
          Step id <code className="font-mono">{stepId}</code>
        </p>
      </div>
    </ScrollArea>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</p>
      {children}
    </div>
  )
}

function JsonView({ value }: { value: unknown }) {
  if (value === undefined) {
    return <p className="text-xs text-muted-foreground italic">No value.</p>
  }
  return (
    <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs font-mono leading-relaxed">
      {safeStringify(value)}
    </pre>
  )
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
