"use client"

/**
 * RunDetailSheet — right-side `Sheet` showing the full payload, result,
 * error, and logs for a single `UnifiedExecutionRun`. Used as a drill-down
 * surface from the dashboard's recent-runs widget, the workflow / backup /
 * plugin / connector detail panels, and from `TaskExecutionHistory` rows.
 *
 * Status badge reuses the existing workflow `RunStatusPill` via the
 * `toRunStatusPill` mapper so we don't fork the visual.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ChevronRight, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Badge } from "@/components/ui/badge"
import { InspectRow } from "./details/_shared/inspect-row"
import { RunArtifactLinks } from "./run-artifact-links"
import { RunStatusPill } from "@/components/workflow/runs/run-status-pill"
import { toRunStatusPill, type UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

/**
 * Payload / result dumps are arbitrarily large. Bounded height + in-place
 * scrolling keeps one big blob from turning the sheet into an endless scroll.
 */
const PRE_BLOCK =
  "max-h-64 overflow-auto rounded bg-muted px-3 py-2 text-[11px] font-mono text-muted-foreground"

export interface RunDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  run: UnifiedExecutionRun | null
}

export function RunDetailSheet({ open, onOpenChange, run }: RunDetailSheetProps) {
  const t = useTranslations("scheduler")
  const [showLogs, setShowLogs] = useState(false)

  if (!run) return null

  const finishedText = run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "-"
  const startedText = new Date(run.startedAt).toLocaleString()
  const durationText =
    typeof run.durationMs === "number" ? `${Math.max(run.durationMs, 0)} ms` : "-"

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full p-0 overflow-hidden sm:max-w-[560px]"
        showCloseButton
      >
        <SheetHeader className="border-b px-5 pt-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SheetTitle
                className="text-base font-semibold truncate"
                data-testid="run-sheet-title"
              >
                {run.itemName}
              </SheetTitle>
              <p className="text-xs text-muted-foreground mt-1">
                {t(`kindFilter.${run.kind}`)} · {run.origin.tableName}
                {run.triggerSource && (
                  <Badge
                    variant="outline"
                    className="ml-1.5 rounded-pill px-1.5 text-[10px]"
                    data-testid="run-sheet-trigger-source"
                  >
                    {t(`triggerSources.${run.triggerSource}`)}
                  </Badge>
                )}
              </p>
            </div>
            <RunStatusPill status={toRunStatusPill(run.status)} />
          </div>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-5">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              {t("timing")}
            </h3>
            <InspectRow label={t("startedAt")} value={startedText} />
            <InspectRow label={t("finishedAt")} value={finishedText} />
            <InspectRow label={t("duration")} value={durationText} />
          </section>

          {run.payload !== undefined && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {t("triggerPayload")}
              </h3>
              <pre className={PRE_BLOCK} data-testid="run-sheet-payload">
                {safeStringify(run.payload)}
              </pre>
            </section>
          )}

          {/* Before the raw dump: the link is what the user came for, and the
              output blob is the evidence behind it. */}
          <RunArtifactLinks output={run.result} />

          {run.result !== undefined && run.status !== "failed" && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {t("result")}
              </h3>
              <pre className={PRE_BLOCK} data-testid="run-sheet-result">
                {safeStringify(run.result)}
              </pre>
            </section>
          )}

          {run.error && (
            <section data-testid="run-sheet-error">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-red-500 mb-2">
                {t("error")}
              </h3>
              <div className="rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px]">
                {/* A single unbroken message (no spaces — common for URLs and
                    serialized payloads) used to widen the sheet; wrap it. */}
                <p className="font-medium break-words whitespace-pre-wrap text-red-600">
                  {run.error.message}
                </p>
                {run.error.code && (
                  <p className="mt-1 text-muted-foreground">
                    {t("code")} {run.error.code}
                  </p>
                )}
                {/* Stacks are unbounded — keep them behind a disclosure and
                    scroll them in place so expanding never buries the logs
                    section below. */}
                {run.error.stack && (
                  <Collapsible className="mt-2" data-testid="run-sheet-stack">
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="h-auto p-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {t("stackTrace")}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-muted-foreground">
                        {run.error.stack}
                      </pre>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </div>
            </section>
          )}

          {run.logs && run.logs.length > 0 && (
            <Collapsible open={showLogs} onOpenChange={setShowLogs} asChild>
              <section>
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-auto px-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    data-testid="run-sheet-logs-toggle"
                  >
                    {showLogs ? <ChevronDown /> : <ChevronRight />}
                    {t("logs")} ({run.logs.length})
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent asChild>
                  <ul className="mt-2 space-y-1" data-testid="run-sheet-logs">
                    {run.logs.map((log, i) => (
                      <li
                        key={`${log.ts}-${i}`}
                        className="rounded bg-muted/50 px-2 py-1 text-[11px] font-mono"
                      >
                        <span className="text-muted-foreground">
                          [{new Date(log.ts).toISOString()}]
                        </span>{" "}
                        <span className={logLevelColor(log.level)}>{log.level.toUpperCase()}</span>{" "}
                        <span>{log.message}</span>
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </section>
            </Collapsible>
          )}
        </div>

        <div className="border-t px-5 py-3 flex justify-end">
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            {t("close")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function logLevelColor(level: "debug" | "info" | "warn" | "error"): string {
  switch (level) {
    case "debug":
      return "text-muted-foreground"
    case "info":
      return "text-blue-500"
    case "warn":
      return "text-yellow-500"
    case "error":
      return "text-red-500"
  }
}
