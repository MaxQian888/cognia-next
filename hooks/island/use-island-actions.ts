"use client"

/**
 * Dispatching island intents and waiting for their receipts.
 *
 * The overlay never executes anything. It emits a typed intent, keeps the
 * control disabled until the main window answers, and reports a retryable
 * error if no answer arrives inside {@link ISLAND_ACTION_TIMEOUT_MS}. There is
 * deliberately no optimistic removal: a row disappears when the authoritative
 * projection says so, never because a click looked like it worked.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { onIslandActionResult, requestIslandAction } from "@/lib/island/client"
import {
  ISLAND_ACTION_TIMEOUT_MS,
  type DistributiveOmit,
  type IslandActionIntent,
  type IslandActionResult,
} from "@/lib/island/types"

/** What a control shows for one in-flight or just-finished action. */
export interface IslandActionStatus {
  pending: boolean
  /** `fleet.island.actionError.*` key, or null when the last try succeeded. */
  error: string | null
}

export const IDLE_ACTION_STATUS: IslandActionStatus = { pending: false, error: null }

/** An intent without its request id, which the hook mints. */
export type IslandActionRequest = DistributiveOmit<IslandActionIntent, "requestId">

export interface UseIslandActionsResult {
  /** Status for one control, keyed by `rowId:kind`. */
  statusOf(rowId: string, kind: IslandActionIntent["kind"]): IslandActionStatus
  /** Resolves true once the main window reports the action completed. */
  dispatch(intent: IslandActionRequest): Promise<boolean>
}

let counter = 0
function nextRequestId(): string {
  counter += 1
  return `island-action-${Date.now().toString(36)}-${counter}`
}

export function useIslandActions(): UseIslandActionsResult {
  const [statuses, setStatuses] = useState<Record<string, IslandActionStatus>>({})
  const inflight = useRef(
    new Map<
      string,
      { slot: string; timer: ReturnType<typeof setTimeout>; resolve: (ok: boolean) => void }
    >()
  )

  const settle = useCallback((requestId: string, error: string | null) => {
    const entry = inflight.current.get(requestId)
    if (!entry) return
    clearTimeout(entry.timer)
    inflight.current.delete(requestId)
    setStatuses((prev) => ({ ...prev, [entry.slot]: { pending: false, error } }))
    entry.resolve(error === null)
  }, [])

  useEffect(() => {
    let alive = true
    const offs: Array<() => void> = []
    const pending = inflight.current
    void onIslandActionResult((result: IslandActionResult) => {
      if (!alive) return
      settle(
        result.requestId,
        result.outcome === "completed" ? null : (result.reason ?? "callFailed")
      )
    }).then((off) => (alive ? offs.push(off) : off()))
    return () => {
      alive = false
      offs.forEach((off) => off())
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.resolve(false)
      }
      pending.clear()
    }
  }, [settle])

  const dispatch = useCallback(
    (intent: IslandActionRequest): Promise<boolean> => {
      const slot = `${intent.rowId}:${intent.kind}`
      // Repeat-submission guard. One control cannot fire twice while its first
      // attempt is still outstanding.
      for (const entry of inflight.current.values()) {
        if (entry.slot === slot) return Promise.resolve(false)
      }
      const requestId = nextRequestId()
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(requestId, "timeout"), ISLAND_ACTION_TIMEOUT_MS)
        inflight.current.set(requestId, { slot, timer, resolve })
        setStatuses((prev) => ({ ...prev, [slot]: { pending: true, error: null } }))
        void requestIslandAction({ ...intent, requestId } as IslandActionIntent).then((sent) => {
          if (!sent) settle(requestId, "callFailed")
        })
      })
    },
    [settle]
  )

  const statusOf = useCallback(
    (rowId: string, kind: IslandActionIntent["kind"]) =>
      statuses[`${rowId}:${kind}`] ?? IDLE_ACTION_STATUS,
    [statuses]
  )

  return { statusOf, dispatch }
}
