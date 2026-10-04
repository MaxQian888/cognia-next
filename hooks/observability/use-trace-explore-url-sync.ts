"use client"

/**
 * Two-way sync between the Explore sub-view's "where was I" state and the URL:
 *
 *   tspan   the span open in the detail pane   (observability store)
 *   tq      the trace-list search              (observability store)
 *   terr    errors-only                        (log workspace store, via props)
 *
 * Same contract as `useObservabilityUrlSync` for the view controls — a link
 * wins at mount and on any in-app navigation that changed these params, every
 * change is mirrored back with `history.replaceState`, and both directions
 * compare a fingerprint of only these three keys so foreign writes (the shell's
 * `traceId` / `tview`, the Logs panel's params, the controls sync's `trange`)
 * can neither loop nor clobber.
 *
 * Why errors-only arrives as props: the `/logs` shell owns it (it lives in the
 * log workspace store next to the sub-view and is reset with the workspace).
 * This hook never writes that store directly — a link's `terr` goes up through
 * `onErrorsOnlyChange`, exactly as a click on the toggle does.
 *
 * Search is written on a short trailing debounce: every keystroke rewriting the
 * address bar also re-renders every `useSearchParams` consumer on the page.
 *
 * A link that says nothing about a key leaves the current value standing (and
 * writes it back): the search and span live in memory across a visit to the
 * Logs channel, and returning should restore them, not wipe them.
 */

import { useEffect, useRef } from "react"
import { useSearchParams } from "next/navigation"
import { useObservabilityStore } from "@/stores/observability/observability-store"
import {
  TRACE_EXPLORE_PARAMS,
  decodeExploreState,
  encodeExploreState,
  ownedParamsSignature,
  replaceOwnedParams,
} from "@/lib/observability/url-state"

/** Trailing debounce for URL writes, ms. */
export const EXPLORE_URL_WRITE_DELAY_MS = 250

export interface UseTraceExploreUrlSyncOptions {
  errorsOnly: boolean
  onErrorsOnlyChange: (errorsOnly: boolean) => void
}

export function useTraceExploreUrlSync({
  errorsOnly,
  onErrorsOnlyChange,
}: UseTraceExploreUrlSyncOptions): void {
  const query = useObservabilityStore((s) => s.exploreQuery)
  const spanId = useObservabilityStore((s) => s.exploreSpanId)

  const searchParams = useSearchParams()
  const navigationKey = searchParams?.toString() ?? null

  const lastSignature = useRef<string | null>(null)
  // Latest props for the effects below without re-running them on identity
  // churn of the parent's callback.
  const latest = useRef({ errorsOnly, onErrorsOnlyChange })
  useEffect(() => {
    latest.current = { errorsOnly, onErrorsOnlyChange }
  })

  const writeUrl = useRef(() => {
    if (typeof window === "undefined") return
    const s = useObservabilityStore.getState()
    const next = replaceOwnedParams(
      window.location.search,
      TRACE_EXPLORE_PARAMS,
      encodeExploreState({
        spanId: s.exploreSpanId,
        query: s.exploreQuery,
        errorsOnly: latest.current.errorsOnly,
      })
    )
    lastSignature.current = ownedParamsSignature(next, TRACE_EXPLORE_PARAMS)
    if (next === window.location.search.replace(/^\?/, "")) return
    const url = next ? `${window.location.pathname}?${next}` : window.location.pathname
    window.history.replaceState(window.history.state, "", url)
  })

  // URL → state, on mount and on navigations that changed our params.
  useEffect(() => {
    if (typeof window === "undefined") return
    const search = window.location.search
    const signature = ownedParamsSignature(search, TRACE_EXPLORE_PARAMS)
    if (signature === lastSignature.current) return
    const decoded = decodeExploreState(search)
    const store = useObservabilityStore.getState()
    const first = lastSignature.current === null
    // On mount an absent key means "keep what you had" (see header); after
    // that, a navigation that removed a key meant to clear it.
    if (decoded.spanId !== null || !first) store.setExploreSpanId(decoded.spanId)
    if (decoded.query !== "" || !first) store.setExploreQuery(decoded.query)
    if (decoded.errorsOnly !== null && decoded.errorsOnly !== latest.current.errorsOnly) {
      latest.current = { ...latest.current, errorsOnly: decoded.errorsOnly }
      latest.current.onErrorsOnlyChange(decoded.errorsOnly)
    } else if (decoded.errorsOnly === null && !first && latest.current.errorsOnly) {
      latest.current = { ...latest.current, errorsOnly: false }
      latest.current.onErrorsOnlyChange(false)
    }
    writeUrl.current()
  }, [navigationKey])

  // state → URL (span / errors-only immediately, search debounced).
  useEffect(() => {
    if (lastSignature.current === null) return
    writeUrl.current()
  }, [spanId, errorsOnly])

  useEffect(() => {
    if (lastSignature.current === null) return
    const id = setTimeout(() => writeUrl.current(), EXPLORE_URL_WRITE_DELAY_MS)
    return () => clearTimeout(id)
  }, [query])
}
