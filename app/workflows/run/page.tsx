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
  return (
    <div className="h-full w-full overflow-hidden">
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
