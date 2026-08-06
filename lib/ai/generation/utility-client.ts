/**
 * Renderer-side "background utility model" client factory.
 *
 * Cheap, non-chat helper tasks — conversation-title generation
 * (`lib/ai/generation/title.ts`) and timeline label summaries
 * (`lib/ai/generation/turn-label.ts`) — need a real `LlmClient` resolvable in
 * the renderer process, exactly like the `/goal` judge
 * (`lib/goal/judge-client.ts`). Both share `buildRendererLlmClient`
 * (`lib/ai/renderer-llm-client.ts`); this wrapper just maps the
 * {@link UtilityModelConfig} override shape onto it.
 */

import type { AppSettings, ChatSession, UtilityModelConfig } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"

/**
 * Default cheap models for utility tasks when no explicit override is configured.
 * Keyed by provider id. Only includes known built-in providers where we're
 * confident the cheap model exists. Custom/unknown providers fall through to
 * the session model.
 */
export const UTILITY_CHEAP_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
}

export interface BuildUtilityClientArgs {
  session: ChatSession | null | undefined
  appSettings: AppSettings | null | undefined
  /** Per-feature provider/model override (e.g. `appSettings.conversationTitle`). */
  override?: UtilityModelConfig
  /** Telemetry-only feature id forwarded to the resolver. */
  featureId: string
}

/**
 * Infer a cheap model for utility tasks based on the resolved provider.
 * Only returns a preference for known built-in providers; returns undefined
 * for custom/unknown providers (letting the session model be used instead).
 */
export function inferCheapModel(
  session: ChatSession | null | undefined,
  appSettings: AppSettings | null | undefined
): string | undefined {
  const providerId = session?.providerOverride ?? appSettings?.defaultProvider ?? "anthropic"
  return UTILITY_CHEAP_MODELS[providerId]
}

/**
 * Build the `LlmClient` a background helper uses. Resolution order for the
 * provider: explicit override → session override → app default → anthropic.
 * Model order: explicit override → cheap model preference (when no explicit
 * override) → session model → resolved provider default → app default model.
 * Returns `null` (not an error) when the provider can't be resolved with a
 * renderer-side key, or when no model is determinable.
 */
export function buildUtilityLlmClient({
  session,
  appSettings,
  override,
  featureId,
}: BuildUtilityClientArgs): LlmClient | null {
  // Only suggest a cheap model when the user hasn't explicitly configured one
  // in the per-feature override.
  const cheapHint = override?.model ? undefined : inferCheapModel(session, appSettings)

  return buildRendererLlmClient({
    session,
    appSettings,
    featureId,
    providerOverride: override?.providerOverride,
    modelOverride: override?.model,
    modelPreference: cheapHint,
  })
}
