"use client"

/**
 * The Cognia provider/models the external agent bound to THIS conversation can
 * run on through Cognia's local gateway (ADR-0090, 2026-09-11 amendment), and
 * why not when it cannot.
 *
 * The composer's model picker offers them beside the agent's own models, so a
 * conversation can move an agent between the two from one control. Two lanes
 * answer differently:
 *
 *   - **Local agent.** This client launches the task, so it decides: the
 *     agent's runtime has to have an isolated launch contract
 *     (`cogniaGatewaySupport`), and the list is this client's configured
 *     providers through the same filter the agent editor's picker applies
 *     (`listCogniaGatewayModelOptions`).
 *   - **A configuration the paired Host owns.** The Host launches the task, on
 *     ITS providers and accounts, so only the Host can say what is eligible
 *     (`fetchHostCogniaModels`). A Host too old to answer says so as
 *     `host-update-required` rather than as an empty list.
 *
 * Every "no" carries a reason, because the picker renders the section disabled
 * with one line explaining it rather than hiding the option.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  cogniaGatewaySupport,
  type CogniaGatewayUnsupportedReason,
} from "@/lib/ai/agent/external/config/gateway-task"
import {
  listCogniaGatewayModelOptions,
  type CogniaGatewayModelCatalog,
  type CogniaGatewayProviderOption,
} from "@/lib/ai/agent/external/config/cognia-model-options"
import { fetchHostCogniaModels } from "@/lib/ai/agent/external/runtimes/remote/remote-host-configs"
import { useSubscriptionProviders } from "@/lib/subscription/core/hooks"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useSettingsStore } from "@/stores/settings"

/** Why the Cognia section is offered disabled. */
export type CogniaGatewayModelsReason =
  | CogniaGatewayUnsupportedReason
  | Extract<CogniaGatewayModelCatalog, { supported: false }>["reason"]

export type CogniaGatewayModelsStatus =
  /** A built-in lane, or an agent this client does not know yet. */
  | "idle"
  /** Asking the Host. */
  | "loading"
  | "ready"
  /** Answered, and the answer is "not here" — see `reason`. */
  | "unavailable"
  /** The Host could not be asked. */
  | "error"

export interface CogniaGatewayModels {
  /** The agent the list is for: a local agent id or a Host configuration id. */
  agentId: string | null
  lane: "local" | "host" | null
  status: CogniaGatewayModelsStatus
  providers: CogniaGatewayProviderOption[]
  reason: CogniaGatewayModelsReason | null
  /** Ask the Host again. A no-op on a local lane, whose list is derived. */
  refresh: () => void
}

const IDLE: CogniaGatewayModels = {
  agentId: null,
  lane: null,
  status: "idle",
  providers: [],
  reason: null,
  refresh: () => {},
}

/** A Host's answer, tagged with the request it answers so a stale one is ignored. */
type HostAnswer =
  | { key: string; kind: "catalog"; catalog: CogniaGatewayModelCatalog }
  | { key: string; kind: "error" }

export function useCogniaGatewayModels(sessionId: string | undefined): CogniaGatewayModels {
  const runtimeRef = useRuntimeRefForSession(sessionId)
  const hostConfigId = runtimeRef.kind === "host" ? runtimeRef.configId : null
  const localAgentId = runtimeRef.kind === "external" ? runtimeRef.agentId : null
  const localConfig = useExternalAgentStore((state) =>
    localAgentId ? state.agents[localAgentId] : undefined
  )
  const settings = useSettingsStore((state) => state.settings)
  const subscriptions = useSubscriptionProviders()

  // --- Local lane: derived, nothing to fetch -------------------------------
  const local = useMemo(() => {
    if (!localAgentId || !localConfig) return null
    const support = cogniaGatewaySupport(localConfig)
    if (!support.supported) return { providers: [], reason: support.reason }
    if (!settings) return null
    // A variable rather than a literal: the builder owns which inputs it reads.
    const input = { settings, subscriptions }
    const providers = listCogniaGatewayModelOptions(input)
    return providers.length > 0
      ? { providers, reason: null }
      : { providers: [], reason: "no-eligible-models" as const }
  }, [localAgentId, localConfig, settings, subscriptions])

  // --- Host lane: the Host decides ------------------------------------------
  const [nonce, setNonce] = useState(0)
  const [answer, setAnswer] = useState<HostAnswer | null>(null)
  const requestKey = hostConfigId ? `${hostConfigId}\u0000${nonce}` : null
  useEffect(() => {
    if (!hostConfigId || !requestKey) return
    let cancelled = false
    fetchHostCogniaModels(hostConfigId).then(
      (catalog) => {
        if (!cancelled) setAnswer({ key: requestKey, kind: "catalog", catalog })
      },
      () => {
        if (!cancelled) setAnswer({ key: requestKey, kind: "error" })
      }
    )
    return () => {
      cancelled = true
    }
  }, [hostConfigId, requestKey])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  return useMemo<CogniaGatewayModels>(() => {
    if (hostConfigId) {
      const current = answer?.key === requestKey ? answer : null
      if (!current) {
        return { ...IDLE, agentId: hostConfigId, lane: "host", status: "loading", refresh }
      }
      if (current.kind === "error") {
        return { ...IDLE, agentId: hostConfigId, lane: "host", status: "error", refresh }
      }
      const { catalog } = current
      if (!catalog.supported) {
        return {
          ...IDLE,
          agentId: hostConfigId,
          lane: "host",
          status: "unavailable",
          reason: catalog.reason,
          refresh,
        }
      }
      return catalog.providers.length > 0
        ? {
            ...IDLE,
            agentId: hostConfigId,
            lane: "host",
            status: "ready",
            providers: catalog.providers,
            refresh,
          }
        : {
            ...IDLE,
            agentId: hostConfigId,
            lane: "host",
            status: "unavailable",
            reason: "no-eligible-models",
            refresh,
          }
    }
    if (!localAgentId) return IDLE
    if (!local) return { ...IDLE, agentId: localAgentId, lane: "local" }
    return {
      ...IDLE,
      agentId: localAgentId,
      lane: "local",
      status: local.reason ? "unavailable" : "ready",
      providers: local.providers,
      reason: local.reason,
    }
  }, [hostConfigId, answer, requestKey, refresh, localAgentId, local])
}
