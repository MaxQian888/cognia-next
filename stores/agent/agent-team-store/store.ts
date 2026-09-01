import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import { registerProjectBucketPurger } from "@/lib/project/project-bucket-purge"
import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"
import { DEFAULT_PROJECT_ID } from "@/lib/db/project-defaults"
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
 *     durable in Dexie `workflowRuns`, under an id minted by
 *     `lib/ai/agent/team/team-workflow-id.ts`.
 *   - Any team persisted mid-run (`planning` / `executing` / `paused`) has no
 *     live controller after restart, so its status is reset to `idle` to avoid
 *     a phantom "live" run in the UI.
 *
 * v4 → v5 (Task comment threads):
 *   - `AgentTeamTask.comments` (new) is backfilled to `[]` on every persisted
 *     task so the UI / selectors can treat it as always-present.
 *
 * v5 → v6 (Project Editor tab session):
 *   - `editorSession` (new, root) is a `Record<teamId, AgentTeamEditorSession>`
 *     persisting the project Editor tab's open files / active file / selected
 *     root / layout. Older snapshots have none — default to `{}`.
 *
 * v6 → v7 (workspace isolation backfill):
 *   - `teams[*].projectId` is REQUIRED to be set. Teams persisted before
 *     workspace isolation (Dexie v86) carried no `projectId` and were
 *     "grandfathered" into every workspace by a lenient filter in
 *     `components/agent/mode/mode-selector.tsx` — which also meant a workspace
 *     purge never removed them. v7 stamps every project-less team with
 *     `DEFAULT_PROJECT_ID` (`lib/db/project-defaults.ts`, a fixed id, so the
 *     backfill is idempotent and needs no async lookup) and the lenient filter
 *     is gone. The active workspace is deliberately NOT used: at migrate time
 *     on a cold boot it is `null`.
 *
 * Additive optional fields (NO version bump): `AgentTeam.dispatchDecision`
 * and `AgentTeam.externalPickup` (dispatch-completion work) stay `undefined`
 * on older rows; every consumer guards for absence, so no migration branch
 * is needed. `externalPickup` Dates round-trip as ISO strings through the
 * JSON storage — same as `routingAssessment.createdAt`.
 *
 *   - v8: teams / teammates / tasks leave this blob for Dexie
 *     (`agentTeams`, `agentTeammates`, `agentTeamTasks`, schema v215).
 *     `stores/agent/agent-team-store/dexie-bridge.ts` is the mirror. The
 *     migration does NOT move the rows itself: it leaves them in the
 *     rehydrated state, and the bridge writes anything memory holds that the
 *     tables do not on its first sync. That way the move happens once the
 *     account database is actually open, rather than inside a synchronous
 *     storage callback that has no way to await one.
 */
const PERSIST_VERSION = 8
const AGENT_TEAM_STORAGE_KEY = "cognia-agent-teams"

function agentTeamAccountStorageKey(accountId: string): string {
  return `${AGENT_TEAM_STORAGE_KEY}:${accountId}`
}

/** Non-terminal team statuses that cannot survive a process restart. */
const STALE_TEAM_STATUSES = new Set(["planning", "executing", "paused"])

/**
 * Reset every team left in a non-terminal status to `idle` — its live
 * controller does not survive a reload/account-switch, so the status is a
 * phantom "running" that would otherwise stick until the next incompatible
 * version bump. Mutates in place; safe on any `teams` map (missing/other keys
 * are ignored). Applied by BOTH `migrate` (cross-version) and
 * `onRehydrateStorage` (every boot, incl. same-version), because `migrate`
 * short-circuits when the persisted version already equals `PERSIST_VERSION`.
 */
export function resetStaleTeamStatuses(
  teams: Record<string, { status?: string }> | undefined
): void {
  if (!teams || typeof teams !== "object") return
  for (const team of Object.values(teams)) {
    if (team && typeof team === "object" && typeof team.status === "string") {
      if (STALE_TEAM_STATUSES.has(team.status)) team.status = "idle"
    }
  }
}

