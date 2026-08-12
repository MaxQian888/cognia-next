"use client"

/**
 * Global run-progress toaster. Surfaces live progress for workflow runs that
 * were started OUTSIDE the workflow's own editor/runs surfaces — the library
 * card Run button (`source: "desktop"`), the main-chat `/workflow` slash command
 * (`source: "chat"`), IM and API runs — so the user gets feedback wherever they
 * are. Editor canvas + run-list runs (`source: "ui"`) keep their own inline
 * toasts and are ignored here to avoid double-toasting.
 *
 * Mounted near the app root in `app/layout.tsx`, beside `<Toaster />`.
 */

import { useEffect, useRef } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { getDb } from "@/lib/db/schema"
import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"
import { decideRunToast } from "@/lib/workflow/runs/run-progress-toast"

/** Sources whose runs are surfaced globally (everything except the editor "ui"). */
const SURFACED_SOURCES = new Set(["im", "api", "chat", "desktop"])
/** Bound the liveQuery so the toaster never scans unbounded run history. */
const RECENT_LIMIT = 200

export function WorkflowRunToaster() {
  const t = useTranslations("workflows.runs.runToast")
  const router = useRouter()
  // runId → last observed status + its (loading) toast id.
  const seenRef = useRef<Map<string, { status: RunStatus; toastId: string | number }>>(new Map())

  const runs = useLiveQuery<WorkflowRunRow[]>(async () => {
    if (typeof window === "undefined") return []
    try {
      const rows = await getDb()
        .workflowRuns.where("triggeredBySource")
        .anyOf([...SURFACED_SOURCES])
        .toArray()
      return rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, RECENT_LIMIT)
    } catch {
      return []
    }
  }, [])

  useEffect(() => {
    if (!runs) return
    const seen = seenRef.current
    for (const run of runs) {
      const prev = seen.get(run.id)
      const kind = decideRunToast(prev?.status, run.status)
      if (kind === "start") {
        const toastId = toast.loading(t("started", { name: run.title ?? run.workflowId }), {
          action: actionFor(run, t, router.push),
        })
        seen.set(run.id, { status: run.status, toastId })
        continue
      }
      if (kind === "success") {
        toast.success(t("succeeded", { name: run.title ?? run.workflowId }), {
          id: prev?.toastId,
          action: actionFor(run, t, router.push),
        })
      } else if (kind === "error") {
        toast.error(t("failed", { name: run.title ?? run.workflowId }), {
          id: prev?.toastId,
          action: actionFor(run, t, router.push),
        })
      }
      // Always record the latest status so transitions are computed from it.
      seen.set(run.id, { status: run.status, toastId: prev?.toastId ?? run.id })
    }
  }, [router, runs, t])

  return null
}

function actionFor(
  run: WorkflowRunRow,
  t: ReturnType<typeof useTranslations>,
  navigate: (href: string) => void
): { label: string; onClick: () => void } {
  return {
    label: t("view"),
    onClick: () => {
      navigate(
        `/workflows/run?id=${encodeURIComponent(
          run.workflowId
        )}&runId=${encodeURIComponent(run.id)}`
      )
    },
  }
}

export default WorkflowRunToaster
