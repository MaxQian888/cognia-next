"use client"

/**
 * On-demand detail for the one pinned row.
 *
 * At most one row is pinned at a time, and its detail is dropped the moment the
 * pin moves, the island collapses, or the row leaves the projection. Nothing is
 * cached and nothing is persisted, so a detail the user revealed once does not
 * quietly survive into the next hover.
 */

import { useEffect, useRef, useState } from "react"

import { onIslandDetailResponse, requestIslandDetail } from "@/lib/island/client"
import type { IslandRowDetail } from "@/lib/island/types"

export interface IslandDetailSlot {
  rowId: string | null
  detail: IslandRowDetail | null
  /** `fleet.island.detailError.*` key when the request was refused. */
  error: string | null
}

const EMPTY_SLOT: IslandDetailSlot = { rowId: null, detail: null, error: null }

let counter = 0

/**
 * @param rowId   The pinned row, or null.
 * @param revision The projection revision to echo. Read at request time, NOT
 *   a re-request trigger: the main window bumps it on every fleet event, and
 *   re-issuing (and thereby invalidating) the request per event meant a busy
 *   turn could keep a pinned row on "Loading…" for its whole duration.
 * @param stamp   The pinned row's own `updatedAt`. A change re-requests, so a
 *   revealed detail follows its task; while a request is in flight the change
 *   is coalesced into one follow-up issued after the answer lands.
 */
export function useIslandDetail(
  rowId: string | null,
  revision: number,
  stamp: number = 0
): IslandDetailSlot {
  const [slot, setSlot] = useState<IslandDetailSlot>(EMPTY_SLOT)
  const pending = useRef<string | null>(null)
  const pendingRow = useRef<string | null>(null)
  const revisionRef = useRef(revision)
  // Kept fresh in an effect (declared before the request effect, so it runs
  // first) rather than during render, which the ref rule forbids.
  useEffect(() => {
    revisionRef.current = revision
  }, [revision])
  // The row wanted once the in-flight request answers, if it changed meanwhile.
  const followUp = useRef<string | null>(null)

  const issue = (target: string) => {
    counter += 1
    const requestId = `island-detail-${Date.now().toString(36)}-${counter}`
    pending.current = requestId
    pendingRow.current = target
    void requestIslandDetail({ requestId, revision: revisionRef.current, rowId: target })
  }

  useEffect(() => {
    let alive = true
    const offs: Array<() => void> = []
    void onIslandDetailResponse((response) => {
      if (!alive || response.requestId !== pending.current) return
      pending.current = null
      pendingRow.current = null
      setSlot({
        rowId: response.rowId,
        detail: response.detail,
        error: response.detail ? null : (response.reason ?? "unavailable"),
      })
      const next = followUp.current
      followUp.current = null
      if (next) issue(next)
    }).then((off) => (alive ? offs.push(off) : off()))
    return () => {
      alive = false
      pending.current = null
      pendingRow.current = null
      followUp.current = null
      offs.forEach((off) => off())
    }
  }, [])

  useEffect(() => {
    // No pin, no request. The read below already reports `EMPTY_SLOT` for a
    // row that is not pinned, so there is nothing to clear here.
    if (!rowId) {
      pending.current = null
      pendingRow.current = null
      followUp.current = null
      return
    }
    if (pending.current && pendingRow.current === rowId) {
      // Coalesce: one request in flight for this row, at most one queued
      // behind it. A different row supersedes the in-flight request instead.
      followUp.current = rowId
      return
    }
    followUp.current = null
    issue(rowId)
    // `stamp` is a deliberate re-request trigger; `revision` deliberately is not.
  }, [rowId, stamp])

  // A slot for a row that is no longer pinned is not this row's detail.
  return slot.rowId === rowId ? slot : EMPTY_SLOT
}
