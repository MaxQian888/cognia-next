"use client"

/**
 * React hook wiring the composer's inline autocomplete: it owns an
 * {@link InlineCompletionEngine} and feeds it from the composer's value.
 *
 * The engine runs two tiers (see `lib/chat/completion/inline/engine.ts`):
 *
 *   - **local** — per-session input history + slash-command names. Free,
 *     instant, on by default. This is why the composer now completes at all
 *     when no model is configured; previously `ghostText.enabled` was the only
 *     switch and it gated *everything*, so the default-off setting meant the
 *     feature simply did not exist for most users.
 *   - **model** — a debounced LLM continuation resolved through the renderer
 *     utility client and gated by `hasNoLeakingPii`. Opt-in, because it bills.
 *   - **agent** — one real agent turn, run only when the user asks for it
 *     (`requestManual`, bound to a key by the composer). This tier exists
 *     because the model tier above is unreachable for most users: it needs an
 *     API key visible to the RENDERER, and a Claude subscription keeps its
 *     bearer in the keyring / sidecar (ADR-0025). So a user who switched the
 *     model tier on got silence. The agent turn runs where the credentials
 *     live, which also means it works for every provider AND every external
 *     agent the session might be bound to, with no per-agent adapter —
 *     `resolveSendOptions` inside `buildHeadlessTurnLlmClient` already resolves
 *     provider, runtime and credentials. It is `manual` rather than debounced
 *     because one agent turn per typing burst is the wrong cost shape.
 *
 * Thin by design — debounce / cancellation / cache / ranking / cycling all live
 * in the unit-tested engine. The hook builds providers from settings, supplies
 * live context via refs (so history and command changes are picked up without
 * rebuilding the engine), and exposes `feed` / `accept` / `cycle*` / `dismiss`.
 * `accept()` returns the new textarea value — it never submits.
 *
 * The TUI cousin is `cli/src/tui/input/inline-suggest.ts`; both consume the
 * same engine and providers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useSessionVisibleMessages } from "@/stores/chat/chat-store"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { buildHeadlessTurnLlmClient, canRunHeadlessTurn } from "@/lib/ai/headless-turn-llm-client"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { InlineCompletionEngine, type InlineEngineView } from "@/lib/chat/completion/inline/engine"
import { createHistoryProvider } from "@/lib/chat/completion/inline/history-provider"
import { createCommandProvider } from "@/lib/chat/completion/inline/command-provider"
import {
  createAgentCompletionProvider,
  createAiCompletionProvider,
} from "@/lib/chat/completion/inline/ai-provider"
import type {
  InlineCommandInfo,
  InlineCompletionProvider,
  InlineSuggestion,
} from "@/lib/chat/completion/inline/types"
import type { GhostMessage } from "@/lib/chat/completion/ghost-prompt"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import { stripPromptPreambleFromParts } from "@/lib/chat/prompt-preamble"

const MIN_DEBOUNCE = 200
const MAX_DEBOUNCE = 2000
const DEFAULT_DEBOUNCE = 500
/** How many recent turns are fed to the model as continuity context. */
const RECENT = 6
/** Tokens requested for a continuation — a ghost is a phrase, not a paragraph. */
const MAX_GHOST_TOKENS = 48
/** Broker lease label for the agent tier, i.e. what it shows up as in the runs console. */
const AGENT_TURN_LABEL = "Composer completion"

function recentMessages(msgs: ReturnType<typeof useSessionVisibleMessages>): GhostMessage[] {
  return msgs.slice(-RECENT).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    // Typed text: a suggestion keys off what was said, not off the context the
    // composer attached (and a page of web results is a lot of tokens to pay
    // for a one-line suggestion).
    text: extractPlainText(stripPromptPreambleFromParts(m.parts)),
  }))
}

const EMPTY_VIEW: InlineEngineView = {
  ghost: "",
  suggestion: null,
  candidates: [],
  index: 0,
  pending: false,
  querying: false,
  streaming: false,
  completionError: false,
  manualAvailable: false,
  manualPending: false,
}

export interface UseComposerGhostTextOptions {
  session: ChatSession | null | undefined
  /** Previously sent messages for this session, NEWEST FIRST. */
  history: readonly string[]
  /** Slash commands offered by this composer. */
  commands: readonly InlineCommandInfo[]
}

