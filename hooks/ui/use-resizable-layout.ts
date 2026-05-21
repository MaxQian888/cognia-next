"use client"

/**
 * useResizableLayout
 *
 * Bridges `react-resizable-panels` v4's stateful layout API (Layout +
 * onLayoutChanged) with a localStorage cell so a `ResizablePanelGroup` can
 * "remember" its splits across reloads. v4 removed the previous-version
 * `autoSaveId` shortcut, so callers either roll their own persistence or
 * accept the default-on-every-load layout — this hook does the former.
 */

import { useCallback, useMemo, useRef, useState } from "react"

export type Layout = Record<string, number>

export interface UseResizableLayoutResult {
  defaultLayout: Layout | undefined
  onLayoutChanged: (next: Layout) => void
}

function readLayout(storageKey: string): Layout | undefined {
  if (typeof window === "undefined") return undefined
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return undefined
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return undefined
    const out: Layout = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v
    }
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

function writeLayout(storageKey: string, layout: Layout): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(layout))
  } catch {
    // storage may be unavailable (private mode, quota); ignore
  }
}

export function useResizableLayout(storageKey: string): UseResizableLayoutResult {
  // Read once at mount — subsequent state lives inside the resizable group;
  // we only persist downstream changes.
  const [seed] = useState<Layout | undefined>(() => readLayout(storageKey))
  const lastWrittenRef = useRef<string>(seed ? JSON.stringify(seed) : "")

  const onLayoutChanged = useCallback(
    (next: Layout) => {
      const serialized = JSON.stringify(next)
      if (serialized === lastWrittenRef.current) return
      lastWrittenRef.current = serialized
      writeLayout(storageKey, next)
    },
    [storageKey]
  )

  return useMemo(() => ({ defaultLayout: seed, onLayoutChanged }), [seed, onLayoutChanged])
}
