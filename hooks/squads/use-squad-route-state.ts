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

import { COCKPIT_STATUS_GROUPS, type CockpitStatusGroup } from "@/lib/execution/cockpit-model"

export const SQUAD_TABS = ["overview", "squads", "runs", "board"] as const
export type SquadFleetTab = (typeof SQUAD_TABS)[number]

/** The tabs a selected Squad's own view offers, in order. */
export const SQUAD_DETAIL_TABS = ["overview", "runs", "board"] as const
export type SquadDetailTab = (typeof SQUAD_DETAIL_TABS)[number]

/**
 * Which tab a surface actually shows for what the URL names.
 *
 * One function rather than a ternary per host, because the answer depends on
 * two things the URL alone cannot say: whether a Squad is selected, and
 * whether the surface is a phone.
 *
 *  - A selected Squad has its own view with Overview / Runs / Board, and lands
 *    on Overview: that is the Squad's home, the one place its controls,
 *    readiness, roster and latest result sit together.
 *  - With nothing selected, a wide pane has one thing to show, every Squad's
 *    runs, because the list is already on screen in the rail. A Board with no
 *    Squad would be a tab whose only content is "pick one".
 *  - With nothing selected, a phone has the list itself and every Squad's runs.
 *
 * A tab the current context does not offer resolves to that context's landing
 * tab instead of selecting a tab with no trigger and no content.
 */
export function resolveSquadTab(
  tab: SquadFleetTab | undefined,
  context: { selected: boolean; compact: boolean }
): SquadFleetTab {
  if (context.selected) {
    return tab && (SQUAD_DETAIL_TABS as readonly string[]).includes(tab) ? tab : "overview"
  }
  if (!context.compact) return "runs"
  return tab === "runs" ? "runs" : "squads"
}

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
  /**
   * `?status=`: the Runs tab's status bucket, from the same closed set as
   * `/agent-runs?status=`.
   *
   * In the URL rather than component state for the reason `tab` is: the Runs
   * tab lives inside `FeaturePageShell`, which renders the desktop and narrow
   * layouts through two different trees and REMOUNTS on the breakpoint. It is
   * here at all because the chips were rendered with no setter behind them —
   * clickable, counted, and inert.
   */
  runStatus: CockpitStatusGroup | "all"
  /**
   * `undefined` when the URL names none. Read it through {@link resolveSquadTab},
   * which knows what each surface lands on.
   */
  tab: SquadFleetTab | undefined
  query: string
  filter: SquadFilter
  /** Whether the list is narrowed at all, for a badge and for the empty copy. */
  narrowed: boolean
  /**
   * A real address for one run in this Squad's Runs tab, keeping everything
   * else on the URL. A link rather than a callback, so "Open run" and
   * "Review" can be opened in a new window or copied like any other link.
   */
  runHref: (runId: string) => string
  setSelectedId: (id: string | undefined) => void
  setRunId: (runId: string | undefined) => void
  setRunStatus: (group: CockpitStatusGroup | "all") => void
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

  const runHref = useCallback(
    (target: string) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      next.set("tab", "runs")
      next.set("run", target)
      return `${pathname}?${next.toString()}`
    },
    [pathname, searchParams]
  )

  const filter = oneOf(searchParams?.get("filter") ?? null, SQUAD_FILTERS) ?? "all"
  const query = searchParams?.get("q") ?? ""
  const runStatus =
    oneOf(searchParams?.get("status") ?? null, COCKPIT_STATUS_GROUPS) ?? ("all" as const)

  const selectedId = searchParams?.get("id") ?? undefined
  const tab = oneOf(searchParams?.get("tab") ?? null, SQUAD_TABS)
  const runId = searchParams?.get("run") ?? undefined

  return useMemo(
    () => ({
      selectedId,
      runId,
      runStatus,
      tab,
      query,
      filter,
      narrowed: filter !== "all" || query.trim().length > 0,
      runHref,
      // An open run belongs to the Squad it was opened under, so it never
      // survives a change of Squad. The tab does survive a move from one Squad
      // to another (reading two Squads' boards in turn is a real workflow), but
      // arriving from the list, or going back to it, starts from the landing
      // tab rather than from wherever the previous view was left.
      setSelectedId: (id) =>
        setParams({ id, run: undefined, tab: id && selectedId ? tab : undefined }),
      setRunId: (runId) => setParams({ run: runId }),
      setRunStatus: (group) => setParams({ status: group === "all" ? undefined : group }),
      // Always named. Which tab is the default depends on the surface and on
      // the selection (`resolveSquadTab`), so no one value is safe to elide:
      // dropping `runs` used to be right when Runs was every wide pane's
      // landing tab, and would now send a selected Squad back to Overview.
      setTab: (next) => setParams({ tab: next }),
      setQuery: (value) => setParams({ q: value || undefined }),
      setFilter: (value) => setParams({ filter: value === "all" ? undefined : value }),
      clearFilters: () => setParams({ q: undefined, filter: undefined }),
    }),
    [setParams, runHref, selectedId, runId, tab, query, filter, runStatus]
  )
}