export interface UseComposerGhostTextResult {
  /** True when at least one completion source is active. */
  enabled: boolean
  /** Dim text to paint after the caret. */
  ghost: string
  /** The active suggestion — carries the source badge shown beside the ghost. */
  suggestion: InlineSuggestion | null
  /** All ranked candidates the user can cycle through. */
  candidates: readonly InlineSuggestion[]
  /** Index of the active candidate. */
  index: number
  /** True while a model query is armed or in flight. */
  pending: boolean
  /** True while a model-tier call is actually in flight (post-debounce). */
  querying: boolean
  /** True while the active candidate is still receiving streamed tokens. */
  streaming: boolean
  /** The latest model round failed or timed out — show a retry affordance. */
  completionError: boolean
  /**
   * True when an agent turn is reachable, i.e. `requestManual` will do
   * something. False in a pure-web tab with no paired companion, where there
   * is no transport to carry a turn.
   */
  manualAvailable: boolean
  /** True while the requested agent turn is running. */
  manualPending: boolean
  /** Ask the agent tier for a continuation now. Bound to a key by the composer. */
  requestManual: () => void
  /** Re-run whichever model tier failed — the card's retry affordance. */
  retry: () => void
  feed: (value: string, opts?: { suppress?: boolean }) => void
  /** Accept the active suggestion; returns the new full textarea value, or null. */
  accept: () => string | null
  cycleNext: () => void
  cyclePrev: () => void
  /** Jump straight to a candidate — the card's candidate dots call this. */
  cycleTo: (index: number) => void
  dismiss: () => void
}

