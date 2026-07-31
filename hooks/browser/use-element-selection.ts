"use client"

import { useCallback, useEffect, useState } from "react"

import { browserClient } from "@/lib/browser/client"
import {
  BROWSER_EVENTS,
  type BrowserNavigated,
  type BrowserSelection,
  type BrowserSelectionSignal,
} from "@/lib/browser/protocol"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

export interface UseElementSelection {
  /** The most recently picked element, or null. */
  selection: BrowserSelection | null
  /** Every target in the most recent element/area/text pick. */
  selections: BrowserSelection[]
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
  const [selections, setSelections] = useState<BrowserSelection[]>([])
  const [navigated, setNavigated] = useState<BrowserNavigated | null>(null)
  const [selectMode, setSelectModeState] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let draining = false
    let handledGeneration = 0
    let pendingSignal: BrowserSelectionSignal | null = null
    const subs: Array<() => void> = []
    const add = async <T>(event: string, handler: (p: T) => void) => {
      const unlisten = await onTauriEvent<T>(event, handler)
      if (cancelled) unlisten()
      else subs.push(unlisten)
    }
    const drainPending = async () => {
      if (draining || !pendingSignal) return
      draining = true
      const signal = pendingSignal
      try {
        let drained: BrowserSelection[] | null = null
        let lastError: unknown
        for (const delay of [0, 50, 100, 200, 400]) {
          if (delay) await new Promise((resolve) => globalThis.setTimeout(resolve, delay))
          if (cancelled) return
          try {
            const candidate = await browserClient.embedDrainSelection()
            if (candidate.length < signal.count) throw new Error("incomplete selection drain")
            drained = candidate
            break
          } catch (error) {
            lastError = error
          }
        }
        if (!drained) throw lastError
        if (cancelled) return
        handledGeneration = Math.max(handledGeneration, signal.generation)
        setSelections(drained)
        setSelection(drained.at(-1) ?? null)
        setSelectModeState(false) // the overlay disarms itself after a pick
      } catch {
        // Keep the prior renderer state. The page buffer is intentionally left
        // intact and a restored document will re-signal it after navigation.
        if (!cancelled) setSelectModeState(false)
      } finally {
        draining = false
        if (pendingSignal === signal) pendingSignal = null
        if (!cancelled && pendingSignal) void drainPending()
      }
    }
    void add<BrowserSelectionSignal>(BROWSER_EVENTS.elementSelected, (signal) => {
      if (
        !Number.isSafeInteger(signal.count) ||
        signal.count < 1 ||
        signal.count > 20 ||
        !Number.isSafeInteger(signal.generation) ||
        signal.generation <= handledGeneration
      ) {
        return
      }
      if (!pendingSignal || signal.generation >= pendingSignal.generation) pendingSignal = signal
      void drainPending()
    })
    void add<BrowserNavigated>(BROWSER_EVENTS.navigated, (payload) => {
      handledGeneration = 0
      setNavigated(payload)
    })
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

  const clearSelection = useCallback(() => {
    setSelection(null)
    setSelections([])
  }, [])

  return { selection, selections, navigated, selectMode, setSelectMode, clearSelection }
}
