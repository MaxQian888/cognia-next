"use client"

import { useSyncExternalStore } from "react"

/**
 * One coarse wall-clock ticker shared by every subscription surface that
 * renders a "updated N minutes ago" / "resets in N minutes" label.
 *
 * Before this, the Overview tab ticked every 30s, the Usage tab and the quota
 * panel every 60s, each with its own `setInterval`. Three timers on one page,
 * started at different moments, so two countdowns for the same window drifted
 * visibly apart and neither lined up with the other. A single source fixes the
 * drift and drops three timers to one.
 *
 * Deliberately NOT `lib/fleet/now-ticker-store.ts`: that one ticks every second
 * for elapsed-time labels. These surfaces show minute-resolution text, so a 1 Hz
 * tick would re-render them ~60× more often than anything changes on screen.
 *
 * `useSyncExternalStore`-shaped and refcounted: the interval starts on the
 * first subscriber and stops on the last, so StrictMode's mount→unmount→mount
 * never leaks a timer. This is a DATA refresh (the wall clock), not motion, so
 * it keeps ticking under `prefers-reduced-motion` — a frozen clock is a bug,
 * not an accessibility win.
 */

/** Coarse enough for minute-resolution copy, fine enough to feel live. */
export const SUBSCRIPTION_TICK_MS = 30_000

let now = 0
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

const tick = () => {
  now = Date.now()
  for (const fn of listeners) fn()
}

export interface SubscriptionNowTicker {
  subscribe(onChange: () => void): () => void
  getSnapshot(): number
  /** SSR / static-export fallback; stable so hydration matches. */
  getServerSnapshot(): number
  resetForTests(): void
}

export const subscriptionNowTicker: SubscriptionNowTicker = {
  subscribe(onChange: () => void): () => void {
    const cold = listeners.size === 0
    listeners.add(onChange)
    if (cold) {
      // Seed immediately so the first paint is already correct instead of
      // showing a stale value until the first interval fires.
      now = Date.now()
      timer = setInterval(tick, SUBSCRIPTION_TICK_MS)
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners.delete(onChange)
      if (listeners.size === 0 && timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }
  },
  getSnapshot(): number {
    return now
  },
  getServerSnapshot(): number {
    return 0
  },
  resetForTests(): void {
    listeners.clear()
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    now = 0
  },
}

/**
 * React binding for {@link subscriptionNowTicker}. Returns the shared wall
 * clock, re-rendering the caller on each tick.
 */
export function useSubscriptionNow(): number {
  return useSyncExternalStore(
    subscriptionNowTicker.subscribe,
    subscriptionNowTicker.getSnapshot,
    subscriptionNowTicker.getServerSnapshot
  )
}
