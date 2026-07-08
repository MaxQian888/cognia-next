"use client"

import { type RefObject, useCallback, useEffect, useRef } from "react"

import { browserClient } from "@/lib/browser/client"
import type { ElementRect } from "@/lib/browser/protocol"
import { isTauri } from "@/lib/tauri"

import { useElementRect } from "./use-element-rect"

export interface UseBrowserPaneWebview {
  /** Read the latest reserved-div rect without subscribing to re-renders. */
  getRect: () => ElementRect | null
  /** Show/hide the embedded webview (e.g. when an app modal overlaps it). */
  setVisible: (visible: boolean) => Promise<void>
}

export interface UseBrowserPaneWebviewOptions {
  url: string | null
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
  const { url, onRectChange, visible = true } = options
  const createdRef = useRef(false)
  const lastUrlRef = useRef<string | null>(null)
  const rectRef = useRef<ElementRect | null>(null)
  const urlRef = useRef(url)
  const visibleRef = useRef(visible)
  const onRectChangeRef = useRef(onRectChange)
  useEffect(() => {
    onRectChangeRef.current = onRectChange
  }, [onRectChange])

  // Create once the url and a rect are both known; navigate on later url
  // changes. Called from both the rect callback and the url effect so whichever
  // arrives last triggers creation.
  const sync = useCallback(() => {
    const rect = rectRef.current
    const target = urlRef.current
    if (!isTauri() || !target || !rect) return
    if (!createdRef.current) {
      createdRef.current = true
      lastUrlRef.current = target
      void browserClient.embedCreate(target, rect).then(
        () => {
          // Created visible at `rect`; if the caller wants it hidden (e.g. the
          // first-load placeholder is showing), park it immediately.
          if (!visibleRef.current) {
            void browserClient.embedSetVisible(false, rectRef.current ?? rect).catch(() => {})
          }
        },
        () => {
          createdRef.current = false
        }
      )
    } else if (target !== lastUrlRef.current) {
      lastUrlRef.current = target
      void browserClient.embedNavigate(target).catch(() => {})
    }
  }, [])

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

  // Drive native visibility: reveal at the current rect, or park off-screen.
  useEffect(() => {
    visibleRef.current = visible
    if (!isTauri() || !createdRef.current) return
    void browserClient
      .embedSetVisible(visible, rectRef.current ?? { x: 0, y: 0, width: 0, height: 0 })
      .catch(() => {})
  }, [visible])

  useEffect(() => {
    return () => {
      if (createdRef.current) void browserClient.embedDestroy().catch(() => {})
    }
  }, [])

  const getRect = useCallback(() => rectRef.current, [])

  const setVisible = useCallback(async (visible: boolean) => {
    if (!isTauri() || !createdRef.current) return
    await browserClient
      .embedSetVisible(visible, rectRef.current ?? { x: 0, y: 0, width: 0, height: 0 })
      .catch(() => {})
  }, [])

  return { getRect, setVisible }
}
