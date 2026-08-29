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
 * never leaks a timer. The clock itself is seeded on the first `getSnapshot`
 * rather than on the first `subscribe`, because React reads the snapshot one
 * render before it subscribes. This is a DATA refresh (the wall clock), not motion, so
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
    // Seed on FIRST READ, not on first subscribe. `useSyncExternalStore` calls
    // this during the initial render, while `subscribe` only runs afterwards in
    // an effect — so a cold ticker used to hand that first render a clock of 0.
    // Consumers then dated every quota reset to 1970 + the remaining time for
    // one frame, which is a plausible-looking wrong answer, not an obvious one.
    // Assigning here is safe because it caches: every later call in the same
    // render returns the same number, which is all the store contract requires.
    if (now === 0) now = Date.now()
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
