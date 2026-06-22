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
 *
 * v2 → v3 (Shared-memory adapter + quiet-hours delivery):
 *   - `AgentTeamConfig.sharedMemoryAdapterId` (new) defaults to `undefined`
 *     on `defaultConfig` and every persisted template config.
 *   - `lastAdapterSyncVersion` (new, root) defaults to `{}` and is now
 *     persisted so reverse adapter sync resumes incrementally.
 *   - `governancePolicy.delivery` (new, optional) stays `undefined` by default
 *     so no migration write is required.
 *
 * v3 → v4 (Scheduler Phase D — durable team definitions):
 *   - `teams` / `teammates` / `tasks` are now persisted so a SCHEDULED
 *     `agent-team` task can re-instantiate + run its team after an app restart
 *     (previously these lived only in memory, so the cron task failed with
 *     "team not found" — see `lib/scheduler/executors/team-executor.ts`).
 *   - Live runtime ephemera (`messages` / `events` / `consensus` /
 *     `delegations` / shared-memory) stay in-memory — they carry
 *     non-serializable handles + unbounded churn, and run HISTORY is already
 *     durable in Dexie `workflowRuns` (workflowId `__team__:<teamId>:<nonce>`).
 *   - Any team persisted mid-run (`planning` / `executing` / `paused`) has no
 *     live controller after restart, so its status is reset to `idle` to avoid
 *     a phantom "live" run in the UI.
 */
const PERSIST_VERSION = 4
const AGENT_TEAM_STORAGE_KEY = "cognia-agent-teams"

function agentTeamAccountStorageKey(accountId: string): string {
  return `${AGENT_TEAM_STORAGE_KEY}:${accountId}`
}

/** Non-terminal team statuses that cannot survive a process restart. */
const STALE_TEAM_STATUSES = new Set(["planning", "executing", "paused"])

interface V1DefaultConfigShape {
  governancePolicy?: unknown
  capabilities?: unknown
  sharedMemoryAdapterId?: unknown
  [key: string]: unknown
}

interface V1PersistedShape {
  templates?: Record<string, { config?: V1DefaultConfigShape } & Record<string, unknown>>
  defaultConfig?: V1DefaultConfigShape
  displayMode?: unknown
  workspaceTab?: unknown
  lastAdapterSyncVersion?: Record<string, Record<string, number>>
  // v4: durable team definitions.
  teams?: Record<string, { status?: string } & Record<string, unknown>>
  teammates?: Record<string, unknown>
  tasks?: Record<string, unknown>
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
  // Backfill governancePolicy + capabilities (v2) + sharedMemoryAdapterId (v3)
  // on the team-level default.
  if (!defaultConfig.governancePolicy) {
    defaultConfig.governancePolicy = DEFAULT_TEAM_CONFIG.governancePolicy
  }
  if (!("capabilities" in defaultConfig)) {
    defaultConfig.capabilities = undefined
  }
  if (!("sharedMemoryAdapterId" in defaultConfig)) {
    defaultConfig.sharedMemoryAdapterId = undefined
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
        if (!("sharedMemoryAdapterId" in cfg)) {
          cfg.sharedMemoryAdapterId = undefined
        }
      }
    }
  }

  // v3: ensure the persisted adapter-sync cursor map exists.
  if (!raw.lastAdapterSyncVersion) {
    raw.lastAdapterSyncVersion = {}
  }

  // v4: durable team definitions. Older snapshots have no teams/teammates/tasks
  // (they were in-memory only) — default to empty maps. Reset any team left in
  // a non-terminal status (no live controller survives a restart).
  if (!raw.teams || typeof raw.teams !== "object") {
    raw.teams = {}
  } else {
    for (const team of Object.values(raw.teams)) {
      if (team && typeof team === "object" && typeof team.status === "string") {
        if (STALE_TEAM_STATUSES.has(team.status)) team.status = "idle"
      }
    }
  }
  if (!raw.teammates || typeof raw.teammates !== "object") {
    raw.teammates = {}
  }
  if (!raw.tasks || typeof raw.tasks !== "object") {
    raw.tasks = {}
  }

  return raw as unknown as AgentTeamState
}

/**
 * Select the persisted slice of the store. Exported for tests.
 *
 * Persists team templates + defaults + UI tab state + the adapter-sync cursor,
 * AND (v4) the durable team DEFINITIONS (teams/teammates/tasks) so scheduled
 * team runs survive a restart. Live runtime ephemera (messages / events /
 * consensus / delegations / shared-memory) are intentionally excluded — they
 * carry non-serializable handles + unbounded churn, and run history lives in
 * Dexie `workflowRuns`.
 */
export function partializeAgentTeamState(state: AgentTeamState) {
  return {
    templates: state.templates,
    defaultConfig: state.defaultConfig,
    displayMode: state.displayMode,
    workspaceTab: state.workspaceTab,
    lastAdapterSyncVersion: state.lastAdapterSyncVersion,
    teams: state.teams,
    teammates: state.teammates,
    tasks: state.tasks,
  }
}

export const useAgentTeamStore = create<AgentTeamState>()(
  persist(
    (set, get) => ({
      ...initialState,
      ...createAgentTeamActionsSlice(set, get),
    }),
    {
      name: AGENT_TEAM_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: PERSIST_VERSION,
      partialize: partializeAgentTeamState,
      migrate: migrateAgentTeamPersisted,
    }
  )
)

export function activateAgentTeamAccountStorage(accountId: string): void {
  if (typeof window === "undefined") return
  const storageKey = agentTeamAccountStorageKey(accountId)
  adoptLegacyAgentTeamStorage(storageKey)
  useAgentTeamStore.persist.setOptions({ name: storageKey })
  useAgentTeamStore.setState({
    ...initialState,
    ...readAgentTeamPersistedState(storageKey),
  })
}

export function clearAgentTeamAccountStorage(): void {
  if (typeof window === "undefined") return
  useAgentTeamStore.persist.setOptions({ name: AGENT_TEAM_STORAGE_KEY })
  useAgentTeamStore.setState(initialState)
}

export function purgeAgentTeamAccountStorage(accountId: string): void {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(agentTeamAccountStorageKey(accountId))
}

function adoptLegacyAgentTeamStorage(storageKey: string): void {
  if (typeof window === "undefined") return
  if (window.localStorage.getItem(storageKey)) return
  const legacySnapshot = window.localStorage.getItem(AGENT_TEAM_STORAGE_KEY)
  if (!legacySnapshot) return
  window.localStorage.setItem(storageKey, legacySnapshot)
  window.localStorage.removeItem(AGENT_TEAM_STORAGE_KEY)
}

function readAgentTeamPersistedState(storageKey: string): Partial<AgentTeamState> {
  if (typeof window === "undefined") return {}
  const snapshot = window.localStorage.getItem(storageKey)
  if (!snapshot) return {}
  try {
    const parsed = JSON.parse(snapshot) as { state?: unknown }
    return parsed.state && typeof parsed.state === "object"
      ? (parsed.state as Partial<AgentTeamState>)
      : {}
  } catch {
    return {}
  }
}

export default useAgentTeamStore
