"use client"

/**
 * URL-driven state for `/squads` (`?id=&tab=&q=&filter=`).
 *
 * The console read `?id=` and `?tab=` through thirty lines of `replaceParam`
 * inlined in the page, and had no notion of narrowing at all. A phone body was
 * about to need the same four answers, and the way that goes wrong is already
 * on record next door: `/templates` kept its filters in component state on the
 * desktop and read nothing from the URL on the phone, so a link that opened one
 * template on a laptop opened the whole catalog on a phone. Centralising here is
 * what `useTemplateRouteState` does, for that reason.
 *
 * `tab` is in the URL for a second reason `id` does not have.
 * `FeaturePageShell` renders its children through two different trees, a
 * resizable pane set and a narrow single column, and moving between them
 * REMOUNTS the subtree. Anything held in `useState` there silently snaps back
 * the first time the breakpoint resolves.
 *
 * Static export note: any component calling this must sit inside `<Suspense>`,
 * because `useSearchParams()` opts out of static rendering.
 */

import { useCallback, useMemo } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

export const SQUAD_TABS = ["squads", "runs", "board"] as const
export type SquadFleetTab = (typeof SQUAD_TABS)[number]

/**
 * The one facet a Squad list actually holds.
 *
 * `waiting` and `live` are the two questions a fleet view is opened to answer,
 * and they are derived from state that already exists (`PendingGate.teamId` and
 * the Squad's own status). A facet for anything else would be a control that
 * can only ever empty the list.
 */
export const SQUAD_FILTERS = ["all", "waiting", "live"] as const
export type SquadFilter = (typeof SQUAD_FILTERS)[number]

export interface SquadRouteState {
  selectedId: string | undefined
  /** `?run=`: the execution run open in the Runs tab. Same id space as `/agent-runs?run=`. */
  runId: string | undefined
  /** `undefined` when the URL names none, so each surface can pick its own landing tab. */
  tab: SquadFleetTab | undefined
  query: string
  filter: SquadFilter
  /** Whether the list is narrowed at all, for a badge and for the empty copy. */
  narrowed: boolean
  setSelectedId: (id: string | undefined) => void
  setRunId: (runId: string | undefined) => void
  setTab: (tab: SquadFleetTab) => void
  setQuery: (value: string) => void
  setFilter: (value: SquadFilter) => void
  clearFilters: () => void
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

export function useSquadRouteState(): SquadRouteState {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const setParams = useCallback(
    (patch: Record<string, string | undefined>) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value)
        else next.delete(key)
      }
      const query = next.toString()
      // `replace`, not `push`: typing in the search box would otherwise put one
      // history entry per keystroke between the user and the page they came
      // from. `scroll: false` keeps a filter change from jumping the list.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  const filter = oneOf(searchParams?.get("filter") ?? null, SQUAD_FILTERS) ?? "all"
  const query = searchParams?.get("q") ?? ""

  return useMemo(
    () => ({
      selectedId: searchParams?.get("id") ?? undefined,
      runId: searchParams?.get("run") ?? undefined,
      tab: oneOf(searchParams?.get("tab") ?? null, SQUAD_TABS),
      query,
      filter,
      narrowed: filter !== "all" || query.trim().length > 0,
      setSelectedId: (id) => setParams({ id }),
      setRunId: (runId) => setParams({ run: runId }),
      // `runs` is the wide-pane default, so naming it in the URL would be
      // noise. Every other tab is worth linking to.
      setTab: (tab) => setParams({ tab: tab === "runs" ? undefined : tab }),
      setQuery: (value) => setParams({ q: value || undefined }),
      setFilter: (value) => setParams({ filter: value === "all" ? undefined : value }),
      clearFilters: () => setParams({ q: undefined, filter: undefined }),
    }),
    [searchParams, setParams, query, filter]
  )
}
