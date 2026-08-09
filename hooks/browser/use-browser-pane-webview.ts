"use client"

import { type RefObject, useCallback, useEffect, useRef } from "react"

import { browserClient } from "@/lib/browser/client"
import { BROWSER_EVENTS, type BrowserProxyError, type ElementRect } from "@/lib/browser/protocol"
import { NETWORK_PROXY_APPLIED_EVENT } from "@/lib/network/proxy-events"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

import { readElementRect, useElementRect } from "./use-element-rect"

export interface UseBrowserPaneWebview {
  /** Read the latest reserved-div rect without subscribing to re-renders. */
  getRect: () => ElementRect | null
  /** Re-measure the reserved div after a known React layout change. */
  refreshBounds: () => void
  /** Show/hide the embedded webview (e.g. when an app modal overlaps it). */
  setVisible: (visible: boolean) => Promise<void>
}

export interface UseBrowserPaneWebviewOptions {
  url: string | null
  /** Stable diagnostic owner for the process-wide embedded-webview lease. */
  ownerId?: string
  /** Fires after this pane owns a successfully created native webview. */
  onReady?: () => void
  /** Reports native creation/navigation failures to the owning UI surface. */
  onError?: (error: unknown) => void
  /**
   * Fires on every reserved-rect change (rAF-coalesced). Rect tracking is
   * entirely ref-driven — a scroll/resize burst never re-renders the caller.
   */
  onRectChange?: (rect: ElementRect) => void
  /**
   * When false, the native webview is parked off-screen so the React layer
   * (loading placeholder, or whatever now covers the pane) shows through. The
   * webview floats above React and can't be clipped, so this is the only way to
   * yield to a loading state / modal / hidden route. Defaults to true.
   */
  visible?: boolean
}

let activeLease: { token: string; ownerId: string } | null = null
const leaseWaiters = new Set<() => void>()

function acquireLease(token: string, ownerId: string): boolean {
  if (activeLease && activeLease.token !== token) return false
  activeLease = { token, ownerId }
  browserClient.setEmbedOwnerToken(token)
  return true
}

function releaseLease(token: string, notifyWaiters = true): void {
  if (activeLease?.token !== token) return
  activeLease = null
  browserClient.setEmbedOwnerToken(null)
  if (notifyWaiters) queueMicrotask(() => leaseWaiters.forEach((retry) => retry()))
}

/**
 * Owns the embedded preview webview's lifecycle: creates it over the reserved
 * `ref` div, keeps its bounds synced to that rect, navigates on url change, and
 * destroys it on unmount. The native webview floats above the React layer, so
 * positioning is entirely rect-driven (see {@link useElementRect}), and the
 * rect is held in refs — consumers read it via `getRect` instead of re-rendering
 * on every scroll/resize frame.
 */
