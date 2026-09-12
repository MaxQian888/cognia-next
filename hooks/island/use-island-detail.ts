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
import { ISLAND_ACTION_TIMEOUT_MS, type IslandRowDetail } from "@/lib/island/types"

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
  const [state, setState] = useState({ pin: rowId, slot: EMPTY_SLOT })
  // Reset during render so reopening the same pin cannot commit a frame of
  // private detail retained from an earlier reveal.
  if (state.pin !== rowId) setState({ pin: rowId, slot: EMPTY_SLOT })
  const revisionRef = useRef(revision)
  const stampRef = useRef(stamp)
  const refresh = useRef<(() => void) | null>(null)
  // Kept fresh in an effect (declared before the request effect, so it runs
  // first) rather than during render, which the ref rule forbids.
  useEffect(() => {
    revisionRef.current = revision
    stampRef.current = stamp
  }, [revision, stamp])

  useEffect(() => {
    if (!rowId) return
    let alive = true
    let pending: { requestId: string; timer: ReturnType<typeof setTimeout> } | null = null
    let lastStamp = stampRef.current
    let followUp = false
    let off: (() => void) | undefined

    function settle(requestId: string, slot: IslandDetailSlot) {
      if (!alive || pending?.requestId !== requestId) return
      clearTimeout(pending.timer)
      pending = null
      setState({ pin: rowId, slot })
      if (followUp) {
        followUp = false
        issue()
      }
    }

    const ready = onIslandDetailResponse((response) => {
      if (response.rowId !== rowId) return
      settle(response.requestId, {
        rowId,
        detail: response.detail,
        error: response.detail ? null : (response.reason ?? "unavailable"),
      })
    }).then((unsubscribe) => {
      if (alive) off = unsubscribe
      else unsubscribe()
    })

    function issue() {
      counter += 1
      const requestId = `island-detail-${Date.now().toString(36)}-${counter}`
      const fail = () => settle(requestId, { rowId, detail: null, error: "unavailable" })
      // Bound listener setup, emission, and the response wait together.
      pending = { requestId, timer: setTimeout(fail, ISLAND_ACTION_TIMEOUT_MS) }
      void ready
        .then(async () => {
          if (!alive || pending?.requestId !== requestId) return
          const sent = await requestIslandDetail({
            requestId,
            revision: revisionRef.current,
            rowId: rowId!,
          })
          if (!sent) fail()
        })
        .catch(fail)
    }

    refresh.current = () => {
      if (lastStamp === stampRef.current) return
      lastStamp = stampRef.current
      if (pending) followUp = true
      else issue()
    }
    issue()
    return () => {
      alive = false
      refresh.current = null
      if (pending) clearTimeout(pending.timer)
      pending = null
      off?.()
    }
  }, [rowId])

  useEffect(() => {
    refresh.current?.()
    // `stamp` is a deliberate re-request trigger; `revision` deliberately is not.
  }, [rowId, stamp])

  // A slot for a row that is no longer pinned is not this row's detail.
  return state.pin === rowId ? state.slot : EMPTY_SLOT
}
