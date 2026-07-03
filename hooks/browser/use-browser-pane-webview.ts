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
  const { url, onRectChange } = options
  const createdRef = useRef(false)
  const lastUrlRef = useRef<string | null>(null)
  const rectRef = useRef<ElementRect | null>(null)
  const urlRef = useRef(url)
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
      void browserClient.embedCreate(target, rect).catch(() => {
        createdRef.current = false
      })
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
      if (createdRef.current) void browserClient.embedSetBounds(next).catch(() => {})
      else sync()
    },
    [sync]
  )

  useElementRect(ref, onRect, { trackState: false })

  useEffect(() => {
    urlRef.current = url
    sync()
  }, [url, sync])

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
