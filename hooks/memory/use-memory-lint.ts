"use client"

/**
 * Memory health findings for the `/memory` Health tab.
 *
 * Lint reads stored vectors (for the suspected-contradiction check), which is
 * an async backend read rather than a Dexie live query, so this is a guarded
 * effect with an explicit refresh. It re-runs when the corpus actually changes
 * — keyed by row count and newest `updatedAt`, not by array identity, which the
 * live query replaces on every emission — and only while the tab is showing.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { runMemoryLint, type MemoryLintReport } from "@/lib/memory/lint/run-memory-lint"
import type { Memory } from "@/types/memory/memory"

export interface UseMemoryLintResult {
  report: MemoryLintReport | undefined
  loading: boolean
  refresh: () => void
}

function corpusSignature(memories: readonly Memory[]): string {
  let newest = 0
  for (const memory of memories) if (memory.updatedAt > newest) newest = memory.updatedAt
  return `${memories.length}:${newest}`
}

export function useMemoryLint(memories: readonly Memory[], active: boolean): UseMemoryLintResult {
  const [report, setReport] = useState<MemoryLintReport | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const signature = useMemo(() => corpusSignature(memories), [memories])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    // Deferred so the state change is not synchronous within the effect body.
    const timer = setTimeout(() => {
      setLoading(true)
      runMemoryLint({ memories })
        .then((next) => {
          if (!cancelled) setReport(next)
        })
        .catch(() => {
          if (!cancelled) setReport(undefined)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `memories` is represented by `signature`; re-running on identity alone
    // would re-lint on every live-query emission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, signature, nonce])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])
  return { report, loading, refresh }
}
