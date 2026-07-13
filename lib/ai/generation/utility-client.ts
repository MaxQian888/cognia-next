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

export interface BuildUtilityClientArgs {
  session: ChatSession | null | undefined
  appSettings: AppSettings | null | undefined
  /** Per-feature provider/model override (e.g. `appSettings.conversationTitle`). */
  override?: UtilityModelConfig
  /** Telemetry-only feature id forwarded to the resolver. */
  featureId: string
}

/**
 * Build the `LlmClient` a background helper uses. Resolution order for the
 * provider: explicit override → session override → app default → anthropic.
 * Model order: explicit override → session model → resolved provider default
 * → app default model. Returns `null` (not an error) when the provider can't
 * be resolved with a renderer-side key, or when no model is determinable.
 */
export function buildUtilityLlmClient({
  session,
  appSettings,
  override,
  featureId,
}: BuildUtilityClientArgs): LlmClient | null {
  return buildRendererLlmClient({
    session,
    appSettings,
    featureId,
    providerOverride: override?.providerOverride,
    modelOverride: override?.model,
  })
}
