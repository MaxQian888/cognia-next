"use client"

/**
 * /workflows/runs?id=… — run history for one workflow.
 *
 * Static route reading the workflow id from the query string (replaces the old
 * `/workflows/[id]/runs` dynamic route, unservable for runtime ids under
 * `output: "export"`).
 */

import { Suspense } from "react"
import { notFound, useSearchParams } from "next/navigation"
import { RunList } from "@/components/workflow/runs/run-list"
import { MobileRunsList } from "@/components/mobile/workflow/mobile-runs-list"
import { useIsMobile } from "@/hooks/ui/use-mobile"

function WorkflowRunsInner() {
  // `useIsMobile()` (Capacitor pin OR < 768px viewport) so a phone-width
  // browser gets the touch run list instead of the wide desktop table.
  const isMobile = useIsMobile()
  const id = useSearchParams().get("id")
  if (!id) {
    notFound()
  }
  if (isMobile) {
    return <MobileRunsList workflowId={id} />
  }
  return (
    <div className="h-full w-full overflow-hidden">
      <RunList workflowId={id} />
    </div>
  )
}

export default function WorkflowRunsPage() {
  return (
    <Suspense fallback={null}>
      <WorkflowRunsInner />
    </Suspense>
  )
}
