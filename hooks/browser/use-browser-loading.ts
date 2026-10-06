"use client"

import { useCallback, useEffect, useState } from "react"

import { BROWSER_EVENTS, type BrowserLoaded } from "@/lib/browser/protocol"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

/**
 * `idle` — no committed target; `loading` — a navigation is in flight;
 * `ready` — the page finished loading; `timeout` — completion is unconfirmed;
 * `error` — the navigation or webview creation explicitly failed.
 */
export type BrowserLoadPhase = "idle" | "loading" | "ready" | "timeout" | "error"

export interface UseBrowserLoading {
  phase: BrowserLoadPhase
  /** True once the preview has fully loaded at least one page. */
  hasPainted: boolean
  /**
   * The URL of the last settled document — the point at which a page has
   * genuinely been arrived at, which is what the back/forward stack keys off.
   * A redirect chain reports one `browser://navigated` per hop but settles
   * once, so this collapses to the final address. A timeout is not a visit.
   */
  loadedUrl: string | null
  /**
   * Mark an explicit user-initiated navigation as starting. Needed for
   * same-URL reloads and history back/forward, where the committed `url`
   * doesn't change so the url-change effect can't infer a new load.
   */
  begin: () => void
  fail: () => void
  /** Reveal an unconfirmed page at the user's request without recording a visit. */
  reveal: () => void
}

export interface UseBrowserLoadingOptions {
  /** The committed target URL (null when the pane is empty → idle). */
  url: string | null
  /** A repeat request for the same address starts a new loading episode. */
  navigateNonce?: number
  /**
   * Offer recovery if no completion signal arrives. A healthy page can block
   * that signal, so a timeout must not claim a known network failure.
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
  navigateNonce = 0,
  settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
}: UseBrowserLoadingOptions): UseBrowserLoading {
  const [load, setLoad] = useState({
    phase: (url ? "loading" : "idle") as BrowserLoadPhase,
    hasPainted: false,
    loadedUrl: null as string | null,
    trackedUrl: url,
    trackedNonce: navigateNonce,
    sequence: 0,
  })
  const { phase, hasPainted, loadedUrl, sequence } = load

  if (url !== load.trackedUrl || navigateNonce !== load.trackedNonce) {
    setLoad({
      ...load,
      trackedUrl: url,
      trackedNonce: navigateNonce,
      phase: url ? "loading" : "idle",
      hasPainted: url ? load.hasPainted : false,
      loadedUrl: url ? load.loadedUrl : null,
      sequence: sequence + 1,
    })
  }

  const begin = useCallback(() => {
    setLoad((current) => ({ ...current, phase: "loading", sequence: current.sequence + 1 }))
  }, [])

  const settle = useCallback((settledUrl: string | null) => {
    setLoad((current) =>
      current.phase === "error" || current.phase === "idle"
        ? current
        : {
            ...current,
            phase: "ready",
            hasPainted: true,
            loadedUrl: settledUrl ?? current.loadedUrl,
          }
    )
  }, [])

  const fail = useCallback(() => {
    setLoad((current) => ({ ...current, phase: "error", hasPainted: false }))
  }, [])

  const reveal = useCallback(() => {
    setLoad((current) =>
      current.phase !== "timeout"
        ? current
        : {
            ...current,
            phase: "ready",
            hasPainted: true,
          }
    )
  }, [])

  // Stop the spinner without presenting an unconfirmed or failed load as ready.
  useEffect(() => {
    if (phase !== "loading") return
    const timer = setTimeout(() => {
      setLoad((current) =>
        current.phase !== "loading" || current.sequence !== sequence
          ? current
          : {
              ...current,
              phase: "timeout",
              hasPainted: false,
            }
      )
    }, settleTimeoutMs)
    return () => clearTimeout(timer)
  }, [phase, sequence, settleTimeoutMs])

  // Load-complete signal from the embedded page.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    void onTauriEvent<BrowserLoaded>(BROWSER_EVENTS.loaded, (payload) => {
      if (!cancelled && payload?.paneId === "browser-embed") settle(payload.url ?? null)
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [settle])

  return { phase, hasPainted, loadedUrl, begin, fail, reveal }
}
