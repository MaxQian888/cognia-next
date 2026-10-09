"use client"

/**
 * The agents console's state, read from and written to the URL (ADR-0220).
 *
 * `/agents` is one static route, so the view is the query string:
 *   - `?id=&mode=`  an agent's detail: profile (`overview`), form (`edit`) or task board (`tasks`)
 *   - `?new=`       the create flow (`1` chooser, `blank`, `ai` builder setup)
 *   - `?builder=`   a builder conversation (a draft in progress)
 *   - `?q=&source=&sort=` the table's search, source tab and sort
 * The three view keys are mutually exclusive: every setter clears the others.
 */

import { useCallback, useMemo } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  isAgentCreateMode,
  isAgentDetailMode,
  type AgentCreateMode,
  type AgentDetailMode,
} from "@/lib/agents/routes"

export const AGENT_SOURCE_FILTERS = ["all", "user", "builtin", "plugin"] as const
export type AgentSourceFilter = (typeof AGENT_SOURCE_FILTERS)[number]

export const AGENT_SORTS = ["recent", "name", "updated"] as const
export type AgentSort = (typeof AGENT_SORTS)[number]

export type AgentsView =
  | { kind: "list" }
  | { kind: "detail"; id: string; mode: AgentDetailMode }
  | { kind: "create"; mode: AgentCreateMode }
  | { kind: "builder"; sessionId: string }

export interface AgentsRouteState {
  view: AgentsView
  query: string
  source: AgentSourceFilter
  sort: AgentSort
  openList: () => void
  openAgent: (id: string, mode?: AgentDetailMode) => void
  setMode: (mode: AgentDetailMode) => void
  openCreate: (mode: AgentCreateMode) => void
  openBuilder: (sessionId: string) => void
  setQuery: (value: string) => void
  setSource: (value: AgentSourceFilter) => void
  setSort: (value: AgentSort) => void
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

const VIEW_KEYS = { id: undefined, mode: undefined, new: undefined, builder: undefined }

export function useAgentsRouteState(): AgentsRouteState {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const setParams = useCallback(
    (patch: Record<string, string | undefined>, mode: "push" | "replace") => {
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value)
        else next.delete(key)
      }
      const query = next.toString()
      const href = query ? `${pathname}?${query}` : pathname
      // Moving between views is navigation the back button should undo;
      // typing in the search box is not.
      if (mode === "push") router.push(href, { scroll: false })
      else router.replace(href, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  const id = searchParams?.get("id") ?? undefined
  const builder = searchParams?.get("builder") ?? undefined
  const newParam = searchParams?.get("new") ?? null
  const modeParam = searchParams?.get("mode") ?? null
  const query = searchParams?.get("q") ?? ""
  const source = oneOf(searchParams?.get("source") ?? null, AGENT_SOURCE_FILTERS) ?? "all"
  const sort = oneOf(searchParams?.get("sort") ?? null, AGENT_SORTS) ?? "recent"

  const view: AgentsView = useMemo(() => {
    if (builder) return { kind: "builder", sessionId: builder }
    if (isAgentCreateMode(newParam)) return { kind: "create", mode: newParam }
    if (id)
      return { kind: "detail", id, mode: isAgentDetailMode(modeParam) ? modeParam : "overview" }
    return { kind: "list" }
  }, [builder, newParam, id, modeParam])

  return useMemo(
    () => ({
      view,
      query,
      source,
      sort,
      openList: () => setParams(VIEW_KEYS, "push"),
      openAgent: (agentId, mode) =>
        setParams(
          { ...VIEW_KEYS, id: agentId, mode: mode && mode !== "overview" ? mode : undefined },
          "push"
        ),
      // Editing is a step the back button should undo.
      setMode: (mode) => setParams({ mode: mode === "overview" ? undefined : mode }, "push"),
      openCreate: (mode) => setParams({ ...VIEW_KEYS, new: mode }, "push"),
      openBuilder: (sessionId) => setParams({ ...VIEW_KEYS, builder: sessionId }, "push"),
      setQuery: (value) => setParams({ q: value || undefined }, "replace"),
      setSource: (value) => setParams({ source: value === "all" ? undefined : value }, "replace"),
      setSort: (value) => setParams({ sort: value === "recent" ? undefined : value }, "replace"),
    }),
    [view, query, source, sort, setParams]
  )
}
