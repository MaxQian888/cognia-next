/**
 * The store-reading half of the effort surface: the four inputs
 * `resolveEffortSurface` decides from, gathered from where they actually live,
 * and a subscription that says when any of them would change the answer.
 *
 * Separate from `./effort-surface` because that one is what the plugin SDK's
 * root barrel publishes, and importing the stores there would drag both into
 * every plugin's module graph. See that file's header for the decision.
 */

import { useSettingsStore } from "@/stores/settings"
import { runtimeRefForSession, useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import { resolveEffortSurface, type EffortSurface } from "@/lib/ai/effort-surface"
import type { ChatSession } from "@cognia/agent-config-types"

/**
 * The same answer, for a caller that has a session row but no React.
 *
 * NOT the pure half: it performs the four store reads the composer's
 * `useEffortSurface` subscribes to. It exists because the ladder is not
 * derivable from a session row alone. The lane, the app-level model/provider
 * defaults and the hidden-tier preference all live in stores a plugin cannot
 * subscribe to, and a caller that guesses at them ends up offering a different
 * ladder from the composer's own chip on the same toolbar.
 *
 * Reads `providerOverride`, which is the field the composer's model picker
 * actually writes. `Session.provider` is a plugin-compat shim nothing populates.
 */
export function effortSurfaceForSession(
  session: Pick<ChatSession, "id" | "model" | "providerOverride"> | null | undefined
): EffortSurface {
  const settings = useSettingsStore.getState().settings
  // The lane belongs to THIS session, so a runtime chosen in another
  // conversation must not decide whether this one shows a thinking dial.
  const runtimeRef = runtimeRefForSession(session?.id)
  return resolveEffortSurface({
    runtime: runtimeRef.kind === "builtin" ? "claude-sdk" : "external",
    sessionModel: session?.model,
    sessionProvider: session?.providerOverride,
    defaultModel: settings?.defaultModel,
    defaultProvider: settings?.defaultProvider,
    hiddenTiers: settings?.composerBehavior?.hiddenEffortTiers,
  })
}

/**
 * Tell me when {@link effortSurfaceForSession} would answer differently.
 *
 * The snapshot alone is a trap for a non-React caller. Three of the four inputs
 * live in stores, not on the session row: the runtime lane, the app-level
 * model/provider defaults behind an unpinned session, and the hidden-tier
 * preference. A caller that reads once and memoises on the row goes on offering
 * `max` and `ultracode` after the conversation moved to an external agent whose
 * real ladder is `low | medium | high`, which is the divergence from the
 * composer's chip this module exists to close. The composer's hook subscribes
 * with scalar selectors, and this is that same subscription for a caller with
 * no hooks, notably a plugin rendering its own dial.
 *
 * Compares a signature rather than forwarding every store write: both stores
 * carry far more than these four fields, and a listener woken by an unrelated
 * settings write would re-render a dial whose ladder cannot have changed.
 */
export function subscribeEffortSurface(
  sessionId: string | undefined,
  listener: () => void
): () => void {
  const signature = (): string => {
    const settings = useSettingsStore.getState().settings
    return JSON.stringify([
      settings?.defaultModel,
      settings?.defaultProvider,
      settings?.composerBehavior?.hiddenEffortTiers,
      runtimeRefForSession(sessionId).kind,
    ])
  }
  let last = signature()
  const notify = () => {
    const next = signature()
    if (next === last) return
    last = next
    listener()
  }
  const stops = [useSettingsStore.subscribe(notify), useAgentRuntimeStore.subscribe(notify)]
  return () => {
    for (const stop of stops) stop()
  }
}
