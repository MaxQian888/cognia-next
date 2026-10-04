"use client"

import { IssueConsole } from "@/components/issues/issue-console"
import { IssuesMobileBody } from "@/components/mobile/issues/issues-mobile-body"
import type { IssueSourceKind } from "@/types/issues/unified"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

export interface RouteBodyProps {
  initialSelectedId?: string
  initialSelectedSource?: IssueSourceKind
  initialProjectId?: string
  initialCycleId?: string
}
export default function RouteBody(props: RouteBodyProps) {
  const compact = useCompactLayout()
  return compact ? (
    <IssuesMobileBody initialSelectedId={props.initialSelectedId} />
  ) : (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <IssueConsole {...props} />
    </div>
  )
}
