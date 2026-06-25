"use client"

import { type RefObject, useCallback, useEffect, useRef } from "react"

import { browserClient } from "@/lib/browser/client"
import type { ElementRect } from "@/lib/browser/protocol"
import { isTauri } from "@/lib/tauri"

import { useElementRect } from "./use-element-rect"

export interface UseBrowserPaneWebview {
  /** The reserved-div rect the native webview is tracking. */
  rect: ElementRect | null
  /** Show/hide the embedded webview (e.g. when an app modal overlaps it). */
  setVisible: (visible: boolean) => Promise<void>
}

/**
 * Owns the embedded preview webview's lifecycle: creates it over the reserved
 * `ref` div, keeps its bounds synced to that rect, navigates on url change, and
 * destroys it on unmount. The native webview floats above the React layer, so
 * positioning is entirely rect-driven (see {@link useElementRect}).
 */
export function useBrowserPaneWebview(
  ref: RefObject<HTMLElement | null>,
  options: { url: string | null }
): UseBrowserPaneWebview {
  const { url } = options
  const createdRef = useRef(false)
  const lastUrlRef = useRef<string | null>(null)

  const onRect = useCallback((next: ElementRect) => {
    if (!isTauri() || !createdRef.current) return
    void browserClient.embedSetBounds(next).catch(() => {})
  }, [])

  const rect = useElementRect(ref, onRect)

  // Create once the url and an initial rect are both known; navigate on later
  // url changes. Bounds tracking is handled by `onRect` above.
  useEffect(() => {
    if (!isTauri() || !url || !rect) return
    if (!createdRef.current) {
      createdRef.current = true
      lastUrlRef.current = url
      void browserClient.embedCreate(url, rect).catch(() => {
        createdRef.current = false
      })
    } else if (url !== lastUrlRef.current) {
      lastUrlRef.current = url
      void browserClient.embedNavigate(url).catch(() => {})
    }
  }, [url, rect])

  useEffect(() => {
    return () => {
      if (createdRef.current) void browserClient.embedDestroy().catch(() => {})
    }
  }, [])

  const setVisible = useCallback(
    async (visible: boolean) => {
      if (!isTauri() || !createdRef.current) return
      await browserClient
        .embedSetVisible(visible, rect ?? { x: 0, y: 0, width: 0, height: 0 })
        .catch(() => {})
    },
    [rect]
  )

  return { rect, setVisible }
}
