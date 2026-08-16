/**
 * Resolves the TUI composer's model-backed inline completion into the
 * provider-agnostic {@link InlineCompleteFn} the shared AI provider expects.
 *
 * This is the piece the CLI was missing entirely: the desktop composer could
 * predict a continuation with a model, and the TUI could only prefix-match its
 * own history. Everything downstream (prompting, PII gating, sanitising,
 * ranking, debouncing, caching) is already shared — the only CLI-specific
 * concern is *how you get an `LlmClient` here*, which is what this module owns.
 *
 * Two constraints shape it:
 *
 *  1. **Client resolution is async** (`getSession` reads Dexie) but completion
 *     is driven per keystroke. So the client is resolved ONCE, lazily, on the
 *     first completion, and the in-flight promise is shared by later calls.
 *  2. **A missing client is normal**, not an error — the user may have no
 *     renderer-side API key. `complete` returns null and the composer silently
 *     falls back to the local tier.
 *
 * Every collaborator is injectable so the resolution + caching logic tests
 * without Dexie, a provider, or a network.
 */

import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { getSession } from "@/lib/db/sessions"
import type { InlineCompleteFn } from "@/lib/chat/completion/inline/ai-provider"

import { ensureCliDb } from "../../db/bootstrap"
import type { ResolvedConfig } from "../../config/schema"
// `toBuildContext` directly, NOT `resolveAppSettings` from the goal controller:
// that wrapper is one line over this same call, but importing it would drag the
// goal runtime and its Dexie tables into the composer's keystroke path.
import { toBuildContext } from "../../config/to-build-context"

/** Telemetry-only feature id, matching the desktop composer's. */
export const COMPOSER_GHOST_FEATURE_ID = "composer-ghost"
/** A ghost is a phrase, not a paragraph. */
const MAX_GHOST_TOKENS = 48

export interface TuiInlineCompleteDeps {
  sessionId: string
  config: ResolvedConfig
  // ── injectable seams (default to the real impls; faked in tests) ──
  ensureDb?: () => Promise<unknown>
  getSession?: (id: string) => Promise<ChatSession | null | undefined>
  resolveSettings?: (sessionId: string, config: ResolvedConfig) => AppSettings | null
  buildClient?: (
    session: ChatSession | null | undefined,
    appSettings: AppSettings | null
  ) => LlmClient | null
}

/**
 * Build the completion function for the TUI's model tier.
 *
 * The returned function resolves its client on first use and caches the
 * outcome — including a null outcome, so a user without credentials does not
 * re-hit Dexie on every keystroke.
 */
export function createTuiInlineComplete(deps: TuiInlineCompleteDeps): InlineCompleteFn {
  const ensureDb = deps.ensureDb ?? (() => ensureCliDb())
  const loadSession = deps.getSession ?? getSession
  const resolveSettings =
    deps.resolveSettings ??
    ((sessionId, config) => toBuildContext({ sessionId, config }).appSettings ?? null)
  const buildClient =
    deps.buildClient ??
    ((session, appSettings) =>
      buildRendererLlmClient({
        session,
        appSettings,
        featureId: COMPOSER_GHOST_FEATURE_ID,
      }))

  let clientPromise: Promise<LlmClient | null> | null = null

  async function resolveClient(): Promise<LlmClient | null> {
    try {
      await ensureDb()
      const appSettings = resolveSettings(deps.sessionId, deps.config)
      const session = await loadSession(deps.sessionId)
      return buildClient(session, appSettings)
    } catch {
      // Unreadable db / unresolvable provider — the local tier still works.
      return null
    }
  }

  return async ({ system, prompt, signal }) => {
    // Share one resolution across concurrent keystrokes.
    clientPromise ??= resolveClient()
    const client = await clientPromise
    if (!client || signal.aborted) return null
    return client.complete(prompt, {
      system,
      temperature: 0.2,
      maxTokens: MAX_GHOST_TOKENS,
      abortSignal: signal,
    })
  }
}

/** Whether the model tier is switched on for this config (absent ⇒ off). */
export function isAiSuggestEnabled(config: ResolvedConfig): boolean {
  return config.autosuggest?.ai === true
}

/** Whether the local tier is switched on for this config (absent ⇒ on). */
export function isLocalSuggestEnabled(config: ResolvedConfig): boolean {
  return config.autosuggest?.local !== false
}
