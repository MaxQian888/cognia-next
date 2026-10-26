"use client"

import RouteBody from "./route-body"

/**
 * `/agents/evolution?run=…` — one Harness Evolution run (ADR-0237).
 *
 * Where the approval notification and other links to a run land. A static
 * route reading the run id from the query string: the app is a static export,
 * so a dynamic segment would need every run id at build time. The agents
 * console's `evolve` mode shows the same viewer beside the agent's run list.
 */

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

function HarnessRunRoute() {
  const params = useSearchParams()
  return <RouteBody runId={params.get("run") ?? ""} />
}

export default function HarnessRunPage() {
  return (
    <Suspense fallback={null}>
      <HarnessRunRoute />
    </Suspense>
  )
}
