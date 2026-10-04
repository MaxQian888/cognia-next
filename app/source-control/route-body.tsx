"use client"

import { SourceControlMobileBody } from "@/components/mobile/source-control/source-control-mobile-body"
import { SourceControlPanel } from "@/components/source-control/source-control-panel"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

export interface RouteBodyProps {
  initialDiffOpen: boolean
}
export default function RouteBody(props: RouteBodyProps) {
  const compact = useCompactLayout()
  return compact ? <SourceControlMobileBody {...props} /> : <SourceControlPanel />
}
