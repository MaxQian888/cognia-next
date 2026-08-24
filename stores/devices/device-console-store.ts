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

/**
 * The detail tabs, in reading order: who it is, what it can do, what it is
 * allowed to do, what it can run, and what it has been doing.
 */
export type DeviceDetailTab = "overview" | "capabilities" | "access" | "runtime" | "activity"

export const DEVICE_DETAIL_TABS: readonly DeviceDetailTab[] = [
  "overview",
  "capabilities",
  "access",
  "runtime",
  "activity",
]

export type DeviceKindFilter = "all" | DeviceKind

interface DeviceConsoleState {
  /** `DeviceRow.ref` of the row shown in the detail pane; `null` = none yet. */
  selectedRef: string | null
  activeTab: DeviceDetailTab
  search: string
  kindFilter: DeviceKindFilter
  /** Mobile-only: the list rail is a Sheet below `md`. */
  listSheetOpen: boolean

  select: (ref: string | null) => void
  setActiveTab: (tab: DeviceDetailTab) => void
  setSearch: (search: string) => void
  setKindFilter: (filter: DeviceKindFilter) => void
  setListSheetOpen: (open: boolean) => void
  reset: () => void
}

const INITIAL = {
  selectedRef: null,
  activeTab: "overview" as const,
  search: "",
  kindFilter: "all" as const,
  listSheetOpen: false,
}

export const useDeviceConsoleStore = create<DeviceConsoleState>((set) => ({
  ...INITIAL,

  /**
   * Selecting a different device returns to Overview.
   *
   * Keeping the tab would land the user on, say, Runtime for a phone — a tab
   * whose entire content is "this kind of device hosts nothing" — and make the
   * console look broken at the moment it is being explored.
   */
  select: (ref) =>
    set((state) => ({
      selectedRef: ref,
      activeTab: ref === state.selectedRef ? state.activeTab : "overview",
      listSheetOpen: false,
    })),
  setActiveTab: (activeTab) => set({ activeTab }),
  setSearch: (search) => set({ search }),
  setKindFilter: (kindFilter) => set({ kindFilter }),
  setListSheetOpen: (listSheetOpen) => set({ listSheetOpen }),
  reset: () => set(INITIAL),
}))
