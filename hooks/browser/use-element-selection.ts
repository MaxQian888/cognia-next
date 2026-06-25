"use client"

import { useCallback, useEffect, useState } from "react"

import { browserClient } from "@/lib/browser/client"
import {
  BROWSER_EVENTS,
  type BrowserNavigated,
  type BrowserSelection,
} from "@/lib/browser/protocol"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

export interface UseElementSelection {
  /** The most recently picked element, or null. */
  selection: BrowserSelection | null
  /** The latest top-level navigation of the preview, or null. */
  navigated: BrowserNavigated | null
  /** Whether the in-page picker is armed. */
  selectMode: boolean
  /** Arm/disarm the in-page picker (drives the injected overlay). */
  setSelectMode: (on: boolean) => Promise<void>
  clearSelection: () => void
}

export interface UseElementSelectionOptions {
  /**
   * Drives the in-page picker on/off. Defaults to the embedded-pane command;
   * callers may inject a different driver.
   */
  driver?: (on: boolean) => Promise<void>
}

/**
 * Subscribes to the in-app browser's Rust-emitted events and exposes the
 * picker toggle. Teardown uses {@link safeUnlisten} to tolerate the StrictMode
 * mount→unmount→mount unlisten race.
 */
export function useElementSelection(options: UseElementSelectionOptions = {}): UseElementSelection {
  const driver = options.driver ?? browserClient.embedSetSelectMode
  const [selection, setSelection] = useState<BrowserSelection | null>(null)
  const [navigated, setNavigated] = useState<BrowserNavigated | null>(null)
  const [selectMode, setSelectModeState] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    const subs: Array<() => void> = []
    const add = async <T>(event: string, handler: (p: T) => void) => {
      const unlisten = await onTauriEvent<T>(event, handler)
      if (cancelled) unlisten()
      else subs.push(unlisten)
    }
    void add<BrowserSelection>(BROWSER_EVENTS.elementSelected, (payload) => {
      setSelection(payload)
      setSelectModeState(false) // the overlay disarms itself after a pick
    })
    void add<BrowserNavigated>(BROWSER_EVENTS.navigated, (payload) => setNavigated(payload))
    return () => {
      cancelled = true
      for (const unlisten of subs) safeUnlisten(unlisten)
    }
  }, [])

  const setSelectMode = useCallback(
    async (on: boolean) => {
      await driver(on)
      setSelectModeState(on)
    },
    [driver]
  )

  const clearSelection = useCallback(() => setSelection(null), [])

  return { selection, navigated, selectMode, setSelectMode, clearSelection }
}
