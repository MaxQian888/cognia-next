"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { fetchRegistryItems } from "@/lib/skills/marketplace-registry"
import {
  fetchSkillsMpItems,
  isSkillsMpEnabled,
  type SkillsMpQuery,
} from "@/lib/skills/marketplace-skillsmp"
import {
  installMarketplaceItem,
  listInstalledCanonicalIds,
  uninstallMarketplaceItem,
} from "@/lib/skills/marketplace-install"
import { listSkills } from "@/lib/db/skills"
import type { MarketplaceItem, MarketplaceSourceId } from "@/lib/skills/marketplace-types"

export type MarketplaceSourceFilter = MarketplaceSourceId | "all"

interface State {
  loading: boolean
  items: MarketplaceItem[]
  error: string | null
}

export interface UseSkillMarketplace {
  source: MarketplaceSourceFilter
  setSource: (next: MarketplaceSourceFilter) => void
  query: string
  setQuery: (q: string) => void
  state: State
  installed: Set<string>
  install: (item: MarketplaceItem) => Promise<void>
  uninstall: (item: MarketplaceItem) => Promise<void>
  refresh: () => Promise<void>
  isSkillsMpEnabled: boolean
  installingId: string | null
}

export function useSkillMarketplace(): UseSkillMarketplace {
  const [source, setSource] = useState<MarketplaceSourceFilter>("all")
  const [query, setQuery] = useState<string>("")
  const [state, setState] = useState<State>({
    loading: true,
    items: [],
    error: null,
  })
  const [installingId, setInstallingId] = useState<string | null>(null)

  // Reactively re-derive the installed set from Dexie so install/uninstall
  // toggles update the cards instantly.
  const skills = useLiveQuery(() => listSkills(), [])
  const installed = useMemo(() => {
    const set = new Set<string>()
    for (const s of skills ?? []) {
      if (s.canonicalId) set.add(s.canonicalId)
    }
    return set
  }, [skills])

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const wantsRegistry = source === "all" || source === "registry"
      const wantsSkillsMp = source === "all" || source === "skillsmp"
      const skillsMpQuery: SkillsMpQuery = query ? { search: query } : {}
      const [registry, skillsMp] = await Promise.all([
        wantsRegistry
          ? fetchRegistryItems().catch((e) => {
              console.warn("registry load failed", e)
              return [] as MarketplaceItem[]
            })
          : Promise.resolve([] as MarketplaceItem[]),
        wantsSkillsMp && isSkillsMpEnabled()
          ? fetchSkillsMpItems(skillsMpQuery).catch((e) => {
              console.warn("skillsmp load failed", e)
              return [] as MarketplaceItem[]
            })
          : Promise.resolve([] as MarketplaceItem[]),
      ])
      let merged = [...registry, ...skillsMp]
      if (query.trim()) {
        const q = query.trim().toLowerCase()
        merged = merged.filter(
          (it) =>
            it.name.toLowerCase().includes(q) ||
            (it.description ?? "").toLowerCase().includes(q) ||
            (it.tags ?? []).some((t) => t.toLowerCase().includes(q))
        )
      }
      setState({ loading: false, items: merged, error: null })
    } catch (err) {
      setState({
        loading: false,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [source, query])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    void refresh()
  }, [refresh])

  // Initial primer for the installed set so the very first render's badges
  // are correct even before useLiveQuery resolves.
  useEffect(() => {
    listInstalledCanonicalIds().catch(() => undefined)
  }, [])

  const install = useCallback(async (item: MarketplaceItem) => {
    setInstallingId(item.id)
    try {
      await installMarketplaceItem(item)
    } finally {
      setInstallingId(null)
    }
  }, [])

  const uninstall = useCallback(async (item: MarketplaceItem) => {
    setInstallingId(item.id)
    try {
      await uninstallMarketplaceItem(item)
    } finally {
      setInstallingId(null)
    }
  }, [])

  return {
    source,
    setSource,
    query,
    setQuery,
    state,
    installed,
    install,
    uninstall,
    refresh,
    isSkillsMpEnabled: isSkillsMpEnabled(),
    installingId,
  }
}
