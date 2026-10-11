"use client"

import { useCallback, useState } from "react"

import { alwaysOnTarget } from "@/lib/remote-host/always-on-target"
import type { AlwaysOnItem } from "@/lib/remote-host/migration/candidates"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

export type NewItemPlace = "host" | "here"

export interface PlaceNewItem {
  /** The always-on host new work goes to, or null when there is none up. */
  target: RemoteHost | null
  /** What the create form shows as chosen; `host` unless the user changed it. */
  choice: NewItemPlace
  setChoice: (choice: NewItemPlace) => void
  /**
   * Call after the item was created here. With the host chosen it starts the
   * move (`PlaceNewItemDialog` shows it); otherwise it does nothing.
   */
  place: (item: AlwaysOnItem) => void
  /** The item being placed on the host right now, for the dialog. */
  placing: AlwaysOnItem | null
  done: () => void
}

/**
 * New always-on work defaults to the always-on host (ADR-0224 A5 step 7).
 *
 * A create form shows the choice and calls `place` once the item exists
 * here. The move is the same one the device page runs, so a machine-bound
 * item stays here and the dialog lists why, and the host may ask a person
 * to approve this device first.
 */
export function usePlaceNewItem(): PlaceNewItem {
  const target = useRemoteHostStore((state) => alwaysOnTarget(state.hosts))
  const [choice, setChoice] = useState<NewItemPlace>("host")
  const [placing, setPlacing] = useState<AlwaysOnItem | null>(null)

  const place = useCallback(
    (item: AlwaysOnItem) => {
      if (target && choice === "host") setPlacing(item)
    },
    [choice, target]
  )
  const done = useCallback(() => setPlacing(null), [])

  return { target, choice, setChoice, place, placing, done }
}
