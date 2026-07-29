"use client"

/**
 * Landing feedback for conversation jumps.
 *
 * Jumping used to be silent: the timeline, the anchor chords and the artifact
 * dock all just moved the scroll offset, so the only way to tell whether a jump
 * had gone anywhere — or landed on the message you meant — was to read the text
 * and work it out. Long conversations repeat themselves, which makes that a
 * genuinely hard question.
 *
 * This hook holds "the message we just jumped to" for a short beat so the row
 * can mark itself, then clears it. It is deliberately NOT the search bar's
 * `activeHitId`: that one is a persistent "this is the current match" state that
 * survives until you move to the next hit, whereas this is a one-shot "you
 * arrived here" pulse. Both can be on the same row at once.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"

/** How long the landing mark stays up, before the motion-duration multiplier. */
export const JUMP_FLASH_BASE_MS = 1200

/**
 * Hold time scaled by the user's motion preference, so the pulse and the
 * unmount stay in step. Takes the *duration* scale from `useFlowMotion`, not
 * the raw speed multiplier: a faster preference must SHORTEN the hold, and
 * multiplying by speed did the opposite.
 */
export function jumpFlashHoldMs(durationScale: number): number {
  // Floored independently of `speedToDurationScale`'s own clamp: this is
  // exported and callable with a raw number, and a 0ms hold would unmount the
  // mark before it ever painted.
  return JUMP_FLASH_BASE_MS * Math.max(durationScale, 0.25)
}

export interface JumpFlashState {
  /** Message id currently marked as "just jumped to", or null. */
  flashId: string | null
  /**
   * Bumped on every call to `flash`. Jumping twice to the SAME message would
   * otherwise leave `flashId` unchanged, React would not re-render, and the
   * second jump would show nothing — the most confusing case of all, because
   * repeating the action is exactly what you do when you are unsure it worked.
   */
  flashNonce: number
  /** Hold duration in ms — the row's animation runs for the same span. */
  holdMs: number
  flash: (messageId: string) => void
}

export function useJumpFlash(): JumpFlashState {
  const { durationScale } = useFlowMotion()
  const holdMs = jumpFlashHoldMs(durationScale)
  const [state, setState] = useState<{ id: string | null; nonce: number }>({ id: null, nonce: 0 })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current == null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const flash = useCallback(
    (messageId: string) => {
      clearTimer()
      setState((prev) => ({ id: messageId, nonce: prev.nonce + 1 }))
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        // Guard on the id so a stale timer can never blank a newer flash.
        setState((prev) => (prev.id === messageId ? { ...prev, id: null } : prev))
      }, holdMs)
    },
    [clearTimer, holdMs]
  )

  useEffect(() => clearTimer, [clearTimer])

  return { flashId: state.id, flashNonce: state.nonce, holdMs, flash }
}
