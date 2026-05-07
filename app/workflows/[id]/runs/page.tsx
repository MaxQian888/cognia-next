"use client"

/**
 * /workflows/[id]/runs — list of past + in-flight runs for a single workflow.
 */

import { use } from "react"
import { RunList } from "@/components/workflow/runs/run-list"

interface PageProps {
  params: Promise<{ id: string }>
}

export default function WorkflowRunsListPage({ params }: PageProps) {
  const { id } = use(params)
  return (
    <div className="h-screen w-screen overflow-hidden">
      <RunList workflowId={id} />
    </div>
  )
}
