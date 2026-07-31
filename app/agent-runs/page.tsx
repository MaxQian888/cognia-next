"use client"

import { Suspense, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AgentRunsPanel } from "@/components/agent-runs/agent-runs-panel"
import type { AgentRunKind } from "@/types/agent-runs/agent-run"

/**
 * Unified Agent Runs console (Scheduler Phase D). Static-export-safe: the
 * selected run + kind filter live in `?run=` / `?kind=` query params (read via
 * `useSearchParams` inside a `<Suspense>` boundary), NOT a dynamic `[id]`
 * segment — those break in the production Tauri static export.
 */
function AgentRunsRoute() {
  const router = useRouter()
  const params = useSearchParams()
  const selectedId = params.get("run") ?? undefined
  const filterKind = (params.get("kind") as AgentRunKind | "all" | null) ?? "all"

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
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <AgentRunsPanel
        selectedId={selectedId}
        onSelect={(id) => setParam("run", id)}
        filterKind={filterKind}
        onFilterKind={(k) => setParam("kind", k === "all" ? null : k)}
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
