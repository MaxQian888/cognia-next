"use client"

/**
 * The navigation's feature badges — catalog id → how many things are waiting
 * there. See `lib/shell/nav-badges.ts` for which live source badges which
 * destination.
 *
 * A single `useSyncExternalStore` read: the sources are sampled once per
 * window by `NavBadgeProbes`, so the rail, the hosted nav rows and the More
 * menu all re-render only when a destination's count actually changes.
 */

import { useSyncExternalStore } from "react"

import {
  getNavBadgeServerSnapshot,
  getNavBadgeSnapshot,
  subscribeNavBadges,
  type NavBadgeCounts,
} from "@/lib/shell/nav-badges"

export function useNavBadges(): NavBadgeCounts {
  return useSyncExternalStore(subscribeNavBadges, getNavBadgeSnapshot, getNavBadgeServerSnapshot)
}
