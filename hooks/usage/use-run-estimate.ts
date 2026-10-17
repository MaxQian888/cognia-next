"use client"

/**
 * Estimate for a long run about to be launched (ADR-0232).
 *
 * Reads the run history once through the cached loader and derives the
 * estimate during render, so changing the model or the agent in an open
 * dialog re-estimates without another read. Several queries are one launch
 * of parallel runs (best-of-N candidates on different agents) and are summed.
 *
 * Pass `null` to stay idle, e.g. while a dialog is closed.
 */

import { useEffect, useMemo, useState } from "react"

import {
  DORMANT_ESTIMATE_SURFACES,
  type RunEstimate,
  type RunEstimateQuery,
} from "@/lib/usage/run-estimate/estimate"
import { estimateLaunch } from "@/lib/usage/run-estimate/launch"
import {
  loadRunEstimateContext,
  type RunEstimateContext,
} from "@/lib/usage/run-estimate/load-samples"

export type RunEstimateStatus = "idle" | "loading" | "ready" | "error"

export interface UseRunEstimateResult {
  status: RunEstimateStatus
  estimate: RunEstimate | null
  /** Every query names a surface with no sample source yet (bots). */
  dormant: boolean
}

type Loaded = { context: RunEstimateContext; now: number } | { failed: true }

export function useRunEstimate(queries: readonly RunEstimateQuery[] | null): UseRunEstimateResult {
  const active = queries !== null && queries.length > 0
  const dormant = active && queries.every((q) => DORMANT_ESTIMATE_SURFACES.has(q.surface))
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!active || dormant) return
    let cancelled = false
    loadRunEstimateContext()
      .then((context) => {
        if (!cancelled) setLoaded({ context, now: Date.now() })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [active, dormant])

  const key = JSON.stringify(queries)
  const estimate = useMemo(() => {
    if (!loaded || "failed" in loaded || !queries) return null
    return estimateLaunch(queries, loaded.context, loaded.now)
    // `key` stands in for `queries`, which callers rebuild every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, key])

  if (!active) return { status: "idle", estimate: null, dormant: false }
  if (dormant) return { status: "ready", estimate: null, dormant: true }
  if (!loaded) return { status: "loading", estimate: null, dormant: false }
  if ("failed" in loaded) return { status: "error", estimate: null, dormant: false }
  return { status: "ready", estimate, dormant: false }
}
