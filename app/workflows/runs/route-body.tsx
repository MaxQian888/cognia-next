"use client"

import { RunList } from "@/components/workflow/runs/run-list"
import { MobileRunsList } from "@/components/mobile/workflow/mobile-runs-list"
import { useIsMobile } from "@/hooks/ui/use-mobile"

export interface RouteBodyProps {
  workflowId: string
}
export default function RouteBody(props: RouteBodyProps) {
  const compact = useIsMobile()
  return compact ? (
    <MobileRunsList {...props} />
  ) : (
    <div className="h-full w-full overflow-hidden">
      <RunList {...props} />
    </div>
  )
}
