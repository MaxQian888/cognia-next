/**
 * The plugin contract's share of `lib/ai/effort-surface.ts`, which re-exports these.
 */
import type { AgentRuntime } from "../../stores/agent/agent-runtime-store"
import type { EffortTier } from "./thinking-level"

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
  /**
   * Whether the external agent's catalog says the model this conversation
   * runs reasons (`ExternalAgentModelCapabilities.reasoning`). `false` with no
   * published ladder means there is no depth to choose, so no dial; a ladder
   * the agent published wins either way, because it is the more specific
   * answer. Only consulted on the external rail.
   */
  externalModelReasoning?: boolean
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
