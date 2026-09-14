"use client"

/**
 * The scheduler page's selection, read from and written to the address
 * (ADR-0179 §2). `?item=` names the item the detail pane shows, `?run=` the
 * run the sheet shows. Both routes (`/scheduler`, `/me/scheduler`) use this
 * hook, so a link to one works on the other after its redirect.
 *
 * Legacy spellings (`?taskId=`, `?task=`, `?systemTaskId=`) are resolved
 * against the loaded items and rewritten out of the address once; until the
 * items arrive they stay pending, so a deep link into a page that has not
 * finished loading still lands.
 *
 * `useSearchParams` needs a Suspense boundary under the static export; the
 * page provides it.
 */

import { useCallback, useEffect, useMemo } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import {
  hasLegacySchedulerParams,
  parseSchedulerQuery,
  resolveLegacySelection,
  schedulerHref,
  writeSchedulerQuery,
  type SchedulerQuery,
} from "@/lib/scheduler/page-query"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

export interface SchedulerSelection {
  /** `unifiedId` of the selected item, or `null`. */
  itemId: string | null
  /** `unifiedId` of the open run, or `null`. */
  runId: string | null
  /** A legacy id the address carries that the loaded items did not resolve. */
  unresolvedLegacy: boolean
  selectItem: (unifiedId: string | null) => void
  openRun: (unifiedId: string | null) => void
  /** Clear both. */
  clear: () => void
}

export function useSchedulerSelection(
  items: readonly UnifiedScheduledItem[],
  /** Whether the item list has finished its first load. */
  itemsReady: boolean
): SchedulerSelection {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const query = useMemo<SchedulerQuery>(() => parseSchedulerQuery(params), [params])
  const legacyPresent = useMemo(() => hasLegacySchedulerParams(params), [params])
  const legacyResolved = useMemo(
    () => (legacyPresent ? resolveLegacySelection(query, items) : undefined),
    [legacyPresent, query, items]
  )

  const navigate = useCallback(
    (patch: Parameters<typeof writeSchedulerQuery>[1]) => {
      router.replace(schedulerHref(pathname, writeSchedulerQuery(params, patch)))
    },
    [router, pathname, params]
  )

  // Rewrite the legacy spelling once the items can answer it, or once they
  // have loaded and cannot: a broken link must look broken, not linger as a
  // parameter the page keeps re-reading.
  useEffect(() => {
    if (!legacyPresent) return
    if (legacyResolved) navigate({ item: legacyResolved })
    else if (itemsReady) navigate({ item: null })
  }, [legacyPresent, legacyResolved, itemsReady, navigate])

  const selectItem = useCallback(
    (unifiedId: string | null) => navigate({ item: unifiedId, run: null }),
    [navigate]
  )
  const openRun = useCallback(
    (unifiedId: string | null) => navigate({ run: unifiedId }),
    [navigate]
  )
  const clear = useCallback(() => navigate({ item: null, run: null }), [navigate])

  return {
    itemId: query.item ?? legacyResolved ?? null,
    runId: query.run ?? null,
    unresolvedLegacy: legacyPresent && !legacyResolved && itemsReady,
    selectItem,
    openRun,
    clear,
  }
}
