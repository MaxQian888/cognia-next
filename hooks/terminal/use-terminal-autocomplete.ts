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
 * `accept()` / `acceptSelected()` return the PTY edit (backspaces + text)
 * the caller must apply — the hook never executes anything itself.
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
import type { AcceptEdit, TerminalCompletionSuggestion } from "@/lib/terminal/completion/types"

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
  ghostSuggestion: TerminalCompletionSuggestion | null
  /** Whether the candidate popup is open (and has candidates to show). */
  listOpen: boolean
  candidates: TerminalCompletionSuggestion[]
  selectedIndex: number
  feed: (chunk: string) => void
  /** Accept the ghost suggestion; returns the PTY edit to apply, or null. */
  accept: () => AcceptEdit | null
  /** Accept the highlighted popup candidate. */
  acceptSelected: () => AcceptEdit | null
  openList: () => void
  closeList: () => void
  moveSelection: (delta: number) => void
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

  const [view, setView] = useState<AutocompleteView>({
    ghost: "",
    ghostSuggestion: null,
    listOpen: false,
    candidates: [],
    selectedIndex: 0,
  })
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
          projectId: row.projectId ?? null,
        })
      },
      onChange: () => setView(controller.getView()),
    })
    controllerRef.current = controller
    return () => {
      controller.dispose()
      controllerRef.current = null
      setView({
        ghost: "",
        ghostSuggestion: null,
        listOpen: false,
        candidates: [],
        selectedIndex: 0,
      })
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

  const accept = useCallback((): AcceptEdit | null => {
    if (!enabled) return null
    return controllerRef.current?.accept() ?? null
  }, [enabled])

  const acceptSelected = useCallback((): AcceptEdit | null => {
    if (!enabled) return null
    return controllerRef.current?.acceptSelected() ?? null
  }, [enabled])

  const openList = useCallback(() => {
    if (!enabled) return
    controllerRef.current?.openList()
  }, [enabled])

  const closeList = useCallback(() => controllerRef.current?.closeList(), [])
  const moveSelection = useCallback(
    (delta: number) => controllerRef.current?.moveSelection(delta),
    []
  )
  const dismiss = useCallback(() => controllerRef.current?.dismiss(), [])
  const reset = useCallback(() => controllerRef.current?.reset(), [])

  return {
    enabled,
    ghost: view.ghost,
    ghostSuggestion: view.ghostSuggestion,
    listOpen: view.listOpen,
    candidates: view.candidates,
    selectedIndex: view.selectedIndex,
    feed,
    accept,
    acceptSelected,
    openList,
    closeList,
    moveSelection,
    dismiss,
    reset,
  }
}
