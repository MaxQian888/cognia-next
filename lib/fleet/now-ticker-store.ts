"use client"

/**
 * Module-level 1-second ticker shared by every fleet component that renders a
 * live elapsed / countdown label — the island rows and the permission
 * countdown (which is reused in both the island window and the main-window
 * attention panel). A single `setInterval` serves all subscribers, replacing
 * the per-component `setInterval(1000)` each row and each permission card used
 * to run (N rows → N timers).
 *
 * `useSyncExternalStore`-shaped and refcounted like `createTauriEventStore`:
 * the interval starts on the first subscriber and stops on the last, so
 * StrictMode's mount→unmount→mount never leaks a stray timer. This is a DATA
 * refresh (the wall clock), not motion, so it deliberately keeps ticking under
 * `prefers-reduced-motion` — a paused clock would be a bug, not an
 * accessibility win.
 */

let now = 0
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

const tick = () => {
  now = Date.now()
  for (const fn of listeners) fn()
}

export interface NowTickerStore {
  /** React `useSyncExternalStore` contract. */
  subscribe(onChange: () => void): () => void
  getSnapshot(): number
  /** SSR/static-export fallback (stable, matches the pre-subscribe snapshot). */
  getServerSnapshot(): number
  /** Drop the interval + listeners (tests/HMR). */
  resetForTests(): void
}

export const nowTickerStore: NowTickerStore = {
  subscribe(onChange: () => void): () => void {
    const cold = listeners.size === 0
    listeners.add(onChange)
    if (cold) {
      // Seed immediately so the first paint's elapsed label is already correct
      // rather than waiting a full second for the first tick.
      now = Date.now()
      timer = setInterval(tick, 1000)
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
