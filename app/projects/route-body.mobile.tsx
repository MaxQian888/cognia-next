"use client"

import { CyclesMobileBody } from "@/components/mobile/issues/cycles-mobile-body"
import { ProjectsMobileBody } from "@/components/mobile/issues/projects-mobile-body"
import type { RouteBodyProps } from "./route-body"

export default function RouteBody(props: RouteBodyProps) {
  return props.tab === "cycles" ? (
    <CyclesMobileBody />
  ) : (
    <ProjectsMobileBody initialSelectedId={props.initialSelectedId} />
  )
}
