"use client"

/**
 * /workflows/[id]/runs/[runId] — Gantt timeline + step inspector for one run.
 */

import { use } from "react"
import { RunDetail } from "@/components/workflow/runs/run-detail"

interface PageProps {
  params: Promise<{ id: string; runId: string }>
}

export default function WorkflowRunDetailPage({ params }: PageProps) {
  const { id, runId } = use(params)
  return (
    <div className="h-screen w-screen overflow-hidden">
      <RunDetail workflowId={id} runId={runId} />
    </div>
  )
}
