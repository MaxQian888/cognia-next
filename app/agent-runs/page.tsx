"use client"

import { Suspense, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AgentRunsPanel } from "@/components/agent-runs/agent-runs-panel"
import { COCKPIT_STATUS_GROUPS, type CockpitStatusGroup } from "@/lib/execution/cockpit-model"
import { EXECUTION_FILTER_KINDS, type ExecutionFilterKind } from "@/lib/execution/monitor-model"

/**
 * The task cockpit route. Static-export-safe: the selection and both filters
 * live in `?run=` / `?kind=` / `?status=` query params (read via
 * `useSearchParams` inside a `<Suspense>` boundary), NOT a dynamic `[id]`
 * segment — those break in the production Tauri static export.
 *
 * `?run=` carries the EXECUTION RUN id. That is what `run-reducer.ts` stamps
 * into every IM card's `detailsUrl`, so a card's "open details" now lands on
 * the right run; the panel previously matched a different id space and every
 * one of those links opened an empty pane.
 *
 * Both filter params are validated against their closed sets rather than cast,
 * so a hand-edited URL falls back to "all" instead of silently filtering the
 * list down to nothing.
 */
function isStatusGroup(value: string | null): value is CockpitStatusGroup {
  return value !== null && (COCKPIT_STATUS_GROUPS as readonly string[]).includes(value)
}

function isFilterKind(value: string | null): value is ExecutionFilterKind {
  return value !== null && (EXECUTION_FILTER_KINDS as readonly string[]).includes(value)
}

function AgentRunsRoute() {
  const router = useRouter()
  const params = useSearchParams()
  const selectedId = params.get("run") ?? undefined
  const statusParam = params.get("status")
  const kindParam = params.get("kind")

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString())
      if (value) next.set(key, value)
      else next.delete(key)
      router.replace(`/agent-runs?${next.toString()}`)
    },
    [params, router]
  )

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col" data-bg-target="chat">
      <AgentRunsPanel
        selectedId={selectedId}
        onSelect={(id) => setParam("run", id)}
        statusGroup={isStatusGroup(statusParam) ? statusParam : "all"}
        onStatusGroup={(group) => setParam("status", group === "all" ? null : group)}
        filterKind={isFilterKind(kindParam) ? kindParam : "all"}
        onFilterKind={(kind) => setParam("kind", kind === "all" ? null : kind)}
      />
    </div>
  )
}

export default function AgentRunsPage() {
  return (
    <Suspense fallback={null}>
      <AgentRunsRoute />
    </Suspense>
  )
}