/**
 * `onRehydrateStorage` callback body — resets stale team statuses on every
 * boot. Extracted (and exported) so both branches are directly testable; the
 * `!state` guard covers a rehydrate that restored nothing.
 */
export function rehydrateResetStaleTeams(
  state: { teams?: Record<string, { status?: string }> } | undefined
): void {
  if (!state) return
  resetStaleTeamStatuses(state.teams)
}

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
  // v6: project Editor tab session.
  editorSession?: Record<string, unknown>
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
    resetStaleTeamStatuses(raw.teams)
  }
  if (!raw.teammates || typeof raw.teammates !== "object") {
    raw.teammates = {}
  }
  if (!raw.tasks || typeof raw.tasks !== "object") {
    raw.tasks = {}
  }

  // v5: task comment threads. Older tasks have no `comments` — default to an empty
  // array so the UI and selectors can treat it as always-present.
  for (const task of Object.values(raw.tasks as Record<string, { comments?: unknown }>)) {
    if (task && typeof task === "object" && !Array.isArray(task.comments)) {
      task.comments = []
    }
  }

  // v6: project Editor tab session. Older snapshots have none — default to {}.
  if (!raw.editorSession || typeof raw.editorSession !== "object") {
    raw.editorSession = {}
  }

  // v7: every team belongs to a workspace. Backfill the pre-isolation rows.
  backfillTeamProjectIds(raw.teams)

  return raw as unknown as AgentTeamState
}

/**
 * Stamp `DEFAULT_PROJECT_ID` on every team that carries no `projectId`.
 * Idempotent; mutates in place; ignores non-object rows. Applied by `migrate`
 * (v6 → v7) AND by `activateAgentTeamAccountStorage`, whose read path bypasses
 * `migrate` — an account switch onto an old snapshot must not resurrect
 * workspace-less teams.
 */
export function backfillTeamProjectIds(teams: Record<string, unknown> | undefined): number {
  if (!teams || typeof teams !== "object") return 0
  let stamped = 0
  for (const team of Object.values(teams)) {
    if (!team || typeof team !== "object") continue
    const row = team as { projectId?: unknown }
    if (typeof row.projectId === "string" && row.projectId.length > 0) continue
    row.projectId = DEFAULT_PROJECT_ID
    stamped += 1
  }
  return stamped
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
    tasksView: state.tasksView,
    lastAdapterSyncVersion: state.lastAdapterSyncVersion,
    // teams / teammates / tasks are Dexie's from v8 on. Leaving them here as
    // well would give the subsystem two durable copies with no rule for which
    // wins, and the localStorage one cannot be workspace-scoped or synced.
    // `dexie-bridge.ts` owns them; only what is left is UI-shaped preference.
    editorSession: state.editorSession,
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
      storage: persistLocalStorage(),
      version: PERSIST_VERSION,
      partialize: partializeAgentTeamState,
      migrate: migrateAgentTeamPersisted,
      // `migrate` resets stale statuses only across a version bump. A plain
      // same-version reload skips it, so a team persisted mid-run would
      // rehydrate as a phantom "executing". Reset again here on EVERY boot.
      onRehydrateStorage: () => rehydrateResetStaleTeams,
    }
  )
)

registerProjectBucketPurger("agent-teams", (projectId) => {
  useAgentTeamStore.getState().purgeProject(projectId)
})

export function activateAgentTeamAccountStorage(accountId: string): void {
  if (typeof window === "undefined") return
  const storageKey = agentTeamAccountStorageKey(accountId)
  adoptLegacyAgentTeamStorage(storageKey)
  useAgentTeamStore.persist.setOptions({ name: storageKey })
  // This read path bypasses `migrate` / `onRehydrateStorage`, so reset stale
  // statuses here too — an account switch must not surface a phantom run.
  const restored = readAgentTeamPersistedState(storageKey)
  resetStaleTeamStatuses(restored.teams)
  backfillTeamProjectIds(restored.teams)
  useAgentTeamStore.setState({
    ...initialState,
    ...restored,
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
