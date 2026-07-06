"use client"

/**
 * Auto-trigger canvas AI suggestions after the user pauses typing, honoring the
 * `autoSuggestions` + `suggestionDelay` settings (Settings → Canvas → AI).
 *
 * Debounces on content change: each edit resets a `suggestionDelay` timer and
 * only fires once typing settles. The first content seen for a given document
 * is treated as a prime (no fire) so merely opening or switching documents
 * doesn't kick off an LLM call — auto-suggestions follow actual edits.
 */

import { useEffect, useRef } from "react"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"

export interface UseAutoSuggestionsOptions {
  /** Master gate — false while processing, on mobile, with no active doc, or feature-flagged off. */
  enabled: boolean
  /** Active document id; a change re-primes the debounce so opens don't fire. */
  documentId: string
  /** Active document content; a change (within the same doc) schedules a trigger. */
  content: string
  /** Called after the debounce settles. */
  trigger: () => void
}

export function useAutoSuggestions({
  enabled,
  documentId,
  content,
  trigger,
}: UseAutoSuggestionsOptions): void {
  const autoSuggestions = useCanvasSettingsStore((s) => s.settings.ai.autoSuggestions)
  const delay = useCanvasSettingsStore((s) => s.settings.ai.suggestionDelay)
  const triggerRef = useRef(trigger)
  useEffect(() => {
    triggerRef.current = trigger
  }, [trigger])
  const seenDocRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !autoSuggestions) return
    // Prime on first content for this document — don't fire on open / switch.
    if (seenDocRef.current !== documentId) {
      seenDocRef.current = documentId
      return
    }
    const id = setTimeout(() => triggerRef.current(), Math.max(100, delay))
    return () => clearTimeout(id)
  }, [enabled, autoSuggestions, delay, documentId, content])
}

export default useAutoSuggestions
