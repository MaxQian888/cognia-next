"use client"

/**
 * Router adapter for the Inbox's URL-held view state
 * (`lib/inbox/inbox-url-state.ts`).
 *
 * Every write is a `router.replace` with `scroll: false`: grouping, filters and
 * the previewed row are view state, and pushing a history entry per click in
 * the list would turn Back into "un-click the last eleven rows". Opening the
 * full chat is a real navigation (`push`) made elsewhere, which is what makes
 * Back from the chat land on the same previewed row.
 *
 * Writes are built from the CURRENT query string, so the scoped routes'
 * `adapterId` / `kind` params survive every update.
 *
 * The effective grouping also consults the persisted layout store, so a route
 * without `?group=` keeps the user's last choice; choosing a grouping writes
 * both.
 */

import { useCallback, useMemo } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  buildInboxUrl,
  parseInboxUrlState,
  resolveInboxGrouping,
  serializeInboxUrlState,
  type InboxGrouping,
  type InboxListFilter,
  type InboxUrlPatch,
  type InboxUrlState,
} from "@/lib/inbox/inbox-url-state"
import { useInboxLayoutStore } from "@/stores/inbox/inbox-layout-store"

export interface InboxUrlStateApi {
  /** Exactly what the URL says. */
  state: InboxUrlState
  /** The grouping in force: URL, else stored choice, else the default. */
  grouping: InboxGrouping
  /** The session the triage pane previews, or `null`. */
  previewSessionId: string | null
  filters: readonly InboxListFilter[]
  setGrouping: (grouping: InboxGrouping) => void
  setPreview: (sessionId: string | null) => void
  setFilters: (filters: readonly InboxListFilter[]) => void
  toggleFilter: (filter: InboxListFilter) => void
  clearFilters: () => void
  /** Apply several changes in one navigation. */
  update: (patch: InboxUrlPatch) => void
}

export function useInboxUrlState(): InboxUrlStateApi {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const storedGrouping = useInboxLayoutStore((s) => s.grouping)
  const storeGrouping = useInboxLayoutStore((s) => s.setGrouping)

  const query = searchParams.toString()
  const state = useMemo(() => parseInboxUrlState(new URLSearchParams(query)), [query])

  const update = useCallback(
    (patch: InboxUrlPatch) => {
      // Built from the render-time query. Two writes in one tick would race
      // (the second rebuilds from the same stale query), so changes that land
      // together go through one `update` call with a combined patch.
      const next = serializeInboxUrlState(new URLSearchParams(query), patch)
      if (next === query) return
      router.replace(buildInboxUrl(pathname ?? "", next), { scroll: false })
    },
    [router, pathname, query]
  )

  const setGrouping = useCallback(
    (grouping: InboxGrouping) => {
      storeGrouping(grouping)
      update({ group: grouping })
    },
    [storeGrouping, update]
  )
  const setPreview = useCallback(
    (sessionId: string | null) => update({ preview: sessionId }),
    [update]
  )
  const setFilters = useCallback(
    (filters: readonly InboxListFilter[]) => update({ filters }),
    [update]
  )
  const toggleFilter = useCallback(
    (filter: InboxListFilter) =>
      update({
        filters: state.filters.includes(filter)
          ? state.filters.filter((f) => f !== filter)
          : [...state.filters, filter],
      }),
    [state.filters, update]
  )
  const clearFilters = useCallback(() => update({ filters: [] }), [update])

  return {
    state,
    grouping: resolveInboxGrouping(state, storedGrouping),
    previewSessionId: state.preview,
    filters: state.filters,
    setGrouping,
    setPreview,
    setFilters,
    toggleFilter,
    clearFilters,
    update,
  }
}
