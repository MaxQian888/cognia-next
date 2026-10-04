"use client"

/**
 * Which device the console is showing, for both shells.
 *
 * Three sources decide it, in this order: a `?device=` deep link (what ⌘K,
 * Settings and a pasted URL hand over), the user's own click, and this machine
 * as the fallback that is always present.
 *
 * The desktop console and the phone body each used to implement this, and
 * neither did it fully:
 *
 *  * The desktop re-applied the deep link on **every** render where the link
 *    and the selection differed. With `?device=A` in the URL, clicking B
 *    selected B, the effect saw `A !== B` and selected A again, and the five
 *    second poll did the same to any selection that survived. The link is now
 *    applied once per value.
 *  * The phone never read `?device=` at all, so a ⌘K hit opened a list.
 *  * Neither wrote a selection back. A reload, or a link copied out of the
 *    address bar, lost which device was open. The selection is now mirrored
 *    into the URL with `replace`, so it survives a reload without adding a
 *    history entry per click.
 *  * A link naming a device that no longer exists (revoked, removed, from
 *    another account) quietly showed this machine instead, which reads as a
 *    broken link. It is now reported, once the rows have settled.
 *
 * The in-memory store still holds the selection; the URL is a mirror of it,
 * not a second owner. That is why the fallback to this machine does not
 * rewrite the URL: the link the user followed stays visible beside the notice
 * explaining it.
 */

import { useCallback, useEffect, useRef } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { DEVICE_PARAM } from "@/lib/devices/device-console-href"
import type { DeviceRow } from "@/lib/devices/types"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"

// Owned by the link builder so a link and its reader cannot disagree.
export { DEVICE_PARAM }

export interface UseDeviceSelectionOptions {
  rows: readonly DeviceRow[]
  /** True until the first host read settles; a link is not "missing" before then. */
  loading: boolean
  /** Called when a deep link selects a device, e.g. so the phone opens its drawer. */
  onDeepLink?: (ref: string) => void
}

export interface UseDeviceSelectionResult {
  selectedRef: string | null
  selected: DeviceRow | null
  /** A user's choice: selects and mirrors into the URL. */
  select: (ref: string) => void
  /** The `?device=` value that names no device in this fleet, once rows settled. */
  missingDeepLink: string | null
  /** Drops the stale link from the URL, which also clears the notice. */
  dismissMissingDeepLink: () => void
}

export function useDeviceSelection({
  rows,
  loading,
  onDeepLink,
}: UseDeviceSelectionOptions): UseDeviceSelectionResult {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const selectedRef = useDeviceConsoleStore((state) => state.selectedRef)
  const storeSelect = useDeviceConsoleStore((state) => state.select)

  const deepLinkRef = searchParams.get(DEVICE_PARAM)
  const selected = rows.find((row) => row.ref === selectedRef) ?? null
  const linkResolves = deepLinkRef !== null && rows.some((row) => row.ref === deepLinkRef)

  /**
   * The last link value that has been applied. A ref, not state: it changes
   * nothing on screen, it only stops the same link being applied twice.
   */
  const appliedLink = useRef<string | null>(null)
  const onDeepLinkRef = useRef(onDeepLink)
  useEffect(() => {
    onDeepLinkRef.current = onDeepLink
  }, [onDeepLink])

  const writeParam = useCallback(
    (ref: string | null) => {
      const next = new URLSearchParams(searchParams.toString())
      if (ref) next.set(DEVICE_PARAM, ref)
      else next.delete(DEVICE_PARAM)
      const query = next.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  const select = useCallback(
    (ref: string) => {
      storeSelect(ref)
      // Marked as applied before the URL catches up, so the render in between
      // (store says B, URL still says A) does not read as a new link to A.
      appliedLink.current = ref
      if (ref !== deepLinkRef) writeParam(ref)
    },
    [deepLinkRef, storeSelect, writeParam]
  )

  // Apply a link once it resolves. Rows for a `/pair` host or a worker arrive
  // after the first host read, so "not found yet" is waited out, not dropped.
  useEffect(() => {
    if (!deepLinkRef || !linkResolves || appliedLink.current === deepLinkRef) return
    appliedLink.current = deepLinkRef
    storeSelect(deepLinkRef)
    onDeepLinkRef.current?.(deepLinkRef)
  }, [deepLinkRef, linkResolves, storeSelect])

  // Fall back to this machine whenever the selection points at nothing: on
  // first open, and after a device is revoked and leaves the list. Held off
  // while a link is still loading, so it is not painted over by this machine
  // for one poll before it lands.
  const awaitingLink = deepLinkRef !== null && !linkResolves && loading
  useEffect(() => {
    if (rows.length === 0 || awaitingLink) return
    // Read live, not from this render: the link effect above runs in the same
    // flush and may have just selected the linked device, which `selected`
    // (computed before either effect) cannot know yet.
    const current = useDeviceConsoleStore.getState().selectedRef
    if (rows.some((row) => row.ref === current)) return
    const local = rows.find((row) => row.isSelf)
    if (local) storeSelect(local.ref)
  }, [awaitingLink, rows, selected, storeSelect])

  const missingDeepLink =
    deepLinkRef !== null && !loading && rows.length > 0 && !linkResolves ? deepLinkRef : null

  const dismissMissingDeepLink = useCallback(() => writeParam(null), [writeParam])

  return { selectedRef, selected, select, missingDeepLink, dismissMissingDeepLink }
}
