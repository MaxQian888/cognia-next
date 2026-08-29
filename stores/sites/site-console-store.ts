/**
 * In-memory view state for the Sites console (`/sites`).
 *
 * Deliberately not persisted, for the reason `stores/devices/device-console-store.ts`
 * states: which Site you were last looking at is not a preference, and a console
 * that reopens pinned to a Site that has since been purged is worse than one
 * that reopens on the first row.
 *
 * It exists at all because the console used to keep both values in local
 * `useState`, which made `?site=` and `?tab=` impossible — and therefore made a
 * Site unlinkable from ⌘K, from a notification, and from anywhere else.
 */

import { create } from "zustand"

export const SITE_CONSOLE_TABS = [
  "publish",
  "versions",
  "environment",
  "domains",
  "access",
  "resources",
  "operations",
] as const

export type SiteConsoleTab = (typeof SITE_CONSOLE_TABS)[number]

/** Narrow an untrusted deep-link value; anything else is ignored, not reset. */
export function isSiteConsoleTab(value: string | null | undefined): value is SiteConsoleTab {
  return SITE_CONSOLE_TABS.includes(value as SiteConsoleTab)
}

interface SiteConsoleState {
  /** `SiteProjectRow.id`, or null to let the console auto-select the first. */
  selectedId: string | null
  tab: SiteConsoleTab
  select: (id: string | null) => void
  setTab: (tab: SiteConsoleTab) => void
  reset: () => void
}

const INITIAL = { selectedId: null, tab: "publish" as const }

export const useSiteConsoleStore = create<SiteConsoleState>((set) => ({
  ...INITIAL,

  /**
   * Changing Site returns to the publish flow. "Operations" for Site A is
   * meaningless for Site B, and landing on an empty journal reads as a broken
   * tab rather than a different Site.
   */
  select: (selectedId) => set({ selectedId, tab: "publish" }),
  setTab: (tab) => set({ tab }),
  reset: () => set(INITIAL),
}))
