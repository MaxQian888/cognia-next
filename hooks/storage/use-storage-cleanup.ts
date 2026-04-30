"use client"

// React surface for the cleanup helpers in `lib/storage/cleanup`. Wraps each
// helper with an `isRunning` flag so the dialog can disable buttons during
// long deletes.

import { useCallback, useState } from "react"
import {
  cleanupCategories,
  clearCategory,
  deepCleanup,
  previewCleanup,
  quickCleanup,
} from "@/lib/storage"
import type { CleanupOptions, CleanupResult, StorageCategory } from "@/lib/storage"

export interface UseStorageCleanupReturn {
  cleanup: (opts?: CleanupOptions) => Promise<CleanupResult>
  preview: (opts?: CleanupOptions) => Promise<CleanupResult>
  quick: () => Promise<CleanupResult>
  deep: () => Promise<CleanupResult>
  clearCategory: (category: StorageCategory) => Promise<number>
  isRunning: boolean
}

export function useStorageCleanup(): UseStorageCleanupReturn {
  const [isRunning, setIsRunning] = useState(false)

  const wrap = useCallback(async <T>(fn: () => Promise<T>): Promise<T> => {
    setIsRunning(true)
    try {
      return await fn()
    } finally {
      setIsRunning(false)
    }
  }, [])

  const cleanup = useCallback(
    (opts?: CleanupOptions) => wrap(() => cleanupCategories(opts)),
    [wrap]
  )
  const preview = useCallback((opts?: CleanupOptions) => wrap(() => previewCleanup(opts)), [wrap])
  const quick = useCallback(() => wrap(() => quickCleanup()), [wrap])
  const deep = useCallback(() => wrap(() => deepCleanup()), [wrap])
  const clearCategoryFn = useCallback(
    (category: StorageCategory) => wrap(() => clearCategory(category)),
    [wrap]
  )

  return {
    cleanup,
    preview,
    quick,
    deep,
    clearCategory: clearCategoryFn,
    isRunning,
  }
}
