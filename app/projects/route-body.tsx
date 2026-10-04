"use client"

import { CycleConsole } from "@/components/issues/cycles/cycle-console"
import { ProjectConsole } from "@/components/issues/projects/project-console"
import { CyclesMobileBody } from "@/components/mobile/issues/cycles-mobile-body"
import { ProjectsMobileBody } from "@/components/mobile/issues/projects-mobile-body"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

export interface RouteBodyProps {
  tab: "cycles" | "projects"
  initialSelectedId?: string
}
export default function RouteBody(props: RouteBodyProps) {
  const compact = useCompactLayout()
  return compact ? (
    props.tab === "cycles" ? (
      <CyclesMobileBody />
    ) : (
      <ProjectsMobileBody initialSelectedId={props.initialSelectedId} />
    )
  ) : props.tab === "cycles" ? (
    <CycleConsole />
  ) : (
    <ProjectConsole initialSelectedId={props.initialSelectedId} />
  )
}
