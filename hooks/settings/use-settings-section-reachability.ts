"use client"

/**
 * Which settings sections this client can reach (ADR-0059 D7 / F5).
 *
 * Replaces the old `useDesktopAvailable() || !item.desktopOnly` cut with the
 * capability vocabulary: a section declares what it administers
 * (`NavItem.requires`) and, only for local-shell surfaces, which host profiles
 * it is bound to (`NavItem.profiles`); `isSettingsSectionReachable` answers for
 * the sidebar, the ⌘K finder and the shell's section dispatch alike.
 *
 * Capability availability already folds in the server-backed set of a
 * companion profile (`capabilityAvailable`), so a browser paired to a cloud
 * brain sees the sections whose backend runs on that brain, and a
 * web-standalone client sees only what runs in the webview.
 *
 * SSR / static-export snapshot: `useHostProfile()` resolves to
 * `"web-standalone"` on the server, so the prerendered HTML carries the
 * narrowest nav and React widens it as part of finishing hydration — the same
 * no-flash property `useDesktopAvailable` had.
 */

import { useMemo } from "react"

import {
  isSettingsSectionReachable,
  reachableSettingsSections,
  SETTINGS_NAV,
  settingsSectionBlockReason,
  type NavItem,
  type SettingsReachabilityContext,
  type SettingsSectionBlockReason,
  type SettingsSectionId,
} from "@/components/settings/settings-nav-config"
import { useCapabilityChecker, useHostProfile } from "@/hooks/use-host-profile"

export interface SettingsSectionReachability {
  /**
   * Why a section is out of reach, for surfaces that explain the refusal
   * rather than just hiding the entry. `null` for a reachable section and for
   * an id the nav does not carry (the merged `general` / `api-key` / `profile`
   * ids, which the shell redirects before dispatch).
   */
  blockReason: (id: SettingsSectionId) => SettingsSectionBlockReason | null
  /** The context the answers were computed from — handy for tests and logs. */
  context: SettingsReachabilityContext
  /** Whether a section id is reachable from this client. */
  isReachable: (id: SettingsSectionId) => boolean
  /** Reachable nav items, in nav order. */
  navItems: readonly NavItem[]
  /** Reachable section ids. */
  sections: ReadonlySet<SettingsSectionId>
}

export function useSettingsSectionReachability(): SettingsSectionReachability {
  const profile = useHostProfile()
  const hasCapability = useCapabilityChecker()
  return useMemo(() => {
    const context: SettingsReachabilityContext = { profile, hasCapability }
    const sections = reachableSettingsSections(context)
    const byId = new Map(SETTINGS_NAV.map((item) => [item.id, item] as const))
    return {
      blockReason: (id) => {
        const item = byId.get(id)
        return item ? settingsSectionBlockReason(item, context) : null
      },
      context,
      isReachable: (id) => sections.has(id),
      navItems: SETTINGS_NAV.filter((item) => isSettingsSectionReachable(item, context)),
      sections,
    }
  }, [profile, hasCapability])
}
