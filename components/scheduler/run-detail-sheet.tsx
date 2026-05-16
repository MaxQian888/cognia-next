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
import { InspectRow } from "./details/_shared/inspect-row"
import { RunStatusPill } from "@/components/workflow/runs/run-status-pill"
import { toRunStatusPill, type UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

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
                {t(`kindFilter.${run.kind}`) || run.kind} · {run.origin.tableName}
              </p>
            </div>
            <RunStatusPill status={toRunStatusPill(run.status)} />
          </div>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-5">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              {t("timing") || "Timing"}
            </h3>
            <InspectRow label={t("startedAt") || "Started at"} value={startedText} />
            <InspectRow label={t("finishedAt") || "Finished at"} value={finishedText} />
            <InspectRow label={t("duration") || "Duration"} value={durationText} />
          </section>

          {run.payload !== undefined && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {t("triggerPayload") || "Trigger payload"}
              </h3>
              <pre
                className="rounded bg-muted px-3 py-2 text-[11px] font-mono text-muted-foreground overflow-x-auto"
                data-testid="run-sheet-payload"
              >
                {safeStringify(run.payload)}
              </pre>
            </section>
          )}

          {run.result !== undefined && run.status !== "failed" && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {t("result") || "Result"}
              </h3>
              <pre
                className="rounded bg-muted px-3 py-2 text-[11px] font-mono text-muted-foreground overflow-x-auto"
                data-testid="run-sheet-result"
              >
                {safeStringify(run.result)}
              </pre>
            </section>
          )}

          {run.error && (
            <section data-testid="run-sheet-error">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-red-500 mb-2">
                {t("error") || "Error"}
              </h3>
              <div className="rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px]">
                <p className="font-medium text-red-600">{run.error.message}</p>
                {run.error.code && (
                  <p className="mt-1 text-muted-foreground">code: {run.error.code}</p>
                )}
                {run.error.stack && (
                  <pre className="mt-2 font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap">
                    {run.error.stack}
                  </pre>
                )}
              </div>
            </section>
          )}

          {run.logs && run.logs.length > 0 && (
            <section>
              <button
                type="button"
                className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                onClick={() => setShowLogs((v) => !v)}
                data-testid="run-sheet-logs-toggle"
              >
                {showLogs ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                {t("logs") || "Logs"} ({run.logs.length})
              </button>
              {showLogs && (
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
              )}
            </section>
          )}
        </div>

        <div className="border-t px-5 py-3 flex justify-end">
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            {t("close") || "Close"}
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
