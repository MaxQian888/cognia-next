"use client"

/**
 * Live console + network feed for the embedded browser (ADR-0127).
 *
 * The overlay pushes batches over `browser://console` / `browser://network`
 * (see `lib/browser/overlay.injected.js`, `src-tauri/src/browser/commands.rs`);
 * this hook keeps a bounded ring per stream so the DevTools drawer can show
 * them without re-rendering the pane per entry. Pull-mode `readConsole` /
 * `readNetwork` stay the agent's path — this is the human's.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  BROWSER_EVENTS,
  type BrowserConsolePush,
  type BrowserNetworkPush,
  type ConsoleEntry,
  type NetworkEntry,
} from "@/lib/browser/protocol"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

/** Entries kept per stream; older ones fall off the front. */
export const DEVTOOLS_RING = 500

export interface UseBrowserDevtools {
  console: ConsoleEntry[]
  network: NetworkEntry[]
  /** Console entries at `warn` / `error` level — drives the toolbar badge. */
  problemCount: number
  /** Network entries with `ok === false`. */
  failedRequests: number
  clearConsole: () => void
  clearNetwork: () => void
}

/** Pure ring append, exported for tests. */
export function appendRing<T>(ring: readonly T[], next: readonly T[], cap = DEVTOOLS_RING): T[] {
  if (next.length === 0) return ring as T[]
  const merged =
    ring.length + next.length > cap ? [...ring, ...next].slice(-cap) : [...ring, ...next]
  return merged
}

export interface UseBrowserDevtoolsOptions {
  /**
   * Restrict the feed to one native pane label. Every embedded pane is
   * `"browser-embed"` today, so this cannot separate two mounted panes on its
   * own — {@link UseBrowserDevtoolsOptions.enabled} is what does that.
   */
  paneId?: string | null
  /**
   * Whether this pane owns the embedded webview. Defaults to true. A pane that
   * does not own it would otherwise mirror the owner's console and network
   * feeds into a drawer describing a page it is not showing.
   */
  enabled?: boolean
  /**
   * Pull the feeds instead of receiving them.
   *
   * The embedded engine's overlay pushes batches over `browser://console` /
   * `browser://network`; a remote Chromium session has no such channel into
   * this renderer, but `RemoteChromiumEngine` does implement the drains. Supply
   * them here and the same rings fill by polling. Poll only while the readout
   * is actually on screen — this is a network round-trip per tick.
   */
  poll?: {
    readConsole: () => Promise<ConsoleEntry[]>
    readNetwork: () => Promise<NetworkEntry[]>
    intervalMs?: number
  } | null
}

export function useBrowserDevtools(options: UseBrowserDevtoolsOptions = {}): UseBrowserDevtools {
  const { paneId, enabled = true, poll = null } = options
  const [consoleRing, setConsoleRing] = useState<ConsoleEntry[]>([])
  const [networkRing, setNetworkRing] = useState<NetworkEntry[]>([])

  useEffect(() => {
    if (!isTauri() || !enabled) return
    let cancelled = false
    const unlisteners: Array<() => void> = []
    const accepts = (id: string) => !paneId || id === paneId
    // Best-effort: with no event plane (tests / a shell that has not
    // installed the transport yet) the drawer simply stays empty.
    const listen = <T extends { paneId: string; entries: unknown }>(
      event: string,
      apply: (entries: T["entries"]) => void
    ) => {
      try {
        void onTauriEvent<T>(event, (payload) => {
          if (cancelled || !payload || !Array.isArray(payload.entries) || !accepts(payload.paneId))
            return
          apply(payload.entries)
        })
          .then((unlisten) => {
            if (cancelled) safeUnlisten(unlisten)
            else unlisteners.push(unlisten)
          })
          .catch(() => undefined)
      } catch {
        // no transport — nothing to unlisten
      }
    }
    listen<BrowserConsolePush>(BROWSER_EVENTS.console, (entries) =>
      setConsoleRing((ring) => appendRing(ring, entries))
    )
    listen<BrowserNetworkPush>(BROWSER_EVENTS.network, (entries) =>
      setNetworkRing((ring) => appendRing(ring, entries))
    )
    return () => {
      cancelled = true
      for (const u of unlisteners) safeUnlisten(u)
    }
  }, [paneId, enabled])

  // Pull mode. Each drain returns everything observed since the last one, so
  // the rings append exactly as they do in push mode.
  const readConsole = poll?.readConsole
  const readNetwork = poll?.readNetwork
  const intervalMs = poll?.intervalMs ?? 1500
  useEffect(() => {
    if (!enabled || !readConsole || !readNetwork) return
    let cancelled = false
    const tick = async () => {
      try {
        const [consoleEntries, networkEntries] = await Promise.all([readConsole(), readNetwork()])
        if (cancelled) return
        if (consoleEntries.length) setConsoleRing((ring) => appendRing(ring, consoleEntries))
        if (networkEntries.length) setNetworkRing((ring) => appendRing(ring, networkEntries))
      } catch {
        // A dropped session or an in-flight navigation: the next tick retries.
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [enabled, readConsole, readNetwork, intervalMs])

  const clearConsole = useCallback(() => setConsoleRing([]), [])
  const clearNetwork = useCallback(() => setNetworkRing([]), [])

  const problemCount = useMemo(
    () => consoleRing.reduce((n, e) => (e.level === "warn" || e.level === "error" ? n + 1 : n), 0),
    [consoleRing]
  )
  const failedRequests = useMemo(
    () => networkRing.reduce((n, e) => (e.ok === false ? n + 1 : n), 0),
    [networkRing]
  )

  return {
    console: consoleRing,
    network: networkRing,
    problemCount,
    failedRequests,
    clearConsole,
    clearNetwork,
  }
}
