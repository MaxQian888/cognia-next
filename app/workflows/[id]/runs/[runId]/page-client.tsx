"use client"

import { use } from "react"
import { RunDetail } from "@/components/workflow/runs/run-detail"

interface PageProps {
  params: Promise<{ id: string; runId: string }>
}

export function WorkflowRunDetailPageClient({ params }: PageProps) {
  const { id, runId } = use(params)
  return (
    <div className="h-full w-full overflow-hidden">
      <RunDetail workflowId={id} runId={runId} />
    </div>
  )
}
