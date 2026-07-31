"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { resolveSkillPanelPrefs, useSettingsStore } from "@/stores/settings"
import { fetchRegistryItems } from "@/lib/skills/marketplace-registry"
import {
  SkillsShTokenError,
  fetchSkillsShAudit,
  fetchSkillsShCurated,
  fetchSkillsShDetail,
  fetchSkillsShItems,
  fetchSkillsShLeaderboard,
  type SkillsShAudit,
  type SkillsShCuratedOwner,
  type SkillsShLeaderboardView,
} from "@/lib/skills/marketplace-skillssh"
import { isSkillsShWebBlocked } from "@/lib/skills/skillssh-http"
import { buildSkillsShFileTree, type SkillsShFileTreeNode } from "@/lib/skills/skillssh-install"
import {
  installMarketplaceItem,
  listInstalledCanonicalIds,
  uninstallMarketplaceItem,
} from "@/lib/skills/marketplace-install"
import { listSkills } from "@/lib/db/skills"
import type { MarketplaceItem, MarketplaceSourceId } from "@/lib/skills/marketplace-types"

export type MarketplaceSourceFilter = MarketplaceSourceId | "all"

/** Browse views: free search (default) plus the token-gated leaderboards. */
export type MarketplaceView = "search" | SkillsShLeaderboardView | "curated"

interface State {
  loading: boolean
  items: MarketplaceItem[]
  error: string | null
  /** Whether the current leaderboard view has more pages. */
  hasMore: boolean
  loadingMore: boolean
  /** Set when a token-gated view was rejected (expired/invalid token). */
  tokenError: boolean
}

export type AuditEntry = SkillsShAudit | null | "loading"
export type FileTreeEntry = SkillsShFileTreeNode[] | "loading"

export interface UseSkillMarketplace {
  source: MarketplaceSourceFilter
  setSource: (next: MarketplaceSourceFilter) => void
  query: string
  setQuery: (q: string) => void
  view: MarketplaceView
  setView: (v: MarketplaceView) => void
  /** True when a skills.sh token is configured (unlocks leaderboards). */
  hasToken: boolean
  /** True when this runtime cannot reach skills.sh at all (web CORS). */
  webBlocked: boolean
  state: State
  /** Curated owners for the curated view (items also flattened into state.items). */
  curated: SkillsShCuratedOwner[]
  installed: Set<string>
  install: (item: MarketplaceItem) => Promise<void>
  uninstall: (item: MarketplaceItem) => Promise<void>
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  installingId: string | null
  /** Lazily-fetched security audits, keyed by item id. */
  audit: (itemId: string) => AuditEntry | undefined
  fetchAudit: (item: MarketplaceItem) => void
  /** Lazily-fetched file manifests, keyed by item id. */
  fileTree: (itemId: string) => FileTreeEntry | undefined
  fetchFileTree: (item: MarketplaceItem) => void
}

const LEADERBOARD_PAGE_SIZE = 50

