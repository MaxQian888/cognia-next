"use client"

import { MemoryConsole } from "@/components/memory/memory-console"
import { MemoryMobileBody } from "@/components/mobile/memory/memory-mobile-body"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

export interface RouteBodyProps {
  initialSelectedId?: string
  initialProjectId?: string
}
export default function RouteBody(props: RouteBodyProps) {
  const compact = useCompactLayout()
  return compact ? (
    <MemoryMobileBody
      initialSelectedId={props.initialSelectedId}
      projectId={props.initialProjectId}
    />
  ) : (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <MemoryConsole {...props} />
    </div>
  )
}
