"use client"

import { useCallback, useEffect, useState } from "react"

import type {
  BrowserNavigated,
  BrowserSelection,
  BrowserSelectionSignal,
} from "@/lib/browser/protocol"
import {
  embeddedSelectionSource,
  type ElementSelectionSource,
} from "@/lib/browser/selection-source"
import { isTauri } from "@/lib/tauri"

const NO_SELECTIONS: BrowserSelection[] = []

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
   * The engine the page runs in. Defaults to the embedded webview; a local
   * Chromium pane passes {@link localSelectionSource} for the page it shows.
   * Keep it referentially stable: a new source re-subscribes.
   */
  source?: ElementSelectionSource
  /**
   * Whether this pane owns the page's pick channel. Defaults to true.
   *
   * A drain empties a buffer that lives in the page, so it is a one-shot
   * read: with two panes mounted, both wake on the same signal, both drain,
   * and the loser burns its five retries before silently dropping the pick.
   * Only the lease holder (embedded) or the pane showing the page (Chromium)
   * may subscribe.
   */
  enabled?: boolean
}

/**
 * Subscribes to a pane's pick signals and exposes the picker toggle. The
 * embedded source's teardown tolerates the StrictMode mount→unmount→mount
 * unlisten race.
 */
export function useElementSelection(options: UseElementSelectionOptions = {}): UseElementSelection {
  const source = options.source ?? embeddedSelectionSource
  const enabled = options.enabled !== false
  // Picks and the armed state belong to the source (the page) they came
  // from: a pane that moves to another page starts with neither.
  const [picks, setPicks] = useState<{
    source: ElementSelectionSource
    selections: BrowserSelection[]
  } | null>(null)
  const [navigated, setNavigated] = useState<BrowserNavigated | null>(null)
  const [armedSource, setArmedSource] = useState<ElementSelectionSource | null>(null)
  const selections = picks?.source === source ? picks.selections : NO_SELECTIONS
  const selection = selections.at(-1) ?? null
  const selectMode = armedSource === source

  useEffect(() => {
    if (!isTauri() || !enabled) return
    let cancelled = false
    let draining = false
    let handledGeneration = 0
    let pendingSignal: BrowserSelectionSignal | null = null
    let unsubscribe: (() => void) | null = null
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
            const candidate = await source.drain()
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
        setPicks({ source, selections: drained })
        setArmedSource(null) // the overlay disarms itself after a pick
      } catch {
        // Keep the prior renderer state. The page buffer is intentionally left
        // intact and a restored document will re-signal it after navigation.
        if (!cancelled) setArmedSource(null)
      } finally {
        draining = false
        if (pendingSignal === signal) pendingSignal = null
        if (!cancelled && pendingSignal) void drainPending()
      }
    }
    const onSignal = (signal: BrowserSelectionSignal) => {
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
    }
    const onNavigated = (payload: BrowserNavigated) => {
      handledGeneration = 0
      setNavigated(payload)
    }
    void source
      .subscribe({ onSignal, onNavigated })
      .then((stop) => {
        if (cancelled) stop()
        else unsubscribe = stop
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [enabled, source])

  const setSelectMode = useCallback(
    async (on: boolean) => {
      await source.setSelectMode(on)
      setArmedSource(on ? source : null)
    },
    [source]
  )

  const clearSelection = useCallback(() => setPicks(null), [])

  return { selection, selections, navigated, selectMode, setSelectMode, clearSelection }
}
