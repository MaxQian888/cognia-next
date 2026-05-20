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
      else next.delete(PARAM)
      // Reset the inner tab when switching adapters so we don't land on
      // an inner tab the new adapter doesn't render (e.g. Debug on a
      // non-Lark row).
      next.delete(TAB_PARAM)
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

export const ADAPTER_DETAIL_TABS = ALL_TABS
