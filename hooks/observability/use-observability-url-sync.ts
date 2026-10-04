"use client"

/**
 * Two-way sync between the Traces channel's *view* controls (time range +
 * variable filters) and the page URL, so a link is shareable and reproduces
 * what the sender saw.
 *
 * - **URL → store.** A link's controls (`?trange=…&tf=…`, or the pre-rename
 *   `range` / `from` / `to` / `f` on a `channel=traces` link) take priority over
 *   persisted state: you followed a link, you want the link's view. This runs
 *   on mount AND whenever the owned params change underneath the channel — an
 *   in-app navigation (a notification's deep link, `router.push`, back/forward)
 *   that lands on `/logs` while Traces is already on screen used to be ignored,
 *   because the hydrate was a one-shot behind a ref.
 * - **store → URL.** Every control change is mirrored back via
 *   `history.replaceState` (no navigation, no history spam), INCLUDING the
 *   first: opening the channel with a persisted range now writes it, so the
 *   address bar always describes the window on screen and a copied link
 *   reproduces it. (The first write used to be skipped to keep a bare `/logs`
 *   clean — which made every "copy link" from a restored view a lie.)
 *
 * Loop-safety: both directions compare a fingerprint of ONLY the owned params
 * (`ownedParamsSignature`) against the one this hook last wrote or applied. Our
 * own `replaceState` shows up in `useSearchParams` as a change, but its
 * fingerprint is the one we just recorded, so it is a no-op; a write by the
 * shell (`channel`, `traceId`, `tview`) or the Logs panel leaves our
 * fingerprint untouched and is a no-op too. Only a genuinely different set of
 * Traces params re-hydrates.
 *
 * The store → URL effect reads `getState()` instead of its render-time closure.
 * On mount the hydrate effect runs first in the same commit and writes the
 * store synchronously; a closure-based write right after it would have pushed
 * the stale, pre-hydration values back over the link.
 *
 * Only the owned keys (and legacy keys a decode actually consumed) are
 * rewritten; everything else in the query survives untouched. Client-only and
 * static-export safe: pure `window.history`/`location`, no RSC navigation.
 */

import { useEffect, useRef } from "react"
import { useSearchParams } from "next/navigation"
import {
  OBSERVABILITY_URL_PARAMS,
  useObservabilityStore,
} from "@/stores/observability/observability-store"
import {
  TRACE_CONTROL_PARAMS,
  consumedLegacyKeys,
  decodeControls,
  encodeControls,
  ownedParamsSignature,
  replaceOwnedParams,
  type UrlControls,
} from "@/lib/observability/url-state"

/**
 * Every query param the Traces channel owns (view controls + Explore state).
 *
 * Defined on the store (and re-exported here) because this hook is only mounted
 * while the Traces channel is on screen, yet the channel's "Reset" lives in the
 * page header and is reachable from every channel. `resetView` clears them
 * itself — otherwise the store resets, nothing rewrites the query, and the next
 * visit to Traces re-hydrates the range and filters straight back out of the URL.
 */
export { OBSERVABILITY_URL_PARAMS }

function currentControls(): UrlControls {
  const s = useObservabilityStore.getState()
  return {
    rangePreset: s.rangePreset,
    customSince: s.customSince,
    customUntil: s.customUntil,
    filters: s.filters,
  }
}

function applyControls(decoded: UrlControls): void {
  const s = useObservabilityStore.getState()
  if (decoded.rangePreset === "custom") {
    if (decoded.customSince !== null && decoded.customUntil !== null) {
      s.setCustomRange(decoded.customSince, decoded.customUntil)
    }
  } else {
    s.setRangePreset(decoded.rangePreset)
  }
  s.setFilters(decoded.filters)
}

export function useObservabilityUrlSync(): void {
  // Subscribed so the store → URL effect re-runs on every control change; the
  // values themselves are re-read from `getState()` inside it (see header).
  const rangePreset = useObservabilityStore((s) => s.rangePreset)
  const customSince = useObservabilityStore((s) => s.customSince)
  const customUntil = useObservabilityStore((s) => s.customUntil)
  const filters = useObservabilityStore((s) => s.filters)

  // `null` outside an App Router tree (unit tests, Storybook); the effect
  // below falls back to `window.location`, which is the source of truth anyway.
  const searchParams = useSearchParams()
  const navigationKey = searchParams?.toString() ?? null

  /** Fingerprint of the owned params as this hook last wrote or applied them. */
  const lastSignature = useRef<string | null>(null)

  const writeUrl = useRef((legacy: readonly string[] = []) => {
    if (typeof window === "undefined") return
    const next = replaceOwnedParams(
      window.location.search,
      TRACE_CONTROL_PARAMS,
      encodeControls(currentControls()),
      legacy
    )
    const signature = ownedParamsSignature(next, TRACE_CONTROL_PARAMS)
    lastSignature.current = signature
    const current = window.location.search.replace(/^\?/, "")
    if (next === current) return
    const url = next ? `${window.location.pathname}?${next}` : window.location.pathname
    window.history.replaceState(window.history.state, "", url)
  })

  // URL → store, on mount and on any navigation that changed OUR params.
  useEffect(() => {
    if (typeof window === "undefined") return
    const search = window.location.search
    const legacy = consumedLegacyKeys(search)
    const signature = ownedParamsSignature(search, TRACE_CONTROL_PARAMS)
    if (legacy.length === 0 && signature === lastSignature.current) return
    const decoded = decodeControls(search)
    if (decoded) applyControls(decoded)
    // Re-write canonically either way: a legacy link is migrated to the new
    // keys, and a navigation that DROPPED our params gets the view on screen
    // written back rather than leaving the address bar describing nothing.
    writeUrl.current(legacy)
  }, [navigationKey])

  // store → URL on every control change.
  useEffect(() => {
    if (lastSignature.current === null) return // the hydrate effect owns the first write
    writeUrl.current()
  }, [rangePreset, customSince, customUntil, filters])
}
