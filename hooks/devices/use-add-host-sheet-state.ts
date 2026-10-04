"use client"

/**
 * Whether the device console's add-host sheet is open, and what it is seeded
 * with.
 *
 * `?addHost=1&baseUrl=…` is how `/servers` and the palette hand a host over.
 * Latched into state rather than read straight from the param, so closing the
 * sheet does not fight a URL that still says "open". The latch is adjusted
 * during render rather than in an effect: an effect would open the sheet one
 * paint late, and `react-hooks/set-state-in-effect` refuses it.
 *
 * Shared by the desktop console and the phone body, which each used to carry
 * an identical copy of this.
 */

import { useState } from "react"
import { useSearchParams } from "next/navigation"

export interface AddHostSheetState {
  open: boolean
  setOpen: (open: boolean) => void
  /** Seeds the payload field, from a `/servers` hand-off. */
  seededBaseUrl: string | undefined
}

export function useAddHostSheetState(): AddHostSheetState {
  const searchParams = useSearchParams()
  const addHostParam = searchParams.get("addHost")
  const seededBaseUrl = searchParams.get("baseUrl") ?? undefined
  const [open, setOpen] = useState(() => Boolean(addHostParam))
  const [seenParam, setSeenParam] = useState(addHostParam)
  if (addHostParam !== seenParam) {
    setSeenParam(addHostParam)
    // Only a *new* param opens the sheet. Clearing it must not slam a sheet
    // the user opened from the header shut.
    if (addHostParam) setOpen(true)
  }
  return { open, setOpen, seededBaseUrl }
}
