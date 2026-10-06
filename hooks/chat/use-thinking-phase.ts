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
 *   t < 8s   → just the avatar and the shimmering status word (`showTips` false)
 *   t ≥ 8s   → `showTips` flips on (a built-in tip appears) and, unless motion
 *              is reduced, `tipIndex` advances every `tipRotateMs`. A short
 *              reply finishes before then, so it never shows a tip at all.
 *
 * Orthogonally, `verbIndex` advances every `verbRotateMs` from mount so the
 * label can cycle playful "working" verbs (the Claude Code touch). It starts at
 * 0 — callers put the plain label first — and, unlike the phase flips, it is
 * purely decorative, so reduced motion freezes it.
 *
 * Reduced motion (`reduce`): the tip still appears — it is informational, not
 * decorative — but tip and verb rotation are suppressed so the text stays put.
 */

import { useEffect, useState } from "react"

/** Built-in tips appear once the wait crosses this threshold. */
export const TIPS_AT_MS = 8000
/** Interval between rotated tips (suppressed under reduced motion). */
export const TIP_ROTATE_MS = 5000
/** Interval between rotated label verbs (suppressed under reduced motion). */
export const VERB_ROTATE_MS = 3000

export interface ThinkingPhaseOptions {
  /** Number of available tips; rotation only runs when this is > 1. */
  tipCount?: number
  /** Number of available label verbs; rotation only runs when this is > 1. */
  verbCount?: number
  /** Suppress tip / verb rotation when motion is reduced. */
  reduce?: boolean
  /** Override the tips threshold (testing / tuning). */
  tipsAtMs?: number
  /** Override the tip rotation interval (testing / tuning). */
  tipRotateMs?: number
  /** Override the verb rotation interval (testing / tuning). */
  verbRotateMs?: number
}

export interface ThinkingPhase {
  showTips: boolean
  tipIndex: number
  verbIndex: number
}

export function useThinkingPhase(options: ThinkingPhaseOptions = {}): ThinkingPhase {
  const {
    tipCount = 0,
    verbCount = 0,
    reduce = false,
    tipsAtMs = TIPS_AT_MS,
    tipRotateMs = TIP_ROTATE_MS,
    verbRotateMs = VERB_ROTATE_MS,
  } = options

  const [showTips, setShowTips] = useState(false)
  const [tipIndex, setTipIndex] = useState(0)
  const [verbIndex, setVerbIndex] = useState(0)

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    let interval: ReturnType<typeof setInterval> | undefined

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
  }, [reduce, tipCount, tipsAtMs, tipRotateMs])

  // Verb rotation runs on its own clock from mount (no threshold): the label is
  // visible from frame one, so it is the only motion during a long tool-heavy
  // stretch. Separate effect so tuning tips can't restart the verb cycle.
  useEffect(() => {
    if (reduce || verbCount <= 1) return
    const interval = setInterval(() => {
      setVerbIndex((i) => (i + 1) % verbCount)
    }, verbRotateMs)
    return () => clearInterval(interval)
  }, [reduce, verbCount, verbRotateMs])

  return { showTips, tipIndex, verbIndex }
}
