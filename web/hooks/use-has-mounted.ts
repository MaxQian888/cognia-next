"use client"

import { useSyncExternalStore } from "react"

/** Nothing ever changes, so no subscriber is ever notified. */
function subscribe(): () => void {
  return () => {}
}

/**
 * True once the component has hydrated on the client, false during server
 * rendering and the first client render.
 *
 * The usual spelling of this is `useState(false)` plus
 * `useEffect(() => setMounted(true), [])`, which the repository's lint rules
 * reject — calling setState from an effect schedules a second render pass for
 * information React already has. `useSyncExternalStore` expresses the same fact
 * declaratively: the server snapshot is `false`, the client snapshot is `true`,
 * and there is no effect and no extra render.
 *
 * Needed wherever the first paint cannot know the answer — the theme control
 * cannot know the resolved theme until `next-themes` has read storage, and
 * rendering a guess there is a guaranteed hydration mismatch.
 */
export function useHasMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
}
