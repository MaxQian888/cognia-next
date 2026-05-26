"use client"

import { use } from "react"
import { RunList } from "@/components/workflow/runs/run-list"
import { MobileRunsList } from "@/components/mobile/workflow/mobile-runs-list"
import { usePlatform } from "@/hooks/use-platform"

interface PageProps {
  params: Promise<{ id: string }>
}

export function WorkflowRunsListPageClient({ params }: PageProps) {
  const platform = usePlatform()
  const { id } = use(params)
  if (platform === "mobile") {
    return <MobileRunsList workflowId={id} />
  }
  return (
    <div className="h-full w-full overflow-hidden">
      <RunList workflowId={id} />
    </div>
  )
}
