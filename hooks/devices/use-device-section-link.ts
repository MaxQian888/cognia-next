"use client"

/**
 * The `?deviceSection=` half of a console deep link.
 *
 * `?device=` picks the row and `useDeviceSelection` owns it. This picks the card
 * inside that row, once: the value is read, handed to `DeviceDetail`, and
 * stripped as soon as it has been applied, so a later scroll or a reload does
 * not keep yanking the pane back to the card the link named.
 */

import { useCallback } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { DEVICE_PARAM, DEVICE_SECTION_PARAM } from "@/lib/devices/device-console-href"

export interface DeviceSectionLink {
  /** The section id the link names, or `null` when there is none. */
  section: string | null
  /**
   * The device the same link names. The section belongs to that row, so it is
   * only handed over once that row is the one on screen, not to whatever the
   * console showed while the link was still resolving.
   */
  deviceRef: string | null
  /** Drop the parameter once the section has been scrolled to (or cannot be). */
  consume: () => void
}

export function useDeviceSectionLink(): DeviceSectionLink {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const section = searchParams.get(DEVICE_SECTION_PARAM)
  const deviceRef = searchParams.get(DEVICE_PARAM)

  const consume = useCallback(() => {
    if (!searchParams.has(DEVICE_SECTION_PARAM)) return
    const next = new URLSearchParams(searchParams.toString())
    next.delete(DEVICE_SECTION_PARAM)
    const query = next.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  return { section, deviceRef, consume }
}
