/**
 * @jest-environment jsdom
 */

import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"

jest.mock("@cognia/logging", () => {
  // Namespace-agnostic on purpose. These mocks used to list the handful of
  // `loggers.*` names the suite happened to reach, so the day an import chain
  // grew a new one the whole suite died at load with
  // "Cannot read properties of undefined (reading 'child')" and zero tests ran.
  // A Proxy answers for any namespace, so graph growth cannot go dark here.
  const child: Record<string, unknown> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
  }
  child.child = () => child
  return {
    createLogger: () => child,
    logger: child,
    loggers: new Proxy({} as Record<string, unknown>, { get: () => child }),
  }
})

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null }) },
}))

import {
  activateAgentTeamAccountStorage,
  clearAgentTeamAccountStorage,
  migrateAgentTeamPersisted,
  partializeAgentTeamState,
  purgeAgentTeamAccountStorage,
  useAgentTeamStore,
} from "./store"
import { initialState } from "./initial-state"
import { purgeProjectBuckets } from "@/lib/project/project-bucket-purge"
import { DEFAULT_PROJECT_ID } from "@/lib/db/project-defaults"

function persistedTeam(id: string, name: string) {
  return {
    id,
    name,
    task: "task",
    config: DEFAULT_TEAM_CONFIG,
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

beforeEach(() => {
  localStorage.clear()
  clearAgentTeamAccountStorage()
})

it("registers the live agent-team store with project bucket purge", () => {
  const purge = jest
    .spyOn(useAgentTeamStore.getState(), "purgeProject")
    .mockImplementation(() => {})
  purgeProjectBuckets("project-1")
  expect(purge).toHaveBeenCalledWith("project-1")
  purge.mockRestore()
})

describe("migrateAgentTeamPersisted", () => {
  it("passes through non-object snapshots and current-version snapshots", () => {
    expect(migrateAgentTeamPersisted(null, 1)).toBeNull()
    const current = { defaultConfig: DEFAULT_TEAM_CONFIG }
    expect(migrateAgentTeamPersisted(current, 4)).toBe(current)
  })

  it("backfills legacy defaults, templates, cursors, and durable maps", () => {
    const snapshot = {
      defaultConfig: {},
      templates: {
        valid: { config: {} },
        noConfig: {},
      },
      teams: {
        live: { id: "live", status: "executing" },
        done: { id: "done", status: "completed" },
      },
      teammates: null,
      tasks: { task_a: { id: "task_a" } },
    }

    const migrated = migrateAgentTeamPersisted(snapshot, 1)

    expect(migrated.defaultConfig.governancePolicy).toEqual(DEFAULT_TEAM_CONFIG.governancePolicy)
    expect(migrated.defaultConfig).toHaveProperty("capabilities", undefined)
    expect(migrated.defaultConfig).toHaveProperty("sharedMemoryAdapterId", undefined)
    expect(migrated.templates.valid.config).toEqual(
      expect.objectContaining({
        governancePolicy: DEFAULT_TEAM_CONFIG.governancePolicy,
        capabilities: undefined,
        sharedMemoryAdapterId: undefined,
      })
    )
    expect(migrated.lastAdapterSyncVersion).toEqual({})
    expect(migrated.teams.live.status).toBe("idle")
    expect(migrated.teams.done.status).toBe("completed")
    expect(migrated.teammates).toEqual({})
    // v5 backfills an empty comments thread on every legacy task.
    expect(migrated.tasks).toEqual({ task_a: { id: "task_a", comments: [] } })
  })

  it("creates a default config when a legacy snapshot omitted it", () => {
    const migrated = migrateAgentTeamPersisted({ templates: {}, teams: {} }, 1)

    expect(migrated.defaultConfig.governancePolicy).toEqual(DEFAULT_TEAM_CONFIG.governancePolicy)
    expect(migrated.defaultConfig).toHaveProperty("capabilities", undefined)
    expect(migrated.lastAdapterSyncVersion).toEqual({})
  })

  it("passes a v5 snapshot without dispatchDecision/externalPickup through unchanged", () => {
    // Additive optional fields need no migration branch — a current-version
    // snapshot missing them must load verbatim and consumers guard for
    // absence (see store header docblock).
    const snapshot = {
      defaultConfig: DEFAULT_TEAM_CONFIG,
      teams: { t1: { id: "t1", status: "idle" } },
      teammates: {},
      tasks: {},
    }
    expect(migrateAgentTeamPersisted(snapshot, 5)).toBe(snapshot)
  })

  it("defaults invalid legacy team maps to empty objects", () => {
    const migrated = migrateAgentTeamPersisted(
      {
        defaultConfig: DEFAULT_TEAM_CONFIG,
        teams: null,
        teammates: "bad",
        tasks: null,
      },
      3
    )

    expect(migrated.teams).toEqual({})
    expect(migrated.teammates).toEqual({})
    expect(migrated.tasks).toEqual({})
  })
})

describe("partializeAgentTeamState", () => {
  it("persists only durable team state", () => {
    const state = {
      ...initialState,
      teams: { team_a: persistedTeam("team_a", "Alpha") },
      teammates: { mate_a: { id: "mate_a" } },
      tasks: { task_a: { id: "task_a" } },
      messages: { team_a: [{ id: "msg_a" }] },
      events: { team_a: [{ id: "evt_a" }] },
    } as never

    expect(partializeAgentTeamState(state)).toEqual({
      templates: initialState.templates,
      defaultConfig: initialState.defaultConfig,
      displayMode: initialState.displayMode,
      workspaceTab: initialState.workspaceTab,
      tasksView: initialState.tasksView,
      lastAdapterSyncVersion: initialState.lastAdapterSyncVersion,
      editorSession: initialState.editorSession,
    })
  })

  /**
   * Squads, roster and tasks are Dexie's from persist v8 on
   * (`dexie-bridge.ts`). Keeping a copy here as well would leave the subsystem
   * with two durable stores and no rule for which wins, and the localStorage
   * one can be neither workspace-scoped nor synced to a paired device.
   */
  it("leaves the definitions to Dexie rather than keeping a second copy", () => {
    const persisted = partializeAgentTeamState({
      ...initialState,
      teams: { team_a: persistedTeam("team_a", "Alpha") },
      teammates: { mate_a: { id: "mate_a" } },
      tasks: { task_a: { id: "task_a" } },
    } as never)
    expect(persisted).not.toHaveProperty("teams")
    expect(persisted).not.toHaveProperty("teammates")
    expect(persisted).not.toHaveProperty("tasks")
  })
})

describe("agent-team account storage buckets", () => {
  it("activates account-local snapshots without leaking the previous account", () => {
    localStorage.setItem(
      "cognia-agent-teams:acct_a",
      JSON.stringify({ state: { teams: { team_a: persistedTeam("team_a", "Alpha") } } })
    )
    localStorage.setItem(
      "cognia-agent-teams:acct_b",
      JSON.stringify({ state: { teams: { team_b: persistedTeam("team_b", "Beta") } } })
    )

    activateAgentTeamAccountStorage("acct_a")
    expect(Object.keys(useAgentTeamStore.getState().teams)).toEqual(["team_a"])

    activateAgentTeamAccountStorage("acct_b")
    expect(Object.keys(useAgentTeamStore.getState().teams)).toEqual(["team_b"])
  })

  it("clears memory without deleting the active account bucket", () => {
    localStorage.setItem(
      "cognia-agent-teams:acct_a",
      JSON.stringify({ state: { teams: { team_a: persistedTeam("team_a", "Alpha") } } })
    )

    activateAgentTeamAccountStorage("acct_a")
    clearAgentTeamAccountStorage()

    expect(useAgentTeamStore.getState().teams).toEqual({})
    // The bucket survives. It no longer holds the squads themselves (Dexie does
    // from persist v8), so what proves it was not deleted is that the key is
    // still there with the preferences that remain in it.
    expect(localStorage.getItem("cognia-agent-teams:acct_a")).toContain("defaultConfig")
  })

  it("resets a phantom running team to idle on an account switch", () => {
    // A team persisted mid-run (no live controller survives a switch) must not
    // rehydrate as if it were still executing.
    localStorage.setItem(
      "cognia-agent-teams:acct_a",
      JSON.stringify({
        state: {
          teams: { team_a: { ...persistedTeam("team_a", "Alpha"), status: "executing" } },
        },
      })
    )

    activateAgentTeamAccountStorage("acct_a")
    expect(useAgentTeamStore.getState().teams.team_a?.status).toBe("idle")
  })

  it("stamps DEFAULT_PROJECT_ID on workspace-less teams on an account switch (bypasses migrate)", () => {
    localStorage.setItem(
      "cognia-agent-teams:acct_a",
      JSON.stringify({
        state: {
          teams: {
            legacy: persistedTeam("legacy", "Legacy"),
            scoped: { ...persistedTeam("scoped", "Scoped"), projectId: "proj-A" },
          },
        },
      })
    )
    activateAgentTeamAccountStorage("acct_a")
    const teams = useAgentTeamStore.getState().teams
    expect(teams.legacy?.projectId).toBe(DEFAULT_PROJECT_ID)
    expect(teams.scoped?.projectId).toBe("proj-A")
  })
})

describe("agent-team onRehydrateStorage stale-status reset", () => {
  it("resets planning/executing/paused teams to idle on rehydrate; leaves terminal ones", async () => {
    localStorage.setItem(
      "cognia-agent-teams",
      JSON.stringify({
        version: 6,
        state: {
          teams: {
            t_exec: { ...persistedTeam("t_exec", "Exec"), status: "executing" },
            t_plan: { ...persistedTeam("t_plan", "Plan"), status: "planning" },
            t_paused: { ...persistedTeam("t_paused", "Paused"), status: "paused" },
            t_done: { ...persistedTeam("t_done", "Done"), status: "completed" },
          },
        },
      })
    )

    await useAgentTeamStore.persist.rehydrate()

    const teams = useAgentTeamStore.getState().teams
    expect(teams.t_exec?.status).toBe("idle")
    expect(teams.t_plan?.status).toBe("idle")
    expect(teams.t_paused?.status).toBe("idle")
    expect(teams.t_done?.status).toBe("completed")
  })

  it("rehydrates without throwing when there is no persisted state", async () => {
    localStorage.clear()
    await expect(useAgentTeamStore.persist.rehydrate()).resolves.not.toThrow()
  })

  it("purges only the requested account bucket", () => {
    localStorage.setItem("cognia-agent-teams:acct_a", "A")
    localStorage.setItem("cognia-agent-teams:acct_b", "B")

    purgeAgentTeamAccountStorage("acct_a")

    expect(localStorage.getItem("cognia-agent-teams:acct_a")).toBeNull()
    expect(localStorage.getItem("cognia-agent-teams:acct_b")).toBe("B")
  })

  it("adopts the legacy bucket only when the account bucket is missing", () => {
    localStorage.setItem(
      "cognia-agent-teams",
      JSON.stringify({ state: { teams: { legacy_team: persistedTeam("legacy_team", "Legacy") } } })
    )

    activateAgentTeamAccountStorage("acct_legacy")

    expect(localStorage.getItem("cognia-agent-teams")).toBeNull()
    // Adoption is proved by the squad reaching memory, not by it staying in the
    // bucket: from persist v8 the bucket no longer carries squads at all, and
    // the Dexie mirror is what writes the adopted rows down.
    expect(Object.keys(useAgentTeamStore.getState().teams)).toEqual(["legacy_team"])
    expect(localStorage.getItem("cognia-agent-teams:acct_legacy")).not.toBeNull()

    localStorage.setItem(
      "cognia-agent-teams",
      JSON.stringify({ state: { teams: { ignored: persistedTeam("ignored", "Ignored") } } })
    )
    localStorage.setItem(
      "cognia-agent-teams:acct_existing",
      JSON.stringify({ state: { teams: { existing: persistedTeam("existing", "Existing") } } })
    )
    activateAgentTeamAccountStorage("acct_existing")

    expect(localStorage.getItem("cognia-agent-teams")).toContain("ignored")
    expect(Object.keys(useAgentTeamStore.getState().teams)).toEqual(["existing"])
  })

  it("falls back to empty state for missing and malformed account snapshots", () => {
    activateAgentTeamAccountStorage("acct_empty")
    expect(useAgentTeamStore.getState().teams).toEqual({})

    localStorage.setItem("cognia-agent-teams:acct_bad", "{")
    activateAgentTeamAccountStorage("acct_bad")
    expect(useAgentTeamStore.getState().teams).toEqual({})

    localStorage.setItem("cognia-agent-teams:acct_null", JSON.stringify({ state: null }))
    activateAgentTeamAccountStorage("acct_null")
    expect(useAgentTeamStore.getState().teams).toEqual({})
  })
})
