"use client"

import RouteBody from "./route-body"

/**
 * /workflows/runs?id=… — run history for one workflow.
 *
 * Static route reading the workflow id from the query string (replaces the old
 * `/workflows/[id]/runs` dynamic route, unservable for runtime ids under
 * `output: "export"`).
 */

import { Suspense } from "react"
import { notFound, useSearchParams } from "next/navigation"

function WorkflowRunsInner() {
  const id = useSearchParams().get("id")
  if (!id) {
    notFound()
  }
  return <RouteBody workflowId={id} />
}

export default function WorkflowRunsPage() {
  return (
    <Suspense fallback={null}>
      <WorkflowRunsInner />
    </Suspense>
  )
}
