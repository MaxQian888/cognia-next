/**
 * Renderer-side judge LLM client factory for the `/goal` subsystem (ADR-0019).
 *
 * The turn driver's judge (`lib/goal/judge.ts`) runs a direct `ai`-SDK call
 * from the renderer — it does NOT go through the sidecar like the main chat
 * turn does. So unlike `resolveSendOptions` (which can hand the sidecar a
 * provider id and let it fall back to the legacy `ANTHROPIC_API_KEY` env
 * path), the judge needs a real API key resolvable in the renderer process.
 *
 * This factory mirrors the provider-resolution chain in
 * `lib/claude/build-options.ts` (snapshot → `resolveFeatureProvider`) and
 * builds an `LlmClient` via `createLlmClient`. It returns `null` when the
 * provider can't be resolved with a key in the renderer — the chat hook then
 * skips driving and surfaces a one-time notice rather than wedging the loop.
 *
 * `override` carries the per-goal judge model/provider that ADR-0019 Phase 2
 * adds to `GoalConfig` (`judgeModel` / `judgeProvider`). Phase 1 callers pass
 * `undefined`; the factory degrades to the session/app-default provider.
 */

import type { AppSettings, ChatSession } from "@/lib/claude/types"
import { createLlmClient, type LlmClient } from "@/lib/twin/distill/llm"
import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  type ProviderSettingsEntry,
  type RichCustomProviderEntry,
} from "@/lib/ai/provider-consumption"

/** Per-goal judge overrides (ADR-0019 Phase 2 `GoalConfig.judge*`). */
export interface JudgeClientOverride {
  /** Explicit judge provider id. */
  provider?: string
  /** Explicit judge model id. */
  model?: string
}

/**
 * Build the `LlmClient` the turn driver hands to the judge. Returns `null`
 * when no provider resolves with a renderer-side API key (e.g. a legacy
 * `ANTHROPIC_API_KEY`-env-only setup, where the key lives in the sidecar and
 * is never exposed to the renderer). A `null` return is a signal — not an
 * error — that the loop cannot self-drive on this configuration.
 */
export function buildGoalJudgeClient(
  session: ChatSession | null | undefined,
  appSettings: AppSettings | null | undefined,
  override?: JudgeClientOverride
): LlmClient | null {
  if (!appSettings) return null

  const providerId =
    override?.provider ?? session?.providerOverride ?? appSettings.defaultProvider ?? "anthropic"

  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: appSettings.defaultProvider,
    providerSettings: appSettings.providerSettings as
      | Record<string, ProviderSettingsEntry>
      | undefined,
    customProviders: appSettings.customProviders as RichCustomProviderEntry[] | undefined,
  })

  const resolution = resolveFeatureProvider(
    {
      featureId: "goal-judge",
      routeProfile: "general-text",
      selectionMode: "explicit-provider",
      providerId,
      fallbackMode: "none",
    },
    snapshot
  )

  if (resolution.kind !== "resolved") return null
  // No renderer key → can't build a client. (anthropic legacy env path only
  // works inside the sidecar; the judge call runs in the renderer.)
  if (!resolution.apiKey) return null

  const model = override?.model ?? session?.model ?? resolution.model ?? appSettings.defaultModel
  if (!model) return null

  return createLlmClient({
    // `protocol` (openai | anthropic | google | mistral | cohere) maps 1:1
    // to createLlmClient's provider family; a custom OpenAI-compatible
    // provider resolves to protocol "openai" + its baseURL.
    provider: resolution.protocol,
    model,
    apiKey: resolution.apiKey,
    baseURL: resolution.baseURL,
  })
}
