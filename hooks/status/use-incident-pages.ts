"use client"

/**
 * Past incidents beyond the ones the snapshot carries.
 *
 * The snapshot ships the most recent resolved incidents; "Load more" walks
 * `GET /incidents?cursor=&limit=` from the newest page down. Pages overlap
 * the snapshot's list, so the merged list is de-duplicated by ID (the higher
 * revision wins), excludes incidents that are currently active, and stays
 * sorted newest first.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  parseIncidentPage,
  statusApiUrl,
  type IncidentSummary,
  type StatusRuntime,
} from "@/lib/status/public-status"

import {
  isAbortError,
  statusGet,
  StatusRequestError,
  type StatusRequestErrorKind,
} from "./status-transport"

export const INCIDENT_PAGE_SIZE = 20

export function mergeIncidentLists(
  lists: ReadonlyArray<readonly IncidentSummary[]>,
  excludeIds: ReadonlySet<string>
): IncidentSummary[] {
  const byId = new Map<string, IncidentSummary>()
  for (const list of lists) {
    for (const incident of list) {
      if (excludeIds.has(incident.id)) continue
      const existing = byId.get(incident.id)
      if (!existing || incident.revision > existing.revision) byId.set(incident.id, incident)
    }
  }
  return [...byId.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
}

export interface IncidentPagesState {
  incidents: IncidentSummary[]
  /** False once the API has reported there is no older page. */
  hasMore: boolean
  loading: boolean
  error: StatusRequestErrorKind | null
  loadMore: () => void
}

export function useIncidentPages(
  runtime: StatusRuntime | null,
  base: { past: readonly IncidentSummary[]; active: readonly IncidentSummary[] }
): IncidentPagesState {
  const [pages, setPages] = useState<IncidentSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [exhausted, setExhausted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<StatusRequestErrorKind | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  const apiBase = runtime?.apiBase ?? null

  const loadMore = useCallback(() => {
    if (apiBase === null || controllerRef.current || exhausted) return
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError(null)
    const query = new URLSearchParams({ limit: String(INCIDENT_PAGE_SIZE) })
    if (cursor) query.set("cursor", cursor)
    statusGet(statusApiUrl(apiBase, `/incidents?${query.toString()}`), parseIncidentPage, {
      signal: controller.signal,
    }).then(
      ({ value }) => {
        if (controller.signal.aborted) return
        setPages((previous) => [...previous, ...value.incidents])
        setCursor(value.nextCursor)
        setExhausted(value.nextCursor === null)
        setLoading(false)
        controllerRef.current = null
      },
      (caught: unknown) => {
        if (controller.signal.aborted || isAbortError(caught)) return
        setError(caught instanceof StatusRequestError ? caught.kind : "network")
        setLoading(false)
        controllerRef.current = null
      }
    )
  }, [apiBase, cursor, exhausted])

  const incidents = useMemo(
    () => mergeIncidentLists([base.past, pages], new Set(base.active.map((item) => item.id))),
    [base.past, base.active, pages]
  )

  return { incidents, hasMore: !exhausted, loading, error, loadMore }
}
