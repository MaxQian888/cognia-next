"use client"

/**
 * One run, in full (ADR-0179 §8).
 *
 * Still a Sheet, opened by `?run=`. The header now says which item the run
 * belongs to and opens it, and walks to the previous or next run in the
 * list the caller is showing. Durations are human, artifact links sit in
 * the header where they are reached first, and a plugin run's progress
 * fraction is shown when the executor reported one.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Progress } from "@/components/ui/progress"
import { FactList, FactRow } from "@/components/surface/fact-list"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { RunStatusPill } from "@/components/workflow/runs/run-status-pill"
import { formatDuration } from "@/lib/scheduler/format-utils"
import { toRunStatusPill, type UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

import { KindIcon } from "./kind-visuals"
import { RunArtifactLinks } from "./run-artifact-links"

/**
 * Payload / result dumps are arbitrarily large. Bounded height + in-place
 * scrolling keeps one big blob from turning the sheet into an endless scroll.
 */
const PRE_BLOCK =
  "max-h-64 overflow-auto break-words whitespace-pre-wrap rounded bg-muted px-3 py-2 text-[11px] font-mono text-muted-foreground"

const LOG_LEVEL_CLASS: Record<
  UnifiedExecutionRun["logs"] extends (infer L)[] | undefined
    ? L extends { level: infer V }
      ? V & string
      : never
    : never,
  string
> = {
  debug: "text-muted-foreground",
  info: "text-blue-500",
  warn: "text-yellow-500",
  error: "text-red-500",
}

/** A payload that `JSON.stringify` refuses (a cycle) still gets shown. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export interface RunDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  run: UnifiedExecutionRun | null
  /** The list the run came from, for previous / next. */
  runs?: readonly UnifiedExecutionRun[]
  onNavigate?: (run: UnifiedExecutionRun) => void
  onOpenItem?: (unifiedId: string) => void
  onOpenSession?: (sessionId: string) => void
}

/**
 * A plugin executor's last reported progress. `reportTaskProgress` persists
 * each report as a log row whose `data.kind` is `"progress"`; the unified
 * run keeps the message but not `data`, so the fraction is read back from
 * the newest such line's leading percentage.
 */
export function runProgressFraction(run: UnifiedExecutionRun): number | null {
  if (!run.logs) return null
  for (let index = run.logs.length - 1; index >= 0; index -= 1) {
    const match = /^(\d{1,3})%/.exec(run.logs[index].message)
    if (match) {
      const fraction = Number(match[1]) / 100
      if (fraction >= 0 && fraction <= 1) return fraction
    }
  }
  return null
}

