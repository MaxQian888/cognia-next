import { useCallback, useEffect, useRef } from "react"
import type { Dispatch } from "react"
import type { TuiAction } from "../../state/types"

/**
 * `btw` steer mirror. The async goal/loop driver and the plain-turn drain read
 * the latest queued steer through a ref (component `state` is only the snapshot
 * at dispatch time). The ref is kept in sync with `state.steerQueue`.
 *
 * `takeSteer` drains the queued steer messages into a single framed prompt (or
 * null when empty), clearing the reducer queue so the footer indicator stays
 * honest.
 */
export function useSteerQueue(
  steerQueue: string[],
  dispatch: Dispatch<TuiAction>
): { steerRef: React.MutableRefObject<string[]>; takeSteer: () => string | null } {
  const steerRef = useRef<string[]>(steerQueue)
  useEffect(() => {
    steerRef.current = steerQueue
  }, [steerQueue])

  const takeSteer = useCallback((): string | null => {
    if (steerRef.current.length === 0) return null
    const joined = steerRef.current.join("\n")
    steerRef.current = []
    dispatch({ type: "STEER_CLEAR" })
    return joined
  }, [dispatch])

  return { steerRef, takeSteer }
}
