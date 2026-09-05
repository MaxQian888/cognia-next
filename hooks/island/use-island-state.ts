"use client"

/**
 * The island window's only data source.
 *
 * Subscribes to `island://state`, asks the main window to seed it once on
 * mount, and drops any projection older than the one already held. Ordering is
 * settled by `revision` rather than by arrival, because a re-opened overlay and
 * a live push can land in either order. A push from a different `epoch` (the
 * main webview reloaded and restarted its counter) is always taken, because
 * this window outlives that reload and would otherwise hold a revision the new
 * session takes minutes to climb past.
 */

import { useEffect, useRef, useState } from "react"

import { onIslandState, requestIslandState } from "@/lib/island/client"
import { EMPTY_ISLAND_STATE, type IslandState } from "@/lib/island/types"

export function useIslandState(): IslandState {
  const [state, setState] = useState<IslandState>(EMPTY_ISLAND_STATE)
  const revisionRef = useRef(0)
  const epochRef = useRef(0)

  useEffect(() => {
    let alive = true
    const offs: Array<() => void> = []
    void onIslandState((next) => {
      if (!alive || !next) return
      // Out-of-order push. The overlay already holds something newer from the
      // SAME main-window session; a new epoch restarts the ordering.
      if (next.epoch === epochRef.current && next.revision < revisionRef.current) return
      epochRef.current = next.epoch
      revisionRef.current = next.revision
      setState(next)
    }).then((off) => (alive ? offs.push(off) : off()))
    void requestIslandState()
    return () => {
      alive = false
      offs.forEach((off) => off())
    }
  }, [])

  return state
}
