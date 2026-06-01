"use client"

/**
 * React hook wiring the terminal autocomplete `AutocompleteController` to
 * the settings + terminal stores and the LLM utility client (ADR-0039).
 *
 * It is intentionally thin — all the debounce / cancellation / line-model
 * logic lives in the (unit-tested) controller + engine. The hook:
 *  - reads the `terminal.autocomplete` settings reactively (enable / source
 *    / debounce),
 *  - registers the built-in history + AI providers once,
 *  - builds the per-query context from the focused session's store row,
 *  - exposes `feed` / `accept` / `dismiss` / `reset` for `terminal-instance`
 *    to drive from the xterm input + key handlers, plus the current ghost
 *    `view` to render.
 *
 * `accept()` returns the suffix the caller must write into the PTY — the
 * hook never executes anything itself.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { detectPlatform } from "@/lib/terminal/shell-detect"
import { AutocompleteController, type AutocompleteView } from "@/lib/terminal/completion/controller"
import {
  buildAutocompleteContext,
  ensureBuiltinCompletionProviders,
} from "@/lib/terminal/completion/builtins"
import type { AppSettings } from "@/lib/claude/types"
import type { TerminalCompletionSuggestion } from "@/lib/terminal/completion/types"

const MIN_DEBOUNCE = 50
const MAX_DEBOUNCE = 2000
const DEFAULT_DEBOUNCE = 350

type AutocompleteSettings = NonNullable<NonNullable<AppSettings["terminal"]>["autocomplete"]>

function readAutocompleteSettings(): AutocompleteSettings | undefined {
  return useSettingsStore.getState().settings?.terminal?.autocomplete
}

export interface UseTerminalAutocompleteResult {
  enabled: boolean
  ghost: string
  suggestion: TerminalCompletionSuggestion | null
  feed: (chunk: string) => void
  /** Accept the suggestion; returns the suffix to write into the PTY, or null. */
  accept: () => string | null
  dismiss: () => void
  reset: () => void
}

export function useTerminalAutocomplete(sessionId: string): UseTerminalAutocompleteResult {
  const ac = useSettingsStore(
    (s) => (s.settings?.terminal as NonNullable<AppSettings["terminal"]>)?.autocomplete
  )
  const enabled = !!ac?.enabled
  const debounceMs = Math.min(
    MAX_DEBOUNCE,
    Math.max(MIN_DEBOUNCE, ac?.debounceMs ?? DEFAULT_DEBOUNCE)
  )

  const [view, setView] = useState<AutocompleteView>({ ghost: "", suggestion: null })
  const controllerRef = useRef<AutocompleteController | null>(null)

  // Register the built-in providers once. `getSettings` / `buildClient` read
  // the stores lazily so live settings changes are respected.
  useEffect(() => {
    ensureBuiltinCompletionProviders({
      getSettings: () => readAutocompleteSettings(),
      buildClient: () =>
        buildUtilityLlmClient({
          session: null,
          appSettings: useSettingsStore.getState().settings,
          featureId: "terminal-autocomplete",
        }),
    })
  }, [])

  // (Re)build the controller per session / debounce.
  useEffect(() => {
    const controller = new AutocompleteController({
      debounceMs,
      getContext: (input) => {
        const row = useTerminalStore.getState().sessions[sessionId]
        if (!row) return null
        return buildAutocompleteContext({
          sessionId,
          shellPath: row.shell,
          cwd: row.cwd ?? null,
          recentCommands: (row.lastCommands ?? []).map((c) => c.cmd),
          input,
          platform: detectPlatform(),
        })
      },
      onChange: () => setView(controller.getView()),
    })
    controllerRef.current = controller
    return () => {
      controller.dispose()
      controllerRef.current = null
      setView({ ghost: "", suggestion: null })
    }
  }, [sessionId, debounceMs])

  // Clear any visible suggestion the moment the feature is switched off.
  useEffect(() => {
    if (!enabled) controllerRef.current?.dismiss()
  }, [enabled])

  const feed = useCallback(
    (chunk: string) => {
      if (!enabled) return
      controllerRef.current?.feed(chunk)
    },
    [enabled]
  )

  const accept = useCallback((): string | null => {
    if (!enabled) return null
    return controllerRef.current?.accept() ?? null
  }, [enabled])

  const dismiss = useCallback(() => controllerRef.current?.dismiss(), [])
  const reset = useCallback(() => controllerRef.current?.reset(), [])

  return { enabled, ghost: view.ghost, suggestion: view.suggestion, feed, accept, dismiss, reset }
}
