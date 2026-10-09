"use client"

import RouteBody from "./route-body"

/**
 * `/agents`, the agents console (ADR-0220): every custom agent, its detail,
 * and the two ways to create one (blank, or by conversation).
 *
 * One static route; the view lives in the query string (`?id=&mode=`,
 * `?new=`, `?builder=`), read through `useSearchParams()` inside a
 * `<Suspense>` boundary. This app is a static export consumed by Tauri and
 * Capacitor, where dynamic `[id]` segments do not exist at runtime.
 */

import { Suspense } from "react"

import { useAgentsRouteState } from "@/hooks/agents/use-agents-route-state"

function AgentsPageInner() {
  const route = useAgentsRouteState()
  return <RouteBody route={route} />
}

export default function AgentsPage() {
  return (
    <Suspense fallback={null}>
      <AgentsPageInner />
    </Suspense>
  )
}
