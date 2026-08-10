"use client"

/**
 * Dead-letter panel (run-fallback A3) — the recovery surface for terminally
 * failed runs. Lists unacknowledged `status: "failed"` runs (via the existing
 * `status` index — no schema change) and offers three reuse-backed actions:
 *
 *   • Replay      → Execution Authority against the original immutable version.
 *   • Resume      → Execution Authority from the failed step, reusing the
 *                   prior run's completed outputs and skipping side effects.
 *   • Dismiss     → `acknowledgeRun` — hide it from the queue.
 *
 * Replays link back via `markReplayed` so the panel can show "replayed ×N".
 * Live-queried, so a successful replay's new run appears in the history list
 * immediately and the dismissed/acknowledged row drops out.
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, PlayIcon, RotateCcwIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { acknowledgeRun, listDeadLetters, markReplayed } from "@/lib/db/workflows"
import { retryWorkflowRun } from "@/lib/workflow/runtime/execution-authority"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import { formatRunStartedAt } from "./format"

export interface DeadLetterPanelProps {
  /** Scope to one workflow; omit for a global dead-letter view. */
  workflowId?: string
}

export function DeadLetterPanel({ workflowId }: DeadLetterPanelProps) {
  const t = useTranslations("workflowEditor.runs.deadLetter")
  const rows = useLiveQuery(() => listDeadLetters(workflowId), [workflowId])
  const [busyId, setBusyId] = useState<string | null>(null)

  if (!rows || rows.length === 0) return null

  const replay = async (row: WorkflowRunRow) => {
    setBusyId(row.id)
    try {
      const result = await retryWorkflowRun({
        runId: row.id,
        mode: "original-version",
        operatedBy: "workflow-dead-letter",
      })
      await markReplayed(row.id, result.runId)
      toast.success(t("replayStarted"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const resume = async (row: WorkflowRunRow) => {
    const startStepId = row.error?.nodeId ?? row.lastCompletedStepId
    if (!startStepId) {
      await replay(row)
      return
    }
    setBusyId(row.id)
    try {
      const result = await retryWorkflowRun({
        runId: row.id,
        mode: "failed-step",
        operatedBy: "workflow-dead-letter",
        startStepId,
      })
      await markReplayed(row.id, result.runId)
      toast.success(t("resumeStarted"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const dismiss = async (row: WorkflowRunRow) => {
    await acknowledgeRun(row.id)
  }

  return (
    <section className="border-b bg-destructive/5" data-testid="dead-letter-panel">
      <div className="flex items-center gap-2 px-3 py-2">
        <AlertTriangleIcon className="size-3.5 text-destructive" aria-hidden="true" />
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-destructive">
          {t("title", { count: rows.length })}
        </span>
      </div>
      <ul className="divide-y divide-destructive/10">
        {rows.map((row) => (
          <li key={row.id} className="px-3 py-2" data-testid={`dead-letter-row-${row.id}`}>
            <div className="min-w-0">
              <p className="truncate text-xs text-foreground" title={row.error?.message}>
                {row.error?.message ?? t("unknownError")}
              </p>
              <p className="truncate text-[10px] text-muted-foreground">
                {formatRunStartedAt(row.startedAt)}
                {row.error?.nodeId ? ` · ${row.error.nodeId}` : ""}
                {row.replayCount ? ` · ${t("replayedBadge", { count: row.replayCount })}` : ""}
              </p>
            </div>
            <div className="mt-1.5 flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                disabled={busyId === row.id}
                onClick={() => void resume(row)}
                data-testid={`dead-letter-resume-${row.id}`}
              >
                <RotateCcwIcon className="mr-1 size-3" aria-hidden="true" />
                {t("resume")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                disabled={busyId === row.id}
                onClick={() => void replay(row)}
                data-testid={`dead-letter-replay-${row.id}`}
              >
                <PlayIcon className="mr-1 size-3" aria-hidden="true" />
                {t("replay")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2 text-[11px]"
                onClick={() => void dismiss(row)}
                data-testid={`dead-letter-dismiss-${row.id}`}
                aria-label={t("dismiss")}
              >
                <XIcon className="size-3" aria-hidden="true" />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
