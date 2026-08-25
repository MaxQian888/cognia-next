"use client"

import { useCallback, useEffect, useState } from "react"

import { BROWSER_EVENTS, type BrowserLoaded } from "@/lib/browser/protocol"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

/**
 * `idle` — no committed target; `loading` — a navigation is in flight;
 * `ready` — the current page has finished loading.
 */
export type BrowserLoadPhase = "idle" | "loading" | "ready"

export interface UseBrowserLoading {
  phase: BrowserLoadPhase
  /** True once the preview has fully loaded at least one page. */
  hasPainted: boolean
  /**
   * The URL of the last settled document — the point at which a page has
   * genuinely been arrived at, which is what the back/forward stack keys off.
   * A redirect chain reports one `browser://navigated` per hop but settles
   * once, so this collapses to the final address. Falls back to the committed
   * target when the safety timeout settles without a signal, so the history
   * menu is still populated for a page that never reports a load.
   */
  loadedUrl: string | null
  /**
   * Mark an explicit user-initiated navigation as starting. Needed for
   * same-URL reloads and history back/forward, where the committed `url`
   * doesn't change so the url-change effect can't infer a new load.
   */
  begin: () => void
}

export interface UseBrowserLoadingOptions {
  /** The committed target URL (null when the pane is empty → idle). */
  url: string | null
  /**
   * Force `ready` (and thus reveal) if no `browser://loaded` signal arrives in
   * time — a page that blocks the sentinel navigation, or an SPA route change
   * that never fires a full document load, must never leave the pane stuck on
   * its loading placeholder.
   */
  settleTimeoutMs?: number
}

const DEFAULT_SETTLE_TIMEOUT_MS = 20_000

/**
 * Owns the preview pane's load lifecycle. The embedded page reports completion
 * via the `browser://loaded` sentinel (see `lib/browser/overlay.injected.js` +
 * `src-tauri/src/browser/commands.rs`); this hook turns that (plus a safety
 * timeout) into a phase the pane renders a progress bar / first-load
 * placeholder from, and a `hasPainted` flag that gates revealing the native
 * webview.
 */
export function useBrowserLoading({
  url,
  settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
}: UseBrowserLoadingOptions): UseBrowserLoading {
  const [phase, setPhase] = useState<BrowserLoadPhase>(url ? "loading" : "idle")
  const [hasPainted, setHasPainted] = useState(false)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const [trackedUrl, setTrackedUrl] = useState<string | null>(url)
  // Bumped on each new load episode so the safety-timeout effect re-arms.
  const [loadSeq, setLoadSeq] = useState(0)

  // Start loading whenever the committed target changes (typed URL, quick-open
  // chip, redirect commit). React's "adjust state on prop change" pattern —
  // done during render, not a setState-in-effect. Same-URL reloads / history
  // navigations go through `begin()` since the url doesn't change for them.
  if (url !== trackedUrl) {
    setTrackedUrl(url)
    if (url) {
      setPhase("loading")
      setLoadSeq((n) => n + 1)
    } else {
      setPhase("idle")
      setHasPainted(false)
      setLoadedUrl(null)
    }
  }

  const begin = useCallback(() => {
    setPhase("loading")
    setLoadSeq((n) => n + 1)
  }, [])

  const settle = useCallback((settledUrl: string | null) => {
    setHasPainted(true)
    setPhase("ready")
    if (settledUrl) setLoadedUrl(settledUrl)
  }, [])

  // Safety timeout: a load episode that never receives a `browser://loaded`
  // must still resolve, so the pane can't get stuck on its placeholder. Keyed
  // on `loadSeq` so each new episode resets the deadline.
  useEffect(() => {
    if (phase !== "loading") return
    // No signal arrived: settle against the committed target so the pane is
    // revealed and the history menu still learns where it went.
    const timer = setTimeout(() => settle(url), settleTimeoutMs)
    return () => clearTimeout(timer)
  }, [phase, loadSeq, settleTimeoutMs, settle, url])

  // Load-complete signal from the embedded page.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    void onTauriEvent<BrowserLoaded>(BROWSER_EVENTS.loaded, (payload) => {
      if (!cancelled) settle(payload?.url ?? null)
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [settle])

  return { phase, hasPainted, loadedUrl, begin }
}
