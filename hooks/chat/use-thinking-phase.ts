"use client"

/**
 * `useThinkingPhase` — time-driven phase progression for the chat "waiting for
 * reply" indicator. The indicator is only mounted while the assistant turn is
 * pending (see `ChatThinkingIndicator` / `shouldShowThinking` in
 * `message-list.tsx`), so *mounting* is the activation signal and *unmount*
 * tears the timers down — there is no `active` flag and therefore no
 * synchronous `setState` inside the effect (which the repo's eslint config
 * forbids; see jest-gotchas #7).
 *
 * Phases (defaults):
 *   t < 3s   → just the avatar pulse + dots + shimmer label (both booleans false)
 *   t ≥ 3s   → `showSkeleton` flips on (skeleton placeholder lines fade in)
 *   t ≥ 4s   → `showTips` flips on (a built-in tip appears) and, unless motion
 *              is reduced, `tipIndex` advances every `tipRotateMs`.
 *
 * Reduced motion (`reduce`): phases still advance — they are informational, not
 * decorative — but tip rotation is suppressed so the tip stays put.
 */

import { useEffect, useState } from "react"

/** Skeleton placeholder lines fade in once the wait crosses this threshold. */
export const SKELETON_AT_MS = 3000
/** Built-in tips appear once the wait crosses this threshold. */
export const TIPS_AT_MS = 4000
/** Interval between rotated tips (suppressed under reduced motion). */
export const TIP_ROTATE_MS = 5000

export interface ThinkingPhaseOptions {
  /** Number of available tips; rotation only runs when this is > 1. */
  tipCount?: number
  /** Suppress tip rotation when motion is reduced. */
  reduce?: boolean
  /** Override the skeleton threshold (testing / tuning). */
  skeletonAtMs?: number
  /** Override the tips threshold (testing / tuning). */
  tipsAtMs?: number
  /** Override the tip rotation interval (testing / tuning). */
  tipRotateMs?: number
}

export interface ThinkingPhase {
  showSkeleton: boolean
  showTips: boolean
  tipIndex: number
}

export function useThinkingPhase(options: ThinkingPhaseOptions = {}): ThinkingPhase {
  const {
    tipCount = 0,
    reduce = false,
    skeletonAtMs = SKELETON_AT_MS,
    tipsAtMs = TIPS_AT_MS,
    tipRotateMs = TIP_ROTATE_MS,
  } = options

  const [showSkeleton, setShowSkeleton] = useState(false)
  const [showTips, setShowTips] = useState(false)
  const [tipIndex, setTipIndex] = useState(0)

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    let interval: ReturnType<typeof setInterval> | undefined

    timers.push(setTimeout(() => setShowSkeleton(true), skeletonAtMs))
    timers.push(setTimeout(() => setShowTips(true), tipsAtMs))

    // Rotate tips only when there's more than one to rotate through and the
    // user hasn't asked for reduced motion. Rotation starts when tips appear.
    if (!reduce && tipCount > 1) {
      timers.push(
        setTimeout(() => {
          interval = setInterval(() => {
            setTipIndex((i) => (i + 1) % tipCount)
          }, tipRotateMs)
        }, tipsAtMs)
      )
    }

    return () => {
      for (const timer of timers) clearTimeout(timer)
      if (interval) clearInterval(interval)
    }
  }, [reduce, tipCount, skeletonAtMs, tipsAtMs, tipRotateMs])

  return { showSkeleton, showTips, tipIndex }
}
