"use client"

import { use } from "react"
import { RunList } from "@/components/workflow/runs/run-list"

interface PageProps {
  params: Promise<{ id: string }>
}

export function WorkflowRunsListPageClient({ params }: PageProps) {
  const { id } = use(params)
  return (
    <div className="h-screen w-screen overflow-hidden">
      <RunList workflowId={id} />
    </div>
  )
}
