/**
 * In-memory view state for the device console (`/devices`).
 *
 * Deliberately not persisted. Which device you were last looking at is not a
 * preference — a console that reopens pinned to a phone that has since been
 * revoked is worse than one that reopens on this machine, which is always
 * present and always the safest thing to show first.
 *
 * Durable device facts live in Dexie (`lib/db/paired-devices.ts`), the host
 * SecurityStore, and the remote-host store; none of them belong here.
 */

import { create } from "zustand"

import type { DeviceKind } from "@/lib/devices/types"

export type DeviceKindFilter = "all" | DeviceKind

interface DeviceConsoleState {
  /** `DeviceRow.ref` of the row shown in the detail pane; `null` = none yet. */
  selectedRef: string | null
  search: string
  kindFilter: DeviceKindFilter

  select: (ref: string | null) => void
  setSearch: (search: string) => void
  setKindFilter: (filter: DeviceKindFilter) => void
}

export const useDeviceConsoleStore = create<DeviceConsoleState>((set) => ({
  selectedRef: null,
  search: "",
  kindFilter: "all",

  /**
   * No section state to reset: the detail pane is one scroll, and it returns
   * to the top on its own when the device changes.
   *
   * Nothing here owns whether a detail surface is open. `DevicesMobileBody`
   * keeps that in local state on purpose, because selection survives
   * navigation and deriving "open" from it would pop the drawer every time the
   * user came back to the page.
   */
  select: (ref) => set({ selectedRef: ref }),
  setSearch: (search) => set({ search }),
  setKindFilter: (kindFilter) => set({ kindFilter }),
}))
