"use client"

/**
 * Reactive view of what the terminal host said about itself.
 *
 * The cache in `lib/terminal/host-capabilities.ts` is filled by whichever
 * frame arrives first — the reattach-at-boot list, or an explicit probe — so a
 * surface that reads it during render would get `null` on the first pass and
 * never hear about the answer. This subscribes, and warms the cache on mount
 * for surfaces (the shell picker) that open before anything has connected.
 *
 * Returns `null` on the local PTY by design: there the host *is* this machine,
 * `shell-detect` already describes it, and `ensureHostCapabilities` refuses to
 * open a remote probe. Callers read `null` as "use the local story".
 */

import { useEffect, useSyncExternalStore } from "react"

import {
  ensureHostCapabilities,
  getHostCapabilities,
  subscribeHostCapabilities,
  type TerminalHostCapabilities,
} from "@/lib/terminal/host-capabilities"

/** SSR / pre-hydration: the static export has no host to describe. */
function serverSnapshot(): TerminalHostCapabilities | null {
  return null
}

export function useHostCapabilities(): TerminalHostCapabilities | null {
  const capabilities = useSyncExternalStore(
    subscribeHostCapabilities,
    getHostCapabilities,
    serverSnapshot
  )
  useEffect(() => {
    // Cheap and deduped: returns the cache when warm, and no-ops entirely on
    // the local PTY.
    void ensureHostCapabilities()
  }, [])
  return capabilities
}

export default useHostCapabilities
