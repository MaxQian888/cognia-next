"use client"

/**
 * Which thinking tiers the composer's effort control should offer RIGHT NOW.
 *
 * Three inputs decide that, and before this module each caller reached for them
 * separately (or forgot one):
 *
 *   1. the runtime that will actually execute the turn — the built-in Claude
 *      SDK rail reasons through the session's provider + model, the external
 *      rail through a CLI agent whose model the renderer never sees;
 *   2. that surface's own wire vocabulary (`@/lib/ai/thinking-level`), which is
 *      what stops the control offering tiers the channel folds together; and
 *   3. the user's hidden-tier preference, which narrows the offer further.
 *
 * Split pure-function / hook on purpose: {@link resolveEffortSurface} is where
 * every decision lives and is unit-testable without a store or a DOM, while
 * {@link useEffortSurface} only gathers the four store reads. Same division as
 * `./effort-selector-view`, which owns the geometry the same way.
 */

import { useSettingsStore } from "@/stores/settings"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { modelSupportsEffort } from "@/lib/ai/reasoning-capability"
import {
  availableThinkingLevels,
  externalAgentThinkingLevels,
  visibleThinkingLevels,
  type EffortTier,
} from "@/lib/ai/thinking-level"
import { getBuiltInProviderDefaultModel } from "@cognia/provider-types/built-in-provider-catalog"
import type { ChatSession } from "@cognia/agent-config-types"
import type { AgentRuntime } from "@/stores/agent/agent-runtime-store"

/**
 * Fallback model id when neither the session nor the app settings name one.
 *
 * Read from the catalog rather than spelled out, so the chip's label and the
 * effort ladder can never be computed for two different models — which is what
 * happened while the wire fallback said `claude-sonnet-4-5` (deliberately
 * excluded from the effort families) and this said `claude-sonnet-5`.
 */
const FALLBACK_MODEL = getBuiltInProviderDefaultModel("anthropic") ?? "claude-sonnet-5"
/** Fallback provider id — the native Anthropic dispatcher. */
const FALLBACK_PROVIDER = "anthropic"

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
}

export interface EffortSurface {
  /**
   * The tiers to offer, ascending. EMPTY means this surface has no depth
   * control at all — callers render nothing rather than a dead widget, which is
   * the control's only self-gate.
   */
  levels: EffortTier[]
  /**
   * The ladder before the hidden-tier preference was applied. Settings UI needs
   * it to show what is available to hide; the control itself never uses it.
   */
  offered: EffortTier[]
  /** True when {@link levels} describes an external CLI agent, not the session model. */
  external: boolean
  /** The model the ladder was derived from — `undefined` on the external rail. */
  modelId?: string
  /** The provider the ladder was derived from — `undefined` on the external rail. */
  providerId?: string
}

/**
 * Resolve the offered ladder. Pure — every input is a value, so a test can walk
 * the whole matrix (rail × provider × model × preference) without a store.
 */
export function resolveEffortSurface(input: EffortSurfaceInput): EffortSurface {
  // The external rail dispatches to an agent that brings its own model, so the
  // session's provider/model pair describes a runtime that is not going to run.
  // `externalAgentThinkingLevels` is the surface-derived answer for it.
  if (input.runtime === "external") {
    const offered = externalAgentThinkingLevels()
    return {
      offered,
      levels: visibleThinkingLevels(offered, input.hiddenTiers),
      external: true,
    }
  }

  // Mirrors the model resolution in `bottom-toolbar.tsx` and, through it,
  // `lib/claude/build-options.ts`: per-session override beats the app default.
  // Character / member overrides are not loaded here — this is the
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

/**
 * Store-reading wrapper over {@link resolveEffortSurface}. Every subscription is
 * a scalar selector so the composer re-renders on a model/runtime change and
 * nothing else — except `hiddenEffortTiers`, which is an array and would break
 * referential equality on every settings write if selected directly, so it is
 * read off the settings object the component already subscribes to.
 */
export function useEffortSurface(session: ChatSession | null): EffortSurface {
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const hiddenTiers = useSettingsStore((s) => s.settings?.composerBehavior?.hiddenEffortTiers)
  // The lane belongs to THIS session, so a runtime chosen in another
  // conversation must not decide whether this one shows a thinking dial.
  const runtimeRef = useRuntimeRefForSession(session?.id)
  const runtime: AgentRuntime = runtimeRef.kind === "builtin" ? "claude-sdk" : "external"

  return resolveEffortSurface({
    runtime,
    sessionModel: session?.model,
    sessionProvider: session?.providerOverride,
    defaultModel,
    defaultProvider,
    hiddenTiers,
  })
}
