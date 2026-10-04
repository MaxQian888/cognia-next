"use client"

import { MemoryMobileBody } from "@/components/mobile/memory/memory-mobile-body"
import type { RouteBodyProps } from "./route-body"

export default function RouteBody(props: RouteBodyProps) {
  return (
    <MemoryMobileBody
      initialSelectedId={props.initialSelectedId}
      projectId={props.initialProjectId}
    />
  )
}
