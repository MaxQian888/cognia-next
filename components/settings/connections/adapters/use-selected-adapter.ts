"use client"

/**
 * URL-param-backed adapter selection for the sidebar + detail layout
 * inside Settings → Connections → Adapters (im-refactored-crayon).
 *
 * Mirrors the `subTab` / `innerTab` URL-state pattern used by the
 * Subscription settings section. Clicking a card in the sidebar sets
 * `?adapter=<id>` so the selection survives reloads and deep links.
 */

import { useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"

const PARAM = "adapter"
const TAB_PARAM = "adapterTab"

export type AdapterDetailTab = "config" | "health" | "conversations" | "audit" | "outbound"

const ALL_TABS: AdapterDetailTab[] = ["config", "health", "conversations", "audit", "outbound"]

export interface UseSelectedAdapterResult {
  selectedAdapterId: string | null
  setSelectedAdapterId: (id: string | null) => void
  activeTab: AdapterDetailTab
  setActiveTab: (tab: AdapterDetailTab) => void
}

function isAdapterDetailTab(value: string | null): value is AdapterDetailTab {
  return !!value && (ALL_TABS as string[]).includes(value)
}

export function useSelectedAdapter(): UseSelectedAdapterResult {
  const router = useRouter()
  const searchParams = useSearchParams()
  const selectedAdapterId = searchParams.get(PARAM)
  const rawTab = searchParams.get(TAB_PARAM)
  const activeTab: AdapterDetailTab = isAdapterDetailTab(rawTab) ? rawTab : "config"

  const setSelectedAdapterId = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(searchParams.toString())
      if (id) next.set(PARAM, id)
      else {
        next.delete(PARAM)
        // Clearing the selection also drops the inner-tab param so a later
        // selection lands on the default tab. While switching *between*
        // adapters we keep the inner tab — every adapter exposes the same
        // five tabs (ALL_TABS), so there is no invalid-state risk and
        // preserving the operator's place reads more naturally.
        next.delete(TAB_PARAM)
      }
      const query = next.toString()
      router.replace(query ? `?${query}` : "?", { scroll: false })
    },
    [router, searchParams]
  )

  const setActiveTab = useCallback(
    (tab: AdapterDetailTab) => {
      const next = new URLSearchParams(searchParams.toString())
      next.set(TAB_PARAM, tab)
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  return { selectedAdapterId, setSelectedAdapterId, activeTab, setActiveTab }
}

const PLATFORM_PARAM = "platform"

export interface UsePendingPlatformResult {
  /**
   * Platform kind the URL asked us to land on, or null. Cleared as soon as the
   * tab has acted on it so a re-render (or a browser back) cannot reopen the
   * same dialog.
   */
  pendingPlatform: string | null
  clearPendingPlatform: () => void
}

/**
 * `?platform=<kind>` support for links that point at a PLATFORM rather than at
 * a configured instance, which is what "Open settings" on a Discover connector
 * card means: the user picked Telegram in the catalog, not one of their two
 * Telegram bots.
 *
 * Separate from `useSelectedAdapter` because it is a one-shot instruction
 * rather than a selection. `?adapter=` describes where you are and survives a
 * reload. `?platform=` describes what you just asked for, and is consumed on
 * arrival.
 */
export function usePendingPlatform(): UsePendingPlatformResult {
  const router = useRouter()
  const searchParams = useSearchParams()
  const pendingPlatform = searchParams.get(PLATFORM_PARAM)

  const clearPendingPlatform = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString())
    if (!next.has(PLATFORM_PARAM)) return
    next.delete(PLATFORM_PARAM)
    const query = next.toString()
    router.replace(query ? `?${query}` : "?", { scroll: false })
  }, [router, searchParams])

  return { pendingPlatform, clearPendingPlatform }
}

export const ADAPTER_DETAIL_TABS = ALL_TABS
