"use client"

/**
 * The composer's React binding over the app-level effort surface.
 *
 * Every decision (the runtime lane, the provider/model fallback chain, the
 * `modelSupportsEffort` gate, the hidden-tier narrowing) moved to
 * `@/lib/ai/effort-surface` so a non-React caller, notably a plugin rendering
 * its own dial, composes the SAME answer instead of re-deriving it. This file
 * keeps the hook and re-exports the rest, so existing importers are unchanged.
 */

import { useSettingsStore } from "@/stores/settings"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useExternalAgentModels } from "@/hooks/agent/use-external-agent-models"
import { resolveEffortSurface, type EffortSurface } from "@/lib/ai/effort-surface"
import type { ChatSession } from "@cognia/agent-config-types"
import type { AgentRuntime } from "@/stores/agent/agent-runtime-store"

export { FALLBACK_MODEL, FALLBACK_PROVIDER, resolveEffortSurface } from "@/lib/ai/effort-surface"
export type { EffortSurface, EffortSurfaceInput } from "@/lib/ai/effort-surface"
export { effortSurfaceForSession, subscribeEffortSurface } from "@/lib/ai/effort-surface-session"

/**
 * Store-reading wrapper over {@link resolveEffortSurface}. Every subscription is
 * a scalar selector so the composer re-renders on a model/runtime change and
 * nothing else, except `hiddenEffortTiers`, which is an array and would break
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
  // The agent's OWN ladder, from the `thought_level` option it publishes. Same
  // cached round trip the model chip already makes for this conversation, so
  // asking costs nothing extra, and it is what lets Pi's `max` appear instead
  // of the generic three tiers every external agent used to be given.
  const agentThinking = useExternalAgentModels(session?.id).thinking

  return resolveEffortSurface({
    runtime,
    sessionModel: session?.model,
    sessionProvider: session?.providerOverride,
    defaultModel,
    defaultProvider,
    hiddenTiers,
    externalLevels: agentThinking.levels,
  })
}
