"use client"

/**
 * One data source for the mobile `/me/storage` page.
 *
 * The page used to run three independent fetches behind two "Refresh"
 * buttons: `navigator.storage.estimate()` + backup history in one card, and
 * `StorageManager` stats + health in another. This hook composes the two
 * existing readers (`useStorageBreakdown` and `getStorageUsage` /
 * `isStoragePersisted`) behind one `refresh()` and one `refreshing` flag, so
 * the hero bar, the category rows and the persistence chip all move together.
 *
 * Nothing is re-implemented here: the Dexie walk stays in
 * `useStorageBreakdown`, the origin estimate in `lib/storage/usage.ts`, the
 * persistence probe in `lib/storage/persistence-request.ts`.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { useStorageBreakdown } from "@/hooks/storage/use-storage-breakdown"
import { useStorageCleanup } from "@/hooks/storage/use-storage-cleanup"
import type { StorageCategory, StorageHealth, StorageStats } from "@/lib/storage"
import {
  isStoragePersisted,
  requestPersistentStorage,
  type PersistenceStatus,
} from "@/lib/storage/persistence-request"
import { getStorageUsage, type StorageUsage } from "@/lib/storage/usage"

export interface UseStorageOverviewOptions {
  /** Override the origin-estimate + backup reader (tests, stories). */
  fetcher?: () => Promise<StorageUsage>
  /** Override the persisted-state probe (tests, stories). */
  persistedChecker?: () => Promise<boolean>
  /** Override the persistence request (tests, stories). */
  requester?: () => Promise<PersistenceStatus>
}

export interface StorageOverview {
  /** Origin estimate + backup history. `null` until the first read lands. */
  usage: StorageUsage | null
  stats: StorageStats | null
  health: StorageHealth | null
  /** `null` until probed; the probe itself never throws. */
  persisted: boolean | null
  /** True only while the very first read is in flight (skeleton state). */
  isLoading: boolean
  /** True while a manual `refresh()` is in flight (previous data stays up). */
  refreshing: boolean
  /** True while a cleanup / clear / persistence request is running. */
  isBusy: boolean
  refresh: () => Promise<void>
  requestPersistence: () => Promise<PersistenceStatus>
  clearCategory: (category: StorageCategory) => Promise<number>
  formatBytes: (bytes: number) => string
}

export function useStorageOverview(options: UseStorageOverviewOptions = {}): StorageOverview {
  const { fetcher, persistedChecker, requester } = options
  const breakdown = useStorageBreakdown()
  const cleanup = useStorageCleanup()
  const refreshBreakdown = breakdown.refresh
  const clearCategoryRaw = cleanup.clearCategory

  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [usageLoading, setUsageLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const mounted = useRef(true)

  // The injected readers are read through refs so an inline arrow from a
  // story or a test does not re-key the mount effect on every render (which
  // re-read usage after each setState and undid a granted persistence).
  const seams = useRef({ fetcher, persistedChecker, requester })
  useEffect(() => {
    seams.current = { fetcher, persistedChecker, requester }
  }, [fetcher, persistedChecker, requester])

  const readUsage = useCallback(async () => {
    const [nextUsage, nextPersisted] = await Promise.all([
      (seams.current.fetcher ?? getStorageUsage)(),
      (seams.current.persistedChecker ?? isStoragePersisted)(),
    ])
    return { nextUsage, nextPersisted }
  }, [])

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    readUsage()
      .then(({ nextUsage, nextPersisted }) => {
        if (cancelled) return
        setUsage(nextUsage)
        setPersisted(nextPersisted)
        setUsageLoading(false)
      })
      .catch(() => {
        // `getStorageUsage` / `isStoragePersisted` swallow their own
        // failures; a rejection here is an injected fetcher in tests.
        if (cancelled) return
        setUsageLoading(false)
      })
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [readUsage])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const [{ nextUsage, nextPersisted }] = await Promise.all([readUsage(), refreshBreakdown()])
      if (!mounted.current) return
      setUsage(nextUsage)
      setPersisted(nextPersisted)
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }, [readUsage, refreshBreakdown])

  const requestPersistence = useCallback(async () => {
    setRequesting(true)
    try {
      const status = await (seams.current.requester ?? requestPersistentStorage)()
      if (mounted.current && status === "persisted") setPersisted(true)
      return status
    } finally {
      if (mounted.current) setRequesting(false)
    }
  }, [])

  const clearCategory = useCallback(
    async (category: StorageCategory) => {
      const cleared = await clearCategoryRaw(category)
      await refresh()
      return cleared
    },
    [clearCategoryRaw, refresh]
  )

  return {
    usage,
    stats: breakdown.stats,
    health: breakdown.health,
    persisted,
    isLoading: usageLoading || (breakdown.isLoading && !breakdown.stats),
    refreshing,
    isBusy: refreshing || requesting || cleanup.isRunning,
    refresh,
    requestPersistence,
    clearCategory,
    formatBytes: breakdown.formatBytes,
  }
}
