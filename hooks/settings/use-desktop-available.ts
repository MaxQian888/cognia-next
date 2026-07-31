"use client"

/**
 * Whether the desktop (Tauri) runtime is available, in a form that is safe to
 * read during render.
 *
 * `isTauri()` keys on a `window` marker, so calling it directly in a component
 * body would disagree with the prerendered HTML the static export ships. The
 * previous workaround (`useState(false)` + `setTimeout(0)`) resolved a whole
 * macrotask late, which let the browser paint the "not desktop" list first —
 * that's why desktop-only nav entries visibly popped in on desktop.
 *
 * `useSyncExternalStore` expresses the same thing without a timer: the server
 * snapshot is `false` (matching the prerender), and React swaps to the client
 * snapshot as part of finishing hydration rather than a frame later. The marker
 * never changes after boot, so `subscribe` has nothing to listen to.
 */

import { useSyncExternalStore } from "react"

import { isTauri } from "@/lib/platform/detect"

const NO_OP_UNSUBSCRIBE = () => {}
const subscribe = () => NO_OP_UNSUBSCRIBE

const getServerSnapshot = () => false

export function useDesktopAvailable(): boolean {
  return useSyncExternalStore(subscribe, isTauri, getServerSnapshot)
}
