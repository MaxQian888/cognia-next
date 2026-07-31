"use client"

/**
 * /workflows/run?id=…&runId=… — Gantt timeline + step inspector for one run.
 *
 * Static route reading the workflow id + run id from the query string (replaces
 * the old `/workflows/[id]/runs/[runId]` dynamic route, unservable for runtime
 * ids under `output: "export"`).
 */

import { Suspense } from "react"
import { notFound, useSearchParams } from "next/navigation"
import { RunDetail } from "@/components/workflow/runs/run-detail"

function WorkflowRunInner() {
  const searchParams = useSearchParams()
  const id = searchParams.get("id")
  const runId = searchParams.get("runId")
  if (!id || !runId) {
    notFound()
  }
  // `flex-1 min-h-0` (not `h-full`) so the run detail fills the height handed
  // by whichever shell wraps it — the Capacitor flex-column MobileShellWrapper
  // (below the offline banner) or the desktop shell's flex content area. A bare
  // `h-full` collapsed under the mobile shell's `min-h-[100dvh]` container.
  return (
    <div className="flex min-h-0 w-full flex-1 overflow-hidden">
      <RunDetail workflowId={id} runId={runId} />
    </div>
  )
}

export default function WorkflowRunPage() {
  return (
    <Suspense fallback={null}>
      <WorkflowRunInner />
    </Suspense>
  )
}