export function useComposerGhostText(
  options: UseComposerGhostTextOptions
): UseComposerGhostTextResult {
  const { session, history, commands } = options
  const settings = useSettingsStore((s) => s.settings)
  const ghostSettings = settings?.composerAssistance?.ghostText
  const visibleMessages = useSessionVisibleMessages(session?.id ?? null)
  // A prediction belongs to a specific transcript and model configuration. A
  // fresh engine drops its draft-keyed cache and aborts the previous request.
  const contextKey = JSON.stringify([
    session?.id,
    session?.transcriptRevision,
    visibleMessages.map((message) => [message.id, message.parts]),
    session?.model,
    session?.providerOverride,
    session?.accountId,
    session?.characterId,
    settings?.composerAssistance?.model,
    settings?.defaultProvider,
    settings?.defaultModel,
  ])
  // The model tier stays opt-in (it bills); the local tier is opt-out.
  const aiEnabled = ghostSettings?.enabled === true
  const localEnabled = ghostSettings?.local !== false
  const enabled = aiEnabled || localEnabled
  const debounceMs = Math.min(
    MAX_DEBOUNCE,
    Math.max(MIN_DEBOUNCE, ghostSettings?.debounceMs ?? DEFAULT_DEBOUNCE)
  )
  const maxCandidates = ghostSettings?.maxCandidates

  const contextIdentity = useMemo(
    () => ({
      key: contextKey,
      providers: settings?.providerSettings,
      customProviders: settings?.customProviders,
      modelMappings: settings?.modelMappings,
      debounceMs,
      maxCandidates,
      localEnabled,
      aiEnabled,
    }),
    [
      contextKey,
      settings?.providerSettings,
      settings?.customProviders,
      settings?.modelMappings,
      debounceMs,
      maxCandidates,
      localEnabled,
      aiEnabled,
    ]
  )
  const [ownedView, setView] = useState({ context: contextIdentity, view: EMPTY_VIEW })
  const engineRef = useRef<InlineCompletionEngine | null>(null)
  const sessionId = session?.id ?? null
  const lastInputRef = useRef<{
    sessionId: string | null
    value: string
    suppress?: boolean
  } | null>(null)
  // Whether a turn can be carried at all — Tauri, or a web tab with a paired
  // companion. Read once: it is a property of the shell, not of React state,
  // and re-reading it per render would rebuild the engine on every pass.
  const [agentTierReachable] = useState(() => canRunHeadlessTurn())

  // Live context, read at query time. Kept in refs so a new history entry or a
  // freshly registered plugin command does NOT tear down and rebuild the
  // engine (which would drop the in-flight query and the suggestion cache).
  const historyRef = useRef(history)
  const commandsRef = useRef(commands)
  const sessionRef = useRef(session)
  const messagesRef = useRef(visibleMessages)
  // Synced after commit, never during render. Declared BEFORE the engine effect
  // so it lands first on every pass.
  useEffect(() => {
    historyRef.current = history
    commandsRef.current = commands
    sessionRef.current = session
    messagesRef.current = visibleMessages
  })

  useEffect(() => {
    // Providers are built here rather than in a `useMemo` so the model
    // provider's closure — which reads the latest-session ref — is never
    // constructed during render.
    const providers: InlineCompletionProvider[] = []
    if (localEnabled) {
      // The textarea wraps, so a multi-line completion renders correctly here
      // (unlike the TUI's single inline row).
      providers.push(createHistoryProvider({ allowMultiline: true }))
      providers.push(createCommandProvider())
    }
    if (aiEnabled) {
      // Client resolution stays inside the call (not memoised) so a settings
      // change is picked up by the next query without rebuilding the engine.
      const callOptions = (system: string, signal: AbortSignal) => ({
        system,
        temperature: 0.2,
        maxTokens: MAX_GHOST_TOKENS,
        abortSignal: signal,
      })
      const buildClient = () => {
        const settings = useSettingsStore.getState().settings as AppSettings | undefined
        return buildUtilityLlmClient({
          session: sessionRef.current ?? null,
          appSettings: settings,
          override: settings?.composerAssistance?.model,
          featureId: "composer-ghost",
        })
      }
      providers.push(
        createAiCompletionProvider({
          complete: async ({ system, prompt, signal }) => {
            const client = buildClient()
            if (!client) return null
            return client.complete(prompt, callOptions(system, signal))
          },
          // `stream` exists on production clients (`createLlmClient` /
          // `ledgerUtilityCalls` forwards it) but not on sidecar-only
          // protocols — returning null there falls back to `complete`.
          stream: ({ system, prompt, signal }) =>
            buildClient()?.stream?.(prompt, callOptions(system, signal)) ?? null,
        })
      )
    }
    if (aiEnabled && agentTierReachable) {
      // The manual tier. Note it is added whether or not the direct client
      // above resolved: with a BYOK key the user gets the cheap debounced
      // answer for free AND can still ask for a considered one, and `agent`
      // outranks `ai` so the answer they asked for wins.
      providers.push(
        createAgentCompletionProvider({
          complete: async ({ system, prompt, signal }) => {
            const client = buildHeadlessTurnLlmClient({
              session: sessionRef.current ?? null,
              label: AGENT_TURN_LABEL,
            })
            if (!client) return null
            return client.complete(prompt, {
              system,
              temperature: 0.2,
              maxTokens: MAX_GHOST_TOKENS,
              abortSignal: signal,
            })
          },
          // The agent turn streams via `deltasFromRunningTotal` — partial
          // assistant text forwarded as it accumulates.
          stream: ({ system, prompt, signal }) =>
            buildHeadlessTurnLlmClient({
              session: sessionRef.current ?? null,
              label: AGENT_TURN_LABEL,
            })?.stream?.(prompt, {
              system,
              temperature: 0.2,
              maxTokens: MAX_GHOST_TOKENS,
              abortSignal: signal,
            }) ?? null,
        })
      )
    }
    if (providers.length === 0) {
      engineRef.current = null
      return
    }
    const engine = new InlineCompletionEngine({
      providers,
      maxCandidates,
      debounceMs,
      buildContext: (draft) => ({
        draft,
        caret: draft.length,
        history: historyRef.current,
        commands: commandsRef.current,
        recentMessages: recentMessages(messagesRef.current),
        surface: "gui",
        sessionId,
      }),
      onChange: () => {
        const view = engineRef.current?.getView() ?? EMPTY_VIEW
        // The engine reuses its empty view to make redundant feeds a no-op.
        // Preserve that bailout while attaching the owning context identity.
        setView((current) =>
          current.context === contextIdentity && current.view === view
            ? current
            : { context: contextIdentity, view }
        )
      },
    })
    engineRef.current = engine
    // A model/branch change invalidates predictions, but the draft itself has
    // not changed, so the composer's value effect will not feed it again.
    // Restore only this session's last feed, including IME/popup suppression.
    const lastInput = lastInputRef.current
    if (lastInput?.sessionId === sessionId) {
      engine.feed(lastInput.value, { suppress: lastInput.suppress })
    }
    return () => {
      engine.dispose()
      engineRef.current = null
      setView({ context: contextIdentity, view: EMPTY_VIEW })
    }
    // `session` identity is keyed by id; the tier flags rebuild the providers.
  }, [
    sessionId,
    contextIdentity,
    debounceMs,
    maxCandidates,
    localEnabled,
    aiEnabled,
    agentTierReachable,
    settings?.providerSettings,
    settings?.customProviders,
    settings?.modelMappings,
  ])

  // Derived, not stored: with every tier off there is no engine to clear the
  // view, and resetting it from an effect would be a cascading render.
  const view = enabled && ownedView.context === contextIdentity ? ownedView.view : EMPTY_VIEW

  const feed = useCallback(
    (value: string, opts?: { suppress?: boolean }) => {
      lastInputRef.current = { sessionId, value, suppress: opts?.suppress }
      engineRef.current?.feed(value, opts)
    },
    [sessionId]
  )

  const accept = useCallback(
    (): string | null =>
      ownedView.context === contextIdentity ? (engineRef.current?.accept() ?? null) : null,
    [ownedView.context, contextIdentity]
  )
  const requestManual = useCallback(() => engineRef.current?.requestManual(), [])
  const retry = useCallback(() => engineRef.current?.retry(), [])
  const cycleNext = useCallback(() => engineRef.current?.cycleNext(), [])
  const cyclePrev = useCallback(() => engineRef.current?.cyclePrev(), [])
  const cycleTo = useCallback((index: number) => engineRef.current?.cycleTo(index), [])
  const dismiss = useCallback(() => engineRef.current?.dismiss(), [])

  return {
    enabled,
    ghost: view.ghost,
    suggestion: view.suggestion,
    candidates: view.candidates,
    index: view.index,
    pending: view.pending,
    querying: view.querying,
    streaming: view.streaming,
    completionError: view.completionError,
    manualAvailable: view.manualAvailable,
    manualPending: view.manualPending,
    requestManual,
    retry,
    feed,
    accept,
    cycleNext,
    cyclePrev,
    cycleTo,
    dismiss,
  }
}