export function RunDetailSheet({
  open,
  onOpenChange,
  run,
  runs = [],
  onNavigate,
  onOpenItem,
  onOpenSession,
}: RunDetailSheetProps) {
  const t = useTranslations("scheduler")
  const tSheet = useTranslations("scheduler.runSheet")
  const [showLogs, setShowLogs] = useState(false)
  const [showStack, setShowStack] = useState(false)

  if (!run) return null

  const index = runs.findIndex((candidate) => candidate.unifiedId === run.unifiedId)
  const previous = index > 0 ? runs[index - 1] : undefined
  const next = index >= 0 && index < runs.length - 1 ? runs[index + 1] : undefined
  const progress = run.status === "running" ? runProgressFraction(run) : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-hidden p-0 sm:max-w-[560px]"
        showCloseButton
      >
        <SheetHeader className="border-b px-5 pb-4 pt-5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <SheetTitle className="flex min-w-0 items-center gap-2 text-base font-semibold">
                <KindIcon kind={run.kind} className="size-4 text-muted-foreground" />
                {onOpenItem ? (
                  <button
                    type="button"
                    onClick={() => onOpenItem(run.itemUnifiedId)}
                    className="min-w-0 truncate text-left underline-offset-2 hover:underline"
                    data-testid="run-sheet-open-item"
                  >
                    {run.itemName}
                  </button>
                ) : (
                  <span className="min-w-0 truncate">{run.itemName}</span>
                )}
              </SheetTitle>
              <SheetDescription className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <RunStatusPill status={toRunStatusPill(run.status)} />
                <span>{t(`kindFilter.${run.kind}`)}</span>
                {run.triggerSource ? (
                  <Badge
                    variant="outline"
                    className="h-4 rounded-pill px-1 text-[10px] font-normal"
                  >
                    {t(`triggerSources.${run.triggerSource}`)}
                  </Badge>
                ) : null}
              </SheetDescription>
            </div>
            {onNavigate && runs.length > 1 ? (
              <div className="flex shrink-0 items-center gap-1 pe-8">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => previous && onNavigate(previous)}
                  disabled={!previous}
                  aria-label={tSheet("previous")}
                  data-testid="run-sheet-previous"
                >
                  <ChevronLeftIcon className="size-4" />
                </Button>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {tSheet("position", { index: index + 1, total: runs.length })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => next && onNavigate(next)}
                  disabled={!next}
                  aria-label={tSheet("next")}
                  data-testid="run-sheet-next"
                >
                  <ChevronRightIcon className="size-4" />
                </Button>
              </div>
            ) : null}
          </div>
          {run.result !== undefined && run.status !== "failed" ? (
            <RunArtifactLinks output={run.result} onOpenSession={onOpenSession} />
          ) : null}
        </SheetHeader>

        <div className="h-[calc(100%-6rem)] space-y-5 overflow-y-auto px-5 py-4 text-sm">
          {progress !== null ? (
            <section data-testid="run-sheet-progress">
              <Progress value={Math.round(progress * 100)} className="h-1.5" />
              <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                {tSheet("progress", { percent: Math.round(progress * 100) })}
              </p>
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("timing")}
            </h3>
            <FactList>
              <FactRow label={t("startedAt")}>{new Date(run.startedAt).toLocaleString()}</FactRow>
              <FactRow label={t("finishedAt")}>
                {run.finishedAt
                  ? new Date(run.finishedAt).toLocaleString()
                  : tSheet("stillRunning")}
              </FactRow>
              <FactRow label={t("duration")}>
                {run.status === "running" ? tSheet("stillRunning") : formatDuration(run.durationMs)}
              </FactRow>
            </FactList>
          </section>

          {run.payload !== undefined ? (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("triggerPayload")}
              </h3>
              <pre className={PRE_BLOCK} data-testid="run-sheet-payload">
                {safeStringify(run.payload)}
              </pre>
            </section>
          ) : null}

          {run.result !== undefined && run.status !== "failed" ? (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("result")}
              </h3>
              <pre className={PRE_BLOCK} data-testid="run-sheet-result">
                {safeStringify(run.result)}
              </pre>
            </section>
          ) : null}

          {run.error ? (
            <section data-testid="run-sheet-error">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
                {t("error")}
              </h3>
              <p className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs">
                {run.error.message}
                {run.error.code ? (
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                    {run.error.code}
                  </span>
                ) : null}
              </p>
              {run.error.stack ? (
                <Collapsible
                  open={showStack}
                  onOpenChange={setShowStack}
                  className="mt-2"
                  data-testid="run-sheet-stack"
                >
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                      <ChevronDownIcon className={showStack ? "size-3.5 rotate-180" : "size-3.5"} />
                      {t("stackTrace")}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className={PRE_BLOCK}>{run.error.stack}</pre>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </section>
          ) : null}

          {run.logs && run.logs.length > 0 ? (
            <Collapsible open={showLogs} onOpenChange={setShowLogs}>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  data-testid="run-sheet-logs-toggle"
                >
                  <ChevronDownIcon className={showLogs ? "size-3.5 rotate-180" : "size-3.5"} />
                  {t("logs")} ({run.logs.length})
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ol className={PRE_BLOCK} data-testid="run-sheet-logs">
                  {run.logs.map((log, i) => (
                    <li key={`${log.ts}-${i}`} className="whitespace-pre-wrap">
                      <span className="text-muted-foreground/70">
                        {new Date(log.ts).toLocaleTimeString()}
                      </span>{" "}
                      <span className={`uppercase ${LOG_LEVEL_CLASS[log.level]}`}>{log.level}</span>{" "}
                      {log.message}
                    </li>
                  ))}
                </ol>
              </CollapsibleContent>
            </Collapsible>
          ) : null}

          <div className="flex justify-end pt-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("close")}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
