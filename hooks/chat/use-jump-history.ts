"use client"

/**
 * "Take me back to where I was" for conversation jumps.
 *
 * Jumping is cheap; getting back was not. Clicking a turn in the timeline, an
 * anchor chord, or an artifact's source link moves you somewhere far away, and
 * the only way home was to scroll and hope you recognised it — which in a long
 * conversation you usually do not.
 *
 * The return point is a scroll offset, not a message id: what you want back is
 * the *view* you had, and the message you were reading may not even be a turn
 * anchor. A single slot rather than a stack — chaining "back" through five
 * previous jumps is a browser-history model nobody asks a chat transcript for,
 * and it would need UI to explain itself.
 *
 * The offer expires, because a stale "back" button is worse than none: it
 * promises a place you have long since stopped caring about. It is also dropped
 * when the user scrolls under their own steam — they have chosen a new place.
 */

import { useCallback, useEffect, useRef, useState } from "react"

/** How long a return offer stays on the table. */
export const JUMP_RETURN_TTL_MS = 8000

interface ReturnPoint {
  /** The conversation the offset belongs to. */
  session: string | null | undefined
  offset: number
}

export interface JumpHistory {
  /** True while a return point is on offer. */
  canReturn: boolean
  /** Remember the current offset as the place to come back to. */
  remember: (scrollTop: number) => void
  /** Consume the offer, handing back the offset to scroll to (null if none). */
  takeReturn: () => number | null
  /** Drop the offer — the user scrolled somewhere of their own choosing. */
  forget: () => void
}

export function useJumpHistory(sessionId?: string | null): JumpHistory {
  const [point, setPoint] = useState<ReturnPoint | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A scroll offset means nothing in another conversation — honouring it would
  // dump the user at an arbitrary point in a thread they just opened. The
  // session is stored WITH the offset and checked here rather than cleared in
  // an effect on `sessionId`: a stale point simply stops matching, so switching
  // conversations costs no extra render pass.
  const active = point && point.session === sessionId ? point : null

  const clearTimer = useCallback(() => {
    if (timerRef.current == null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const forget = useCallback(() => {
    clearTimer()
    // Functional and identity-guarded: the scroll handler calls this on frames
    // where there is nothing to forget, and an unconditional `setPoint(null)`
    // there would re-render the whole message list once per scroll event.
    setPoint((prev) => (prev === null ? prev : null))
  }, [clearTimer])

  const remember = useCallback(
    (scrollTop: number) => {
      clearTimer()
      setPoint({ session: sessionId, offset: scrollTop })
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setPoint(null)
      }, JUMP_RETURN_TTL_MS)
    },
    [clearTimer, sessionId]
  )

  const takeReturn = useCallback(() => {
    if (!active) return null
    forget()
    return active.offset
  }, [active, forget])

  useEffect(() => clearTimer, [clearTimer])

  return { canReturn: active != null, remember, takeReturn, forget }
}