export function useSkillMarketplace(): UseSkillMarketplace {
  const [source, setSource] = useState<MarketplaceSourceFilter>("all")
  const [query, setQuery] = useState<string>("")
  const [view, setView] = useState<MarketplaceView>("search")
  const [page, setPage] = useState(0)
  const [curated, setCurated] = useState<SkillsShCuratedOwner[]>([])
  const [state, setState] = useState<State>({
    loading: true,
    items: [],
    error: null,
    hasMore: false,
    loadingMore: false,
    tokenError: false,
  })
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [audits, setAudits] = useState<Record<string, AuditEntry>>({})
  const [fileTrees, setFileTrees] = useState<Record<string, FileTreeEntry>>({})

  const hasToken = useSettingsStore((s) => Boolean(s.settings?.skillsShToken?.trim()))
  const webBlocked = useMemo(() => isSkillsShWebBlocked(), [])

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
    setState((s) => ({ ...s, loading: true, error: null, tokenError: false }))
    setPage(0)
    try {
      if (view !== "search") {
        // Token-gated leaderboard / curated views — skills.sh only.
        try {
          if (view === "curated") {
            const owners = await fetchSkillsShCurated()
            setCurated(owners)
            setState({
              loading: false,
              items: owners.flatMap((o) => o.items),
              error: null,
              hasMore: false,
              loadingMore: false,
              tokenError: false,
            })
          } else {
            const pageData = await fetchSkillsShLeaderboard(view, 0, LEADERBOARD_PAGE_SIZE)
            setCurated([])
            setState({
              loading: false,
              items: pageData.items,
              error: null,
              hasMore: pageData.hasMore,
              loadingMore: false,
              tokenError: false,
            })
          }
        } catch (err) {
          if (err instanceof SkillsShTokenError) {
            setState({
              loading: false,
              items: [],
              error: err.message,
              hasMore: false,
              loadingMore: false,
              tokenError: true,
            })
            return
          }
          throw err
        }
        return
      }

      // Search view: curated registry + anonymous skills.sh search, merged.
      const wantsRegistry = source === "all" || source === "registry"
      const wantsSkillsSh = (source === "all" || source === "skillssh") && !webBlocked
      const [registry, skillsSh] = await Promise.all([
        wantsRegistry
          ? fetchRegistryItems().catch((e: unknown) => {
              console.warn("registry load failed", e)
              return [] as MarketplaceItem[]
            })
          : Promise.resolve([] as MarketplaceItem[]),
        wantsSkillsSh
          ? fetchSkillsShItems({ search: query }).catch((e: unknown) => {
              console.warn("skills.sh search failed", e)
              return [] as MarketplaceItem[]
            })
          : Promise.resolve([] as MarketplaceItem[]),
      ])
      let merged = [...registry, ...skillsSh]
      if (query.trim()) {
        const q = query.trim().toLowerCase()
        merged = merged.filter(
          (it) =>
            it.name.toLowerCase().includes(q) ||
            (it.description ?? "").toLowerCase().includes(q) ||
            (it.tags ?? []).some((t) => t.toLowerCase().includes(q)) ||
            (it.repository ?? "").toLowerCase().includes(q)
        )
      }
      setCurated([])
      setState({
        loading: false,
        items: merged,
        error: null,
        hasMore: false,
        loadingMore: false,
        tokenError: false,
      })
    } catch (err) {
      setState({
        loading: false,
        items: [],
        error: err instanceof Error ? err.message : String(err),
        hasMore: false,
        loadingMore: false,
        tokenError: false,
      })
    }
  }, [source, query, view, webBlocked])

  const loadMore = useCallback(async () => {
    if (view === "search" || view === "curated") return
    const nextPage = page + 1
    setState((s) => ({ ...s, loadingMore: true }))
    try {
      const pageData = await fetchSkillsShLeaderboard(view, nextPage, LEADERBOARD_PAGE_SIZE)
      setPage(nextPage)
      setState((s) => {
        const seen = new Set(s.items.map((i) => i.id))
        return {
          ...s,
          items: [...s.items, ...pageData.items.filter((i) => !seen.has(i.id))],
          hasMore: pageData.hasMore,
          loadingMore: false,
        }
      })
    } catch (err) {
      setState((s) => ({
        ...s,
        loadingMore: false,
        error: err instanceof Error ? err.message : String(err),
        tokenError: err instanceof SkillsShTokenError,
      }))
    }
  }, [view, page])

  useEffect(() => {
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
      const autoEnableNew = resolveSkillPanelPrefs(
        useSettingsStore.getState().settings?.skillPanelPrefs
      ).autoEnableNew
      await installMarketplaceItem(item, { disabledByDefault: !autoEnableNew })
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

  const fetchAudit = useCallback(
    (item: MarketplaceItem) => {
      if (item.source !== "skillssh" || webBlocked) return
      if (audits[item.id] !== undefined) return
      setAudits((a) => ({ ...a, [item.id]: "loading" }))
      fetchSkillsShAudit(item)
        .then((audit) => setAudits((a) => ({ ...a, [item.id]: audit })))
        .catch(() => setAudits((a) => ({ ...a, [item.id]: null })))
    },
    [audits, webBlocked]
  )

  const fetchFileTree = useCallback(
    (item: MarketplaceItem) => {
      if (item.source !== "skillssh" || webBlocked) return
      if (fileTrees[item.id] !== undefined) return
      setFileTrees((f) => ({ ...f, [item.id]: "loading" }))
      fetchSkillsShDetail(item)
        .then((detail) =>
          setFileTrees((f) => ({ ...f, [item.id]: buildSkillsShFileTree(detail.files) }))
        )
        .catch(() => setFileTrees((f) => ({ ...f, [item.id]: [] })))
    },
    [fileTrees, webBlocked]
  )

  return {
    source,
    setSource,
    query,
    setQuery,
    view,
    setView,
    hasToken,
    webBlocked,
    state,
    curated,
    installed,
    install,
    uninstall,
    refresh,
    loadMore,
    installingId,
    audit: (itemId) => audits[itemId],
    fetchAudit,
    fileTree: (itemId) => fileTrees[itemId],
    fetchFileTree,
  }
}
