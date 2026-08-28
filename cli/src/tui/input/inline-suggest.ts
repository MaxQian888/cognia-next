/**
 * The TUI composer's inline ghost-text autosuggest.
 *
 * Replaces the original `autosuggest.ts`, which scanned history for the first
 * entry starting with the buffer and returned its tail. That was the whole
 * feature: no ranking, no frequency, no case tolerance, no alternatives, and —
 * most importantly — no way for a model to contribute, so the CLI composer
 * could only ever repeat something the user had already typed verbatim.
 *
 * This hook owns an {@link InlineCompletionEngine} configured with the same
 * providers the desktop composer uses, so both surfaces rank identically:
 *
 *   - history + slash commands (local, instant, free);
 *   - an optional model continuation (debounced, cancellable, cached);
 *   - an optional agent turn, run only when the user presses the key.
 *
 * That third tier is not a luxury: the model tier needs an API key readable
 * from settings, and a Claude subscription keeps its bearer in the keyring, so
 * for most users it silently produces nothing. A headless turn runs where the
 * credentials are — which is also why it works for whatever provider or
 * external agent the session is bound to, with no per-agent adapter.
 *
 * The engine is React-free and separately unit-tested; this file is only the
 * Ink-side glue — build providers from config, feed the buffer, expose the
 * view. Gating (cursor at end, popup open, composer disabled, multi-line
 * draft) stays with the caller, which is the only place that knows it.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { InlineCompletionEngine, type InlineEngineView } from "@/lib/chat/completion/inline/engine"
import { createHistoryProvider } from "@/lib/chat/completion/inline/history-provider"
import { createCommandProvider } from "@/lib/chat/completion/inline/command-provider"
import {
  createAgentCompletionProvider,
  createAiCompletionProvider,
  type InlineCompleteFn,
} from "@/lib/chat/completion/inline/ai-provider"
import type {
  InlineCommandInfo,
  InlineCompletionProvider,
  InlineSuggestion,
} from "@/lib/chat/completion/inline/types"

const MIN_DEBOUNCE = 200
const MAX_DEBOUNCE = 2000
const DEFAULT_DEBOUNCE = 500

const EMPTY_VIEW: InlineEngineView = {
  ghost: "",
  suggestion: null,
  candidates: [],
  index: 0,
  pending: false,
  manualAvailable: false,
  manualPending: false,
}

export interface UseInlineSuggestOptions {
  /** The composer's current text. */
  text: string
  /**
   * True when nothing should be suggested right now — the cursor is not at the
   * end, a `/`/`@` popup owns input, the composer is disabled, or the draft is
   * multi-line (the TUI paints the ghost on one row).
   */
  suppress: boolean
  /**
   * Submitted lines from the reducer's history ring, OLDEST FIRST — the order
   * `InputState.history.entries` is stored in. Reversed internally, so callers
   * pass the ring as-is and cannot get the recency signal backwards.
   */
  history: readonly string[]
  /**
   * Slash commands available in the palette.
   *
   * Accepts a getter as well as an array, because the command registry is
   * populated asynchronously: custom/project commands are discovered from disk
   * and plugin commands register with their plugin, both AFTER this component
   * first renders. An array captured at mount therefore freezes the set for the
   * whole session, and the ghost text ends up disagreeing with the palette,
   * which re-reads the registry on every open. A getter is resolved at query
   * time, so it cannot go stale.
   */
  commands: readonly InlineCommandInfo[] | (() => readonly InlineCommandInfo[])
  /** Local history/command completion. Default true. */
  localEnabled?: boolean
  /** Model completion. Omit or pass null to run local-only. */
  aiComplete?: InlineCompleteFn | null
  /**
   * Agent-turn completion, run ONLY from {@link UseInlineSuggestResult.requestManual}.
   * Omit or pass null to leave the tier off.
   */
  agentComplete?: InlineCompleteFn | null
  /** Debounce before querying the model, ms. Clamped [200, 2000]. */
  debounceMs?: number
  sessionId?: string
  cwd?: string
}

