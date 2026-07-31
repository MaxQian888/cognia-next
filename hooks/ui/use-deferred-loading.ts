"use client"

/**
 * `useDeferredLoading` — anti-flicker gate for a loading indicator.
 *
 * Two thresholds, both aimed at the same failure: an indicator that appears and
 * vanishes faster than the eye can resolve reads as a glitch, not as progress.
 *
 *   delayMs        Nothing is shown until the wait crosses it. This repo is
 *                  Dexie-first, so the overwhelming majority of reads settle in
 *                  well under one frame; without a delay every one of them
 *                  would flash a skeleton for a single paint.
 *   minDisplayMs   Once shown, the indicator stays for at least this long. It
 *                  closes the narrow window (data arriving just after the
 *                  delay) where the indicator would strobe.
 *
 * Neither threshold is scaled by `--motion-duration-scale`. They are perception
 * thresholds, not animation — a user who prefers slower animation has not asked
 * to be shown more skeletons.
 *
 * This lives in a hook rather than inside `Skeleton`/`Spinner` on purpose:
 * whether a given wait is worth showing is knowledge the data layer has (a warm
 * Dexie hit versus a cold network pull), not something a presentational
 * primitive can infer. Keeping the primitives dumb also means the ~30 existing
 * suites that assert a skeleton renders synchronously stay valid.
 *
 * Unmounting mid-wait is not special-cased: the cleanup drops the pending
 * timer and the component goes away. `minDisplayMs` is there to stop flicker,
 * not to hold a dying subtree on screen.
 */

import { useEffect, useState } from "react"

/** Wait must exceed this before any indicator is shown. */
export const LOADING_DELAY_MS = 180
/** Once shown, an indicator stays at least this long. */
export const LOADING_MIN_DISPLAY_MS = 320

export interface DeferredLoadingOptions {
  /**
   * Identity of the thing being loaded (session id, plugin id, route param).
   * Changing it resets the timers immediately, so switching quickly between
   * two sessions cannot carry the previous one's `minDisplayMs` debt across.
   */
  key?: string | number | null
  delayMs?: number
  minDisplayMs?: number
}

interface DeferredState {
  key: string | number | null | undefined
  visible: boolean
  /** Epoch ms at which the indicator became visible; null while hidden. */
  shownAt: number | null
}

export function useDeferredLoading(
  loading: boolean,
  options: DeferredLoadingOptions = {}
): boolean {
  const { key, delayMs = LOADING_DELAY_MS, minDisplayMs = LOADING_MIN_DISPLAY_MS } = options

  const [state, setState] = useState<DeferredState>({ key, visible: false, shownAt: null })

  // Reset during render rather than in an effect. React documents this as the
  // way to adjust state when a prop changes, and it matters here: an effect
  // would let one frame of the *previous* key's indicator paint before clearing
  // it, which is the exact flicker this hook exists to prevent. (It also keeps
  // `react-hooks/set-state-in-effect`, which is enabled for `hooks/**`, happy.)
  if (state.key !== key) {
    setState({ key, visible: false, shownAt: null })
  }
  const visible = state.key === key && state.visible

  useEffect(() => {
    if (loading) {
      if (visible) return
      const timer = setTimeout(() => {
        setState((prev) => ({ ...prev, visible: true, shownAt: Date.now() }))
      }, delayMs)
      return () => clearTimeout(timer)
    }

    if (!visible) return
    const shownAt = state.shownAt ?? Date.now()
    const remaining = Math.max(0, minDisplayMs - (Date.now() - shownAt))
    // Always go through a timer, even at 0ms: a direct call here would be a
    // synchronous set-state inside an effect.
    const timer = setTimeout(() => {
      setState((prev) => ({ ...prev, visible: false, shownAt: null }))
    }, remaining)
    return () => clearTimeout(timer)
  }, [loading, visible, state.shownAt, delayMs, minDisplayMs, key])

  return visible
}
