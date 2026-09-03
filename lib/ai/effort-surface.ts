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
  type EffortTier,
} from "@/lib/ai/thinking-level"
import { getBuiltInProviderDefaultModel } from "@cognia/provider-types/built-in-provider-catalog"
import type { AgentRuntime } from "@/stores/agent/agent-runtime-store"

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

export interface EffortSurfaceInput {
  /** Which rail executes the next turn. */
  runtime: AgentRuntime
  /** Per-session model override, if the user picked one. */
  sessionModel?: string
  /** Per-session provider override, if the user picked one. */
  sessionProvider?: string
  /** App-level default model. */
  defaultModel?: string
  /** App-level default provider. */
  defaultProvider?: string
  /** `composerBehavior.hiddenEffortTiers`. */
  hiddenTiers?: readonly EffortTier[]
  /**
   * The external agent's OWN published level vocabulary, when one has been
   * read (`resolveExternalAgentThinking` over its `thought_level` config
   * option). Only consulted on the external rail, and only when the agent
   * actually answered: an empty or absent list keeps the generic fallback.
   *
   * Threaded rather than fetched here because this half is pure and the answer
   * is a round trip to an agent process.
   */
  externalLevels?: readonly string[]
}

export interface EffortSurface {
  /**
   * The tiers to offer, ascending. EMPTY means this surface has no depth
   * control at all, so callers render nothing rather than a dead widget. That
   * is the control's only self-gate.
   */
  levels: EffortTier[]
  /**
   * The ladder before the hidden-tier preference was applied. Settings UI needs
   * it to show what is available to hide. The control itself never uses it.
   */
  offered: EffortTier[]
  /** True when {@link levels} describes an external CLI agent, not the session model. */
  external: boolean
  /** The model the ladder was derived from. `undefined` on the external rail. */
  modelId?: string
  /** The provider the ladder was derived from. `undefined` on the external rail. */
  providerId?: string
}

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
    const offered = externalAgentThinkingLevels(input.externalLevels)
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
