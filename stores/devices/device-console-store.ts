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
  /** Mobile-only: the list rail is a Sheet below `md`. */
  listSheetOpen: boolean

  select: (ref: string | null) => void
  setSearch: (search: string) => void
  setKindFilter: (filter: DeviceKindFilter) => void
  setListSheetOpen: (open: boolean) => void
  reset: () => void
}

const INITIAL = {
  selectedRef: null,
  search: "",
  kindFilter: "all" as const,
  listSheetOpen: false,
}

export const useDeviceConsoleStore = create<DeviceConsoleState>((set) => ({
  ...INITIAL,

  /**
   * Picking a device closes the rail Sheet on mobile, where the rail covers
   * the very pane the choice was meant to reveal.
   *
   * No section state to reset: the detail pane is one scroll, and it returns
   * to the top on its own when the device changes.
   */
  select: (ref) => set({ selectedRef: ref, listSheetOpen: false }),
  setSearch: (search) => set({ search }),
  setKindFilter: (kindFilter) => set({ kindFilter }),
  setListSheetOpen: (listSheetOpen) => set({ listSheetOpen }),
  reset: () => set(INITIAL),
}))
