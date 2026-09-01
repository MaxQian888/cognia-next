"use client"

/**
 * Mobile runs list for a single workflow. The desktop `RunList` renders a
 * wide `<Table>` that horizontal-scrolls on a phone; on mobile we reuse the
 * existing `RunVerticalGantt` (a touch-friendly vertical run list) inside the
 * standard mobile sub-page shell, with lightweight status filter chips and a
 * "clear history" action layered on top (sharing the same delete primitive +
 * filter logic as the desktop surface).
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { Trash2Icon } from "lucide-react"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import { getDb } from "@/lib/db/schema"
import { deleteAllRunsForWorkflow } from "@/lib/db/workflows"
import { transport } from "@/lib/tauri/transport-instance"
import {
  DEFAULT_RUN_FILTERS,
  filterRuns,
  type RunListFilters,
} from "@/lib/workflow/runs/run-list-filter"
import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"

import { RunVerticalGantt } from "./run-vertical-gantt"

export interface MobileRunsListProps {
  workflowId: string
}

const STATUS_CHIPS: (RunStatus | "all")[] = ["all", "succeeded", "failed", "running"]

export function MobileRunsList({ workflowId }: MobileRunsListProps) {
  const t = useTranslations("mobile.workflow")
  const tList = useTranslations("workflows.runs.list")
  const tStatus = useTranslations("workflows.runs.status")
  // `startedAt` is indexed (see recent-runs-feed); filter by workflow id in JS
  // so we don't depend on a `workflowId` index existing on the table.
  const allRuns = useLiveQuery<WorkflowRunRow[]>(
    () => getDb().workflowRuns.orderBy("startedAt").reverse().toArray(),
    []
  )
  const [status, setStatus] = useState<RunStatus | "all">("all")
  const [confirmClear, setConfirmClear] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<WorkflowRunRow | null>(null)
  const [cancelling, setCancelling] = useState(false)
  // Pin "now" at mount so the date-window boundary stays stable across renders.
  const [now] = useState(() => Date.now())

  const workflowRuns = useMemo(
    () => (allRuns ?? []).filter((r) => r.workflowId === workflowId),
    [allRuns, workflowId]
  )
  const runs = useMemo(() => {
    const filters: RunListFilters = { ...DEFAULT_RUN_FILTERS, status }
    return filterRuns(workflowRuns, filters, now)
  }, [workflowRuns, status, now])

  // Remote-cancel an in-flight run on the desktop. The run row's status
  // flips via the normal sync-down of `workflowRuns`, so no local mutation.
  const handleCancelRun = async () => {
    const run = cancelTarget
    setCancelTarget(null)
    if (!run) return
    setCancelling(true)
    try {
      const result = (await transport.call("workflow_cancel_run", { runId: run.id })) as {
        cancelled?: boolean
      } | null
      if (result?.cancelled) {
        toast.success(t("cancelRunSuccess"))
      } else {
        toast.error(t("cancelRunFailed"))
      }
    } catch {
      // Desktop unreachable — the list keeps rendering the last-synced rows.
      toast.error(t("cancelRunFailed"))
    } finally {
      setCancelling(false)
    }
  }

  const handleClear = async () => {
    setConfirmClear(false)
    try {
      await deleteAllRunsForWorkflow(workflowId)
      toast.success(tList("deleteSuccess"))
    } catch {
      toast.error(tList("deleteFailed"))
    }
  }

  return (
    <SubPageShell
      title={t("runsHeader")}
      backAria={t("runsBackAria")}
      backHref={`/workflows/editor?id=${encodeURIComponent(workflowId)}`}
      testid="mobile-runs-list"
    >
      <div className="mb-3 flex items-center gap-1.5 overflow-x-auto">
        {STATUS_CHIPS.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? "default" : "outline"}
            className={cn("h-7 shrink-0 rounded-pill px-3 text-xs")}
            onClick={() => setStatus(s)}
            data-testid={`mobile-runs-filter-${s}`}
          >
            {s === "all" ? tList("filter.allStatuses") : tStatus(s)}
          </Button>
        ))}
        {workflowRuns.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 shrink-0 px-2 text-xs text-destructive"
            onClick={() => setConfirmClear(true)}
            data-testid="mobile-runs-clear"
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        ) : null}
      </div>

      <RunVerticalGantt
        runs={runs}
        onCancelRun={cancelling ? undefined : setCancelTarget}
        // The Gantt takes a className rather than children, so the tier is
        // set through the same attribute `Surface` writes instead of wrapping
        // it in one and giving the chart a second box to size against.
        data-surface-layer="raised"
        className="rounded-control border border-border bg-[var(--surface-bg)]"
      />

      <AlertDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("cancelRunTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("cancelRunDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tList("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleCancelRun()}
              data-testid="mobile-runs-confirm-cancel-run"
            >
              {t("cancelRunConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tList("clearHistory.title")}</AlertDialogTitle>
            <AlertDialogDescription>{tList("clearHistory.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tList("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleClear} data-testid="mobile-runs-confirm-clear">
              {tList("confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SubPageShell>
  )
}
