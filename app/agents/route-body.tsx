"use client"

import { AgentsConsole } from "@/components/agents/agents-console"
import { AgentsMobileBody } from "@/components/mobile/agents/agents-mobile-body"
import type { AgentsRouteState } from "@/hooks/agents/use-agents-route-state"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

export interface RouteBodyProps {
  route: AgentsRouteState
}
export default function RouteBody(props: RouteBodyProps) {
  const compact = useCompactLayout()
  return compact ? <AgentsMobileBody {...props} /> : <AgentsConsole {...props} />
}
