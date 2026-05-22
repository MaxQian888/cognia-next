import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"
import { initialState } from "./initial-state"
import { createAgentTeamActionsSlice } from "./slices/actions.slice"
import type { AgentTeamState } from "./types"

/**
 * Persisted-state version. Bump (and add a `migrate` branch below) whenever
 * the persisted shape changes incompatibly. Kept in lockstep with the
 * pattern used by `external-agent-store/store.ts`.
 *
 * v1 → v2 (Agent-Team plugin integration):
 *   - `AgentTeamConfig.governancePolicy` becomes required at the type level.
 *     v1 rows without a policy receive `DEFAULT_TEAM_CONFIG.governancePolicy`.
 *   - `AgentTeamConfig.capabilities` (new) defaults to `undefined` (= empty
 *     bundle, no plugin contributions inherited).
 *   - `defaultConfig` carries the same defaults.
 *   - Templates with stale category enums are passed through unchanged;
 *     downstream code already tolerates unknown strings via the template
 *     picker filter.
 */
const PERSIST_VERSION = 2

interface V1DefaultConfigShape {
  governancePolicy?: unknown
  capabilities?: unknown
  [key: string]: unknown
}

interface V1PersistedShape {
  templates?: Record<string, { config?: V1DefaultConfigShape } & Record<string, unknown>>
  defaultConfig?: V1DefaultConfigShape
  displayMode?: unknown
  workspaceTab?: unknown
}

/**
 * Pure migration helper — exported for tests. Idempotent against v2 input.
 */
export function migrateAgentTeamPersisted(
  persistedState: unknown,
  version: number | undefined
): AgentTeamState {
  if (!persistedState || typeof persistedState !== "object") {
    return persistedState as AgentTeamState
  }
  if (version !== undefined && version >= PERSIST_VERSION) {
    return persistedState as AgentTeamState
  }

  const raw = persistedState as V1PersistedShape
  const defaultConfig = (raw.defaultConfig ?? {}) as V1DefaultConfigShape
  // Backfill governancePolicy + capabilities on the team-level default.
  if (!defaultConfig.governancePolicy) {
    defaultConfig.governancePolicy = DEFAULT_TEAM_CONFIG.governancePolicy
  }
  if (!("capabilities" in defaultConfig)) {
    defaultConfig.capabilities = undefined
  }
  raw.defaultConfig = defaultConfig

  // Same backfill on every persisted template's `config`. Templates may
  // omit `config` entirely; in that case nothing to migrate.
  if (raw.templates) {
    for (const tpl of Object.values(raw.templates)) {
      if (tpl && typeof tpl === "object" && tpl.config && typeof tpl.config === "object") {
        const cfg = tpl.config as V1DefaultConfigShape
        if (!cfg.governancePolicy) {
          cfg.governancePolicy = DEFAULT_TEAM_CONFIG.governancePolicy
        }
        if (!("capabilities" in cfg)) {
          cfg.capabilities = undefined
        }
      }
    }
  }

  return raw as unknown as AgentTeamState
}

export const useAgentTeamStore = create<AgentTeamState>()(
  persist(
    (set, get) => ({
      ...initialState,
      ...createAgentTeamActionsSlice(set, get),
    }),
    {
      name: "cognia-agent-teams",
      storage: createJSONStorage(() => localStorage),
      version: PERSIST_VERSION,
      partialize: (state) => ({
        templates: state.templates,
        defaultConfig: state.defaultConfig,
        displayMode: state.displayMode,
        workspaceTab: state.workspaceTab,
      }),
      migrate: (persistedState, version) => migrateAgentTeamPersisted(persistedState, version),
    }
  )
)

export default useAgentTeamStore
