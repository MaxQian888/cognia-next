"use client"

/**
 * Reactive wrapper around `listAgentRuntimes`.
 *
 * The catalog itself is pure and lives in `lib/ai/agent/runtime-catalog`. This
 * hook does one job: gather the inputs it needs from the stores, the host
 * configuration list and the protocol-adapter registry, and hand back the rows
 * plus whichever row the persisted ref currently names.
 *
 * It deliberately has NO effects. The one write that used to live beside this
 * derivation (falling back to the default lane when the selected agent turns
 * out to be permanently unrunnable) belongs to the single mounted composer
 * chip, not to every consumer of the catalog.
 */

import { useEffect, useReducer } from "react"
import { useTranslations } from "next-intl"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { hydrateAgentConfig } from "@/stores/agent/external-agent-store/selectors"
import { useHostExternalAgentConfigs } from "@/hooks/agent/use-host-external-agent-configs"
import {
  externalAgentProcessPlane,
  PROCESS_PLANE_COMMANDS,
} from "@/lib/ai/agent/external/process-plane"
import { onProtocolAdapterRegistryChange } from "@/lib/ai/agent/external/protocol-adapter"
import { findRuntimeByKey, runtimeRefKey } from "@/lib/ai/agent/runtime-catalog/types"
import { listAgentRuntimes } from "@/lib/ai/agent/runtime-catalog/catalog"
import type { AgentRuntimeDescriptor } from "@/lib/ai/agent/runtime-catalog/types"
import type { ExternalAgentValiditySnapshot } from "@/types/agent/external-agent"

export interface AgentRuntimeCatalogState {
  runtimes: AgentRuntimeDescriptor[]
  /** The row the persisted ref names, or undefined when it no longer exists. */
  selected: AgentRuntimeDescriptor | undefined
  /** The External Agents master switch, surfaced so the picker can offer it. */
  externalEnabled: boolean
  /** How many local agents are configured, regardless of the switch. */
  configuredExternalCount: number
}

/**
 * The one-line "you may want to fix this first" for a selectable agent, read
 * from the validity snapshot the manager writes on every connect, health check
 * and execution. Ordered by how much it costs the user to find out the hard
 * way: an agent that failed to start, then one waiting on a sign-in, then one
 * whose last health probe came back bad.
 *
 * `blockingReason` is the runtime's own wording (a spawn error, a missing
 * binary) and is shown verbatim. Inventing a translated paraphrase would drop
 * the detail that makes it actionable.
 */
function makeWarningDescriber(t: (key: string) => string) {
  return (validity: ExternalAgentValiditySnapshot | undefined): string | null => {
    if (!validity) return null
    if (validity.executable === false) return validity.blockingReason ?? t("lastCheckFailed")
    if (validity.negotiation?.authRequired) return t("needsAuth")
    if (validity.healthStatus === "unhealthy") return t("lastCheckFailed")
    return null
  }
}

/**
 * @param sessionId The conversation whose lane is being described. Omitting it
 * resolves against the app default, which is right for a composer that has no
 * conversation yet and wrong everywhere else: the lane is per session, so a
 * catalog resolved against the default reports the default's row as `selected`
 * no matter what the session chose. That is what made the runtime chip refuse
 * to move. The click wrote the session's ref, the radio group's value came back
 * from the default, and the menu reopened on the row the user had just left.
 */
export function useAgentRuntimeCatalog(
  providerId?: string,
  sessionId?: string
): AgentRuntimeCatalogState {
  const t = useTranslations("agentRuntime")
  const runtimeRef = useRuntimeRefForSession(sessionId)
  const externalEnabled = useExternalAgentStore((s) => s.enabled)
  const storedAgents = useExternalAgentStore((s) => s.agents)
  const agentValidity = useExternalAgentStore((s) => s.agentValidity)
  const { configs: hostConfigs, unavailable: hostUnavailable } = useHostExternalAgentConfigs()

  // A plugin-contributed protocol adapter can register or unregister at any
  // time and the registry is not reactive, so a row's blocked reason would
  // otherwise stay stale until the next store write. The rows are derived on
  // every render rather than memoized: the re-render this forces IS the
  // refresh, and `hydrateAgentConfig` is identity-cached per stored record.
  const [, bumpRegistryTick] = useReducer((tick: number) => tick + 1, 0)
  useEffect(() => onProtocolAdapterRegistryChange(() => bumpRegistryTick()), [])

  const runtimes = listAgentRuntimes({
    providerId,
    externalEnabled,
    externalAgents: Object.values(storedAgents ?? {}).map(hydrateAgentConfig),
    agentValidity,
    hostConfigs: hostUnavailable ? [] : hostConfigs,
    // The verdict, not a boolean. `supportsExternalAgents()` answers yes or no
    // and throws the reason away, and the reason is the whole difference
    // between a row that says "grant this device Agent Control" and one that
    // says "install the desktop app" about a Host that could have run it. It
    // also carries `transient`, which is what stops the selector treating a
    // Host still reporting its features as grounds to rewrite the user's
    // chosen agent back to the built-in lane on every launch.
    runtimeSupportsExternalAgents: externalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn),
    describeWarning: makeWarningDescriber(t),
  })

  return {
    runtimes,
    selected: findRuntimeByKey(runtimes, runtimeRefKey(runtimeRef)),
    externalEnabled,
    configuredExternalCount: Object.keys(storedAgents ?? {}).length,
  }
}
