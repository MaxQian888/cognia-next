import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import { initialState } from "./initial-state"
import { createExternalAgentActionsSlice } from "./slices/actions.slice"
import type { ExternalAgentStore } from "./types"
import { getUnsupportedProtocolReason } from "@/lib/ai/agent/external/config-normalizer"
import {
  createExternalAgentBenchmarkBaseline,
  normalizeExternalAgentValiditySnapshot,
} from "@/lib/ai/agent/external/canonical-contract"

const EXTERNAL_AGENT_STORE_VERSION = 5

type PersistedExternalAgentState = Partial<
  Pick<
    ExternalAgentStore,
    | "agents"
    | "delegationRules"
    | "activeAgentId"
    | "agentValidity"
    | "benchmarkCapabilityMap"
    | "lastRunSnapshots"
    | "enabled"
    | "defaultPermissionMode"
    | "autoConnectOnStartup"
    | "showConnectionNotifications"
    | "chatFailurePolicy"
  >
>

function migratePersistedAgents(
  agents: PersistedExternalAgentState["agents"]
): PersistedExternalAgentState["agents"] {
  if (!agents) {
    return agents
  }

  const migrated = { ...agents }
  for (const [agentId, agent] of Object.entries(migrated)) {
    if (!agent) {
      continue
    }

    if (agent.protocol !== "acp") {
      migrated[agentId] = {
        ...agent,
        metadata: {
          ...(agent.metadata ?? {}),
          unsupported: true,
          unsupportedProtocol: agent.protocol,
          unsupportedReason: getUnsupportedProtocolReason(agent.protocol),
        },
      }
    }
  }

  return migrated
}

function normalizeLastRunSnapshots(
  snapshots: PersistedExternalAgentState["lastRunSnapshots"]
): PersistedExternalAgentState["lastRunSnapshots"] {
  if (!snapshots) {
    return snapshots
  }

  return Object.entries(snapshots).reduce<
    NonNullable<PersistedExternalAgentState["lastRunSnapshots"]>
  >((acc, [agentId, snapshot]) => {
    if (!snapshot) {
      return acc
    }

    acc[agentId] = {
      ...snapshot,
      timestamp:
        snapshot.timestamp instanceof Date ? snapshot.timestamp : new Date(snapshot.timestamp),
    }
    return acc
  }, {})
}

export const useExternalAgentStore = create<ExternalAgentStore>()(
  persist(
    (set, get) => ({
      ...initialState,
      ...createExternalAgentActionsSlice(set, get),
    }),
    {
      name: "cognia-external-agents",
      version: EXTERNAL_AGENT_STORE_VERSION,
      storage: createJSONStorage(() => localStorage),
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as PersistedExternalAgentState
        const agents = migratePersistedAgents(state.agents) ?? {}
        const normalizedValidity = Object.entries(state.agentValidity ?? {}).reduce<
          Record<string, ExternalAgentStore["agentValidity"][string]>
        >((acc, [agentId, snapshot]) => {
          if (!snapshot) {
            return acc
          }
          const protocol = agents[agentId]?.protocol ?? "acp"
          acc[agentId] = normalizeExternalAgentValiditySnapshot(snapshot, {
            fallbackProtocol: protocol,
            fallbackSource: snapshot.source,
          })
          return acc
        }, {})
        const benchmarkCapabilityMap = Object.keys(agents).reduce<
          Record<string, ExternalAgentStore["benchmarkCapabilityMap"][string]>
        >((acc, agentId) => {
          acc[agentId] =
            state.benchmarkCapabilityMap?.[agentId] ?? createExternalAgentBenchmarkBaseline()
          return acc
        }, {})
        const lastRunSnapshots = normalizeLastRunSnapshots(state.lastRunSnapshots) ?? {}
        return {
          ...state,
          agents,
          agentValidity: normalizedValidity,
          benchmarkCapabilityMap,
          lastRunSnapshots,
          chatFailurePolicy: state.chatFailurePolicy ?? "fallback",
        } as ExternalAgentStore
      },
      partialize: (state) => ({
        agents: state.agents,
        delegationRules: state.delegationRules,
        activeAgentId: state.activeAgentId,
        agentValidity: state.agentValidity,
        benchmarkCapabilityMap: state.benchmarkCapabilityMap,
        lastRunSnapshots: state.lastRunSnapshots,
        enabled: state.enabled,
        defaultPermissionMode: state.defaultPermissionMode,
        autoConnectOnStartup: state.autoConnectOnStartup,
        showConnectionNotifications: state.showConnectionNotifications,
        chatFailurePolicy: state.chatFailurePolicy,
      }),
    }
  )
)

export default useExternalAgentStore