export interface UseInlineSuggestResult {
  /** Dim tail to paint after the cursor. Empty when nothing is suggested. */
  ghost: string
  /** The active suggestion — carries the source badge. */
  suggestion: InlineSuggestion | null
  /** All ranked candidates. */
  candidates: readonly InlineSuggestion[]
  /** Index of the active candidate. */
  index: number
  /** True while a model query is in flight. */
  pending: boolean
  /** True when the agent tier is registered, i.e. its key is worth advertising. */
  manualAvailable: boolean
  /** True while the requested agent turn is running. */
  manualPending: boolean
  /** Ask the agent tier for a continuation now. No-op when the tier is off. */
  requestManual: () => void
  /** Accept the active suggestion; returns the new full buffer text, or null. */
  accept: () => string | null
  cycleNext: () => void
  cyclePrev: () => void
  dismiss: () => void
}

export function useInlineSuggest(options: UseInlineSuggestOptions): UseInlineSuggestResult {
  const {
    text,
    suppress,
    history,
    commands,
    localEnabled = true,
    aiComplete,
    agentComplete,
    debounceMs,
    sessionId,
    cwd,
  } = options

  const [rawView, setView] = useState<InlineEngineView>(EMPTY_VIEW)
  const engineRef = useRef<InlineCompletionEngine | null>(null)

  // Live context read at query time. Refs keep history/command churn from
  // tearing down the engine (which would drop its cache and in-flight query).
  const historyRef = useRef(history)
  const commandsRef = useRef(commands)
  // Synced after commit, never during render. Declared BEFORE the engine
  // effect so it lands first on every pass.
  useEffect(() => {
    historyRef.current = history
    commandsRef.current = commands
  })

  const clampedDebounce = Math.min(
    MAX_DEBOUNCE,
    Math.max(MIN_DEBOUNCE, debounceMs ?? DEFAULT_DEBOUNCE)
  )
  const active = localEnabled || !!aiComplete || !!agentComplete

  useEffect(() => {
    // Providers are built inside the effect (not a `useMemo`) so no closure
    // over the latest-context refs is ever constructed during render.
    const providers: InlineCompletionProvider[] = []
    if (localEnabled) {
      // No `allowMultiline`: the ghost is painted on the cursor's row, so a
      // completion containing a newline would corrupt the composer layout.
      providers.push(createHistoryProvider())
      providers.push(createCommandProvider())
    }
    if (aiComplete) providers.push(createAiCompletionProvider({ complete: aiComplete }))
    if (agentComplete) providers.push(createAgentCompletionProvider({ complete: agentComplete }))
    if (providers.length === 0) {
      engineRef.current = null
      return
    }
    const engine = new InlineCompletionEngine({
      providers,
      debounceMs: clampedDebounce,
      buildContext: (draft) => ({
        draft,
        caret: draft.length,
        // The ring is oldest-first; the providers want newest-first.
        history: [...historyRef.current].reverse(),
        commands:
          typeof commandsRef.current === "function" ? commandsRef.current() : commandsRef.current,
        surface: "tui",
        sessionId,
        cwd,
      }),
      onChange: () => setView(engineRef.current?.getView() ?? EMPTY_VIEW),
    })
    engineRef.current = engine
    return () => {
      engine.dispose()
      engineRef.current = null
      setView(EMPTY_VIEW)
    }
  }, [localEnabled, aiComplete, agentComplete, clampedDebounce, sessionId, cwd])

  // Derived, not stored: with both tiers off there is no engine to clear the
  // view, and resetting it from an effect would be a cascading render.
  const view = active ? rawView : EMPTY_VIEW

  // Drive the engine off the buffer. The engine debounces the model tier and
  // only the latest feed is ever queried, so feeding on every render is safe.
  useEffect(() => {
    engineRef.current?.feed(text, { suppress })
  }, [text, suppress])

  const accept = useCallback((): string | null => engineRef.current?.accept() ?? null, [])
  const cycleNext = useCallback(() => engineRef.current?.cycleNext(), [])
  const cyclePrev = useCallback(() => engineRef.current?.cyclePrev(), [])
  const dismiss = useCallback(() => engineRef.current?.dismiss(), [])
  const requestManual = useCallback(() => engineRef.current?.requestManual(), [])

  return {
    manualAvailable: view.manualAvailable,
    manualPending: view.manualPending,
    requestManual,
    ghost: view.ghost,
    suggestion: view.suggestion,
    candidates: view.candidates,
    index: view.index,
    pending: view.pending,
    accept,
    cycleNext,
    cyclePrev,
    dismiss,
  }
}