export function useBrowserPaneWebview(
  ref: RefObject<HTMLElement | null>,
  options: UseBrowserPaneWebviewOptions
): UseBrowserPaneWebview {
  const {
    url,
    onReady,
    onError,
    onRectChange,
    visible = true,
    ownerId = "browser-preview",
  } = options
  const leaseTokenRef = useRef(`${ownerId}:${crypto.randomUUID()}`)
  const retryAttemptRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncRef = useRef<() => void>(() => undefined)
  const createdRef = useRef(false)
  const lastUrlRef = useRef<string | null>(null)
  const rectRef = useRef<ElementRect | null>(null)
  const urlRef = useRef(url)
  const visibleRef = useRef(visible)
  const onReadyRef = useRef(onReady)
  const onErrorRef = useRef(onError)
  const onRectChangeRef = useRef(onRectChange)
  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])
  useEffect(() => {
    onRectChangeRef.current = onRectChange
  }, [onRectChange])

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    void onTauriEvent<BrowserProxyError>(BROWSER_EVENTS.proxyError, (payload) => {
      if (createdRef.current && payload.paneId === "browser-embed") {
        onErrorRef.current?.(new Error(payload.code))
      }
    }).then((nextUnlisten) => {
      if (cancelled) nextUnlisten()
      else unlisten = nextUnlisten
    })
    return () => {
      cancelled = true
      if (unlisten) safeUnlisten(unlisten)
    }
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    const refreshRoute = () => {
      const target = urlRef.current
      if (!createdRef.current || !target) return
      void browserClient.embedNavigate(target).catch((error: unknown) => {
        onErrorRef.current?.(error)
      })
    }
    window.addEventListener(NETWORK_PROXY_APPLIED_EVENT, refreshRoute)
    return () => window.removeEventListener(NETWORK_PROXY_APPLIED_EVENT, refreshRoute)
  }, [])

  // Create once the url and a rect are both known; navigate on later url
  // changes. Called from both the rect callback and the url effect so whichever
  // arrives last triggers creation.
  const sync = useCallback(() => {
    const rect = rectRef.current
    const target = urlRef.current
    if (!isTauri() || !target || !rect) return
    if (!createdRef.current) {
      if (!acquireLease(leaseTokenRef.current, ownerId)) return
      createdRef.current = true
      lastUrlRef.current = target
      void browserClient.embedCreate(target, rect).then(
        () => {
          retryAttemptRef.current = 0
          onReadyRef.current?.()
          // Created visible at `rect`; if the caller wants it hidden (e.g. the
          // first-load placeholder is showing), park it immediately.
          if (!visibleRef.current) {
            void browserClient.embedSetVisible(false, rectRef.current ?? rect).catch(() => {})
          }
        },
        (error: unknown) => {
          createdRef.current = false
          releaseLease(leaseTokenRef.current, false)
          if (String(error).includes("owned by another Cognia surface")) {
            if (retryTimerRef.current === null) {
              const delay = Math.min(250 * 2 ** retryAttemptRef.current, 4_000)
              retryAttemptRef.current += 1
              retryTimerRef.current = setTimeout(() => {
                retryTimerRef.current = null
                syncRef.current()
              }, delay)
            }
          } else {
            onErrorRef.current?.(error)
          }
        }
      )
    } else if (target !== lastUrlRef.current) {
      lastUrlRef.current = target
      void browserClient.embedNavigate(target).catch((error: unknown) => {
        onErrorRef.current?.(error)
      })
    }
  }, [ownerId])
  useEffect(() => {
    syncRef.current = sync
  }, [sync])

  const onRect = useCallback(
    (next: ElementRect) => {
      rectRef.current = next
      onRectChangeRef.current?.(next)
      if (!isTauri()) return
      if (!createdRef.current) {
        sync()
        return
      }
      // While parked (hidden) the webview sits off-screen; don't churn its
      // bounds — it's revealed at the fresh rect by the visibility effect.
      if (visibleRef.current) void browserClient.embedSetBounds(next).catch(() => {})
    },
    [sync]
  )

  useElementRect(ref, onRect, { trackState: false })

  useEffect(() => {
    urlRef.current = url
    sync()
  }, [url, sync])

  useEffect(() => {
    leaseWaiters.add(sync)
    return () => {
      leaseWaiters.delete(sync)
    }
  }, [sync])

  // Drive native visibility: reveal at the current rect, or park off-screen.
  useEffect(() => {
    visibleRef.current = visible
    if (!isTauri() || !createdRef.current) return
    void browserClient
      .embedSetVisible(visible, rectRef.current ?? { x: 0, y: 0, width: 0, height: 0 })
      .catch(() => {})
  }, [visible])

  useEffect(() => {
    const leaseToken = leaseTokenRef.current
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      if (activeLease?.token === leaseToken) {
        if (createdRef.current) {
          void browserClient
            .embedDestroy()
            .catch(() => {})
            .finally(() => releaseLease(leaseToken))
        } else {
          releaseLease(leaseToken)
        }
      }
    }
  }, [])

  const getRect = useCallback(() => rectRef.current, [])

  const refreshBounds = useCallback(() => {
    const el = ref.current
    if (!el) return
    onRect(readElementRect(el))
  }, [onRect, ref])

  const setVisible = useCallback(async (visible: boolean) => {
    if (!isTauri() || !createdRef.current) return
    await browserClient
      .embedSetVisible(visible, rectRef.current ?? { x: 0, y: 0, width: 0, height: 0 })
      .catch(() => {})
  }, [])

  return { getRect, refreshBounds, setVisible }
}
