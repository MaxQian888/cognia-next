"use client"

import { AgentsMobileBody } from "@/components/mobile/agents/agents-mobile-body"
import type { RouteBodyProps } from "./route-body"

export default function RouteBody(props: RouteBodyProps) {
  return <AgentsMobileBody {...props} />
}
