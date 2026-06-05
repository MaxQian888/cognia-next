"use client"

/**
 * Right-rail step inspector for a run. Surfaces input params, output value,
 * any logs, and final status for a selected step. Reads only from the
 * durable event log so the data is identical to what the orchestrator
 * actually produced.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

type LogLevel = "debug" | "info" | "warn" | "error"
const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"]
import {
  workflowNodeCategory,
  type VisualWorkflow,
  type WorkflowRunEventRow,
} from "@/types/workflow/visual"
import { nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import { tNode } from "@/lib/workflow/i18n/node-translate"
import { reduceStepStream } from "@/hooks/workflow/use-step-stream"
import { formatCostUsd, formatTokens } from "@/lib/workflow/runs/usage-aggregate"
import { formatDurationMs } from "./format"

const CATEGORY_BADGE = {
  trigger: "bg-wf-trigger/15 text-wf-trigger border-wf-trigger/30",
  action: "bg-wf-action/15 text-wf-action border-wf-action/30",
  ai: "bg-wf-ai/15 text-wf-ai border-wf-ai/30",
  flow: "bg-wf-flow/15 text-wf-flow border-wf-flow/30",
  data: "bg-wf-data/15 text-wf-data border-wf-data/30",
  io: "bg-wf-io/15 text-wf-io border-wf-io/30",
  annotation: "bg-wf-annotation/15 text-wf-annotation border-wf-annotation/30",
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
  const t = useTranslations("workflows.runs.step")
  const tLogs = useTranslations("workflows.runs.logs")
  const tNodes = useTranslations("workflows.nodes")
  const [logQuery, setLogQuery] = useState("")
  const [logLevels, setLogLevels] = useState<string[]>(LOG_LEVELS)
  const [stackOpen, setStackOpen] = useState(false)
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

  const logEvents = useMemo(() => stepEvents.filter((e) => e.type === "run_log"), [stepEvents])

  // Live streaming output (step_stream events) + the step's token/cost usage.
  const stream = useMemo(() => reduceStepStream(stepEvents, stepId), [stepEvents, stepId])
  const usage = useMemo(() => {
    const usageEv = [...stepEvents].reverse().find((e) => e.type === "step_usage")
    return (
      (usageEv?.payload as
        | {
            inputTokens?: number
            outputTokens?: number
            totalTokens?: number
            costUsd?: number
            providerId?: string
            modelId?: string
          }
        | undefined) ?? null
    )
  }, [stepEvents])

  const filteredLogs = useMemo(() => {
    const q = logQuery.trim().toLowerCase()
    return logEvents.filter((e) => {
      const level = (e.level ?? "info") as LogLevel
      if (!logLevels.includes(level)) return false
      if (!q) return true
      const payload = e.payload as { message?: string; data?: unknown } | undefined
      return (
        payload?.message?.toLowerCase().includes(q) ||
        JSON.stringify(payload?.data ?? "")
          .toLowerCase()
          .includes(q)
      )
    })
  }, [logEvents, logQuery, logLevels])

  if (!stepId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t("selectPrompt")}
      </div>
    )
  }

  if (!node) {
    return <div className="p-6 text-sm text-muted-foreground">{t("notInSnapshot", { stepId })}</div>
  }

  const entry = nodeCatalogEntry(node.type)
  const category = workflowNodeCategory(node.type)
  const startedEv = stepEvents.find((e) => e.type === "step_started")
  const completedEv = stepEvents.find((e) => e.type === "step_completed")
  const failedEv = stepEvents.find((e) => e.type === "step_failed")
  const skippedEv = stepEvents.find((e) => e.type === "step_skipped")

  const startParams = (startedEv?.payload as { params?: unknown } | undefined)?.params
  const completedOutput = (completedEv?.payload as { output?: unknown } | undefined)?.output
  const failedError =
    (failedEv?.payload as { message?: string; retryable?: boolean; stack?: string } | undefined) ??
    null
  const skippedReason = (skippedEv?.payload as { reason?: string } | undefined)?.reason

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-5">
        <div className="space-y-1.5">
          <Badge variant="outline" className={cn("font-normal", CATEGORY_BADGE[category])}>
            {entry.kind}
          </Badge>
          <h3 className="text-base font-semibold leading-tight">{node.data.label}</h3>
          <p className="text-xs text-muted-foreground">
            {tNode(tNodes, `${entry.kind}.description`, entry.description)}
          </p>
        </div>

        {summary ? (
          <div className="grid grid-cols-1 gap-2 rounded-md border bg-muted/30 p-3 text-xs sm:grid-cols-2">
            <Stat label={t("duration")} value={formatDurationMs(summary.durationMs)} />
            <Stat label={t("statusLabel")} value={summary.terminalType.replace("step_", "")} />
            {startedEv ? (
              <Stat label={t("started")} value={new Date(startedEv.ts).toLocaleTimeString()} />
            ) : null}
            {(completedEv ?? failedEv ?? skippedEv) ? (
              <Stat
                label={t("ended")}
                value={new Date((completedEv ?? failedEv ?? skippedEv)!.ts).toLocaleTimeString()}
              />
            ) : null}
            {usage ? (
              <>
                <Stat
                  label={t("tokens")}
                  value={`${formatTokens(usage.totalTokens ?? 0)} (${formatTokens(usage.inputTokens ?? 0)} / ${formatTokens(usage.outputTokens ?? 0)})`}
                />
                <Stat
                  label={t("cost")}
                  value={
                    usage.costUsd !== undefined
                      ? `${formatCostUsd(usage.costUsd)} ${t("costEstimateSuffix")}`
                      : "—"
                  }
                />
                {usage.providerId ? (
                  <Stat
                    label={t("servedBy")}
                    value={`${usage.providerId}${usage.modelId ? ` · ${usage.modelId}` : ""}`}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {stream.isStreaming ? (
          <Section title={t("streaming")}>
            <pre
              className="whitespace-pre-wrap rounded-md border border-wf-status-running/40 bg-wf-status-running/5 p-3 text-xs"
              data-testid="step-streaming-output"
            >
              {stream.text}
              <span className="animate-pulse">▌</span>
            </pre>
          </Section>
        ) : null}

        {failedError ? (
          <Section title={t("error")}>
            <pre className="whitespace-pre-wrap rounded-md border border-wf-status-failed/40 bg-wf-status-failed/5 p-3 text-xs">
              {failedError.message ?? t("error")}
            </pre>
            {failedError.stack ? (
              <Collapsible open={stackOpen} onOpenChange={setStackOpen} className="mt-1.5">
                <CollapsibleTrigger className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
                  {stackOpen ? tLogs("stackToggleHide") : tLogs("stackToggleShow")}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-1 whitespace-pre overflow-x-auto rounded-md border bg-muted/30 p-2 text-[11px] font-mono leading-relaxed">
                    {failedError.stack}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
            {failedError.retryable === false ? (
              <p className="text-[11px] text-muted-foreground mt-1">{t("nonRetryable")}</p>
            ) : null}
          </Section>
        ) : null}

        {skippedReason ? (
          <Section title={t("skipReason")}>
            <p className="text-sm text-muted-foreground">{skippedReason}</p>
          </Section>
        ) : null}

        <Section title={t("resolvedParams")}>
          <JsonView value={startParams ?? node.data.params} emptyText={t("noValue")} />
        </Section>

        {completedOutput !== undefined ? (
          <Section title={t("output")}>
            <JsonView value={completedOutput} emptyText={t("noValue")} />
          </Section>
        ) : null}

        {logEvents.length > 0 ? (
          <Section title={t("logs")}>
            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1">
                <SearchIcon className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={logQuery}
                  onChange={(e) => setLogQuery(e.target.value)}
                  placeholder={tLogs("searchPlaceholder")}
                  className="h-7 pl-7 text-xs"
                  aria-label={tLogs("searchPlaceholder")}
                />
              </div>
              <ToggleGroup
                type="multiple"
                size="sm"
                value={logLevels}
                onValueChange={(v) => setLogLevels(v.length > 0 ? v : LOG_LEVELS)}
                aria-label={tLogs("levelFilter")}
              >
                {LOG_LEVELS.map((level) => (
                  <ToggleGroupItem
                    key={level}
                    value={level}
                    className="h-7 px-2 text-[10px] uppercase"
                  >
                    {tLogs(`levels.${level}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            {filteredLogs.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                {tLogs("noResults")}
              </p>
            ) : (
              <div className="space-y-1.5 rounded-md border bg-muted/30 p-2">
                {filteredLogs.map((e) => {
                  const payload = e.payload as { message?: string; data?: unknown } | undefined
                  return (
                    <div key={e.id} className="flex items-start gap-2 text-xs">
                      <Badge
                        variant="outline"
                        className={cn(
                          "shrink-0 font-mono uppercase",
                          e.level === "error" && "text-wf-status-failed",
                          e.level === "warn" && "text-wf-status-running"
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
            )}
          </Section>
        ) : null}

        <Separator />
        <p className="text-[11px] text-muted-foreground">
          {t("stepIdLabel")} <code className="font-mono">{stepId}</code>
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

function JsonView({ value, emptyText }: { value: unknown; emptyText: string }) {
  if (value === undefined) {
    return <p className="text-xs text-muted-foreground italic">{emptyText}</p>
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
