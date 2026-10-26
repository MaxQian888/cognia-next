/**
 * Which thinking tiers a conversation's effort control should offer RIGHT NOW.
 *
 * Three inputs decide that, and before this module each caller reached for them
 * separately (or forgot one):
 *
 *   1. the runtime that will actually execute the turn. The built-in Claude SDK
 *      rail reasons through the session's provider + model, the external rail
 *      through a CLI agent whose model the renderer never sees.
 *   2. that surface's own wire vocabulary (`./thinking-level`), which is what
 *      stops the control offering tiers the channel folds together.
 *   3. the user's hidden-tier preference, which narrows the offer further.
 *
 * Lives in `lib/ai/` rather than next to the composer because it is not the
 * composer's answer, it is the app's. `components/chat/composer/effort-surface`
 * re-exports it and adds the React hook, and `@cognia/plugin-sdk` publishes it
 * so a plugin rendering its own dial composes the SAME answer instead of
 * re-deriving it. The first plugin that re-derived it got the lane, the provider
 * fallback, the reasoning gate and the hidden-tier preference all wrong.
 *
 * This half is PURE, and its own file for that reason rather than as a matter
 * of taste. It is what `@cognia/plugin-sdk`'s root barrel publishes, and the
 * root is types and pure functions only, so a module that merely IMPORTED the
 * settings and agent-runtime stores would put both (each of which constructs a
 * store at module scope) into the graph of every plugin that touches the
 * barrel. The half that gathers those four inputs from the stores, and the
 * subscription that says when they change the answer, live in
 * `./effort-surface-session`.
 */

import { modelSupportsEffort } from "@/lib/ai/reasoning-capability"
import {
  availableThinkingLevels,
  externalAgentThinkingLevels,
  visibleThinkingLevels,
} from "@/lib/ai/thinking-level"
import { getBuiltInProviderDefaultModel } from "@cognia/provider-types/built-in-provider-catalog"
import type {
  EffortSurface,
  EffortSurfaceInput,
} from "@cognia/plugin-contract/lib/ai/effort-surface"
export type {
  EffortSurface,
  EffortSurfaceInput,
} from "@cognia/plugin-contract/lib/ai/effort-surface"

/**
 * Fallback model id when neither the session nor the app settings name one.
 *
 * Read from the catalog rather than spelled out, so the chip's label and the
 * effort ladder can never be computed for two different models, which is what
 * happened while the wire fallback said `claude-sonnet-4-5` (deliberately
 * excluded from the effort families) and this said `claude-sonnet-5`.
 */
export const FALLBACK_MODEL = getBuiltInProviderDefaultModel("anthropic") ?? "claude-sonnet-5"
/** Fallback provider id, the native Anthropic dispatcher. */
export const FALLBACK_PROVIDER = "anthropic"

/**
 * Resolve the offered ladder. Pure, because every input is a value, so a test
 * can walk the whole matrix (rail x provider x model x preference) without a
 * store.
 */
export function resolveEffortSurface(input: EffortSurfaceInput): EffortSurface {
  // The external rail dispatches to an agent that brings its own model, so the
  // session's provider/model pair describes a runtime that is not going to run.
  // `externalAgentThinkingLevels` answers from the agent's own published levels
  // when it has declared them (Pi reports `max` for the models that honour it),
  // and from the generic surface until then.
  if (input.runtime === "external") {
    const agentPublished = (input.externalLevels?.length ?? 0) > 0
    const offered =
      !agentPublished && input.externalModelReasoning === false
        ? []
        : externalAgentThinkingLevels(input.externalLevels)
    return {
      offered,
      levels: visibleThinkingLevels(offered, input.hiddenTiers),
      external: true,
    }
  }

  // Mirrors the model resolution in `bottom-toolbar.tsx` and, through it,
  // `lib/claude/build-options.ts`: per-session override beats the app default.
  // Character / member overrides are not loaded here. This is the
  // most-likely-active pair, which is what the user is choosing against.
  const modelId = input.sessionModel ?? input.defaultModel ?? FALLBACK_MODEL
  const providerId = input.sessionProvider ?? input.defaultProvider ?? FALLBACK_PROVIDER

  const offered = availableThinkingLevels({
    providerId,
    modelId,
    reasoning: modelSupportsEffort(providerId, modelId),
  })
  return {
    offered,
    levels: visibleThinkingLevels(offered, input.hiddenTiers),
    external: false,
    modelId,
    providerId,
  }
}
