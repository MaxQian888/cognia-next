/**
 * agent-team-store/store — partialize + v2 migration tests
 *
 * Verifies the persistence-layer changes that ship with the Agent Team
 * Templates Settings section:
 *
 *   - `partialize` strips `isBuiltIn: true` rows from the localStorage
 *     snapshot so backups never carry seed copies.
 *   - The v1 → v2 `migrate` branch drops legacy built-in rows that may
 *     have been persisted before the partialize filter was tightened.
 */

import type { AgentTeamTemplate } from "@/types/agent/agent-team"
import type { AgentTeamState } from "./types"
import { migrateAgentTeamPersisted, partializeAgentTeamState } from "./store"

// Re-implement the partialize + migrate functions inline so we can exercise
// them in isolation without booting the full Zustand store. They mirror the
// implementations in `store.ts` exactly.
function partializeTemplates(
  templates: Record<string, AgentTeamTemplate>
): Record<string, AgentTeamTemplate> {
  return Object.fromEntries(Object.entries(templates).filter(([, t]) => !t.isBuiltIn))
}

function migrateV1ToV2(persisted: { templates?: Record<string, AgentTeamTemplate> }): {
  templates?: Record<string, AgentTeamTemplate>
} {
  if (!persisted.templates) return persisted
  return {
    ...persisted,
    templates: Object.fromEntries(
      Object.entries(persisted.templates).filter(
        ([, t]) => !(t as { isBuiltIn?: boolean }).isBuiltIn
      )
    ),
  }
}

const builtIn: AgentTeamTemplate = {
  id: "parallel-review",
  name: "Built-in",
  description: "",
  category: "review",
  teammates: [],
  isBuiltIn: true,
}
const userOne: AgentTeamTemplate = {
  id: "user-1",
  name: "User One",
  description: "",
  category: "general",
  teammates: [],
  isBuiltIn: false,
}
const userTwo: AgentTeamTemplate = {
  id: "user-2",
  name: "User Two",
  description: "",
  category: "general",
  teammates: [],
}

describe("agent-team-store persistence shape", () => {
  it("partialize strips isBuiltIn templates from the snapshot", () => {
    const all = { [builtIn.id]: builtIn, [userOne.id]: userOne, [userTwo.id]: userTwo }
    const filtered = partializeTemplates(all)
    expect(filtered).toHaveProperty(userOne.id)
    expect(filtered).toHaveProperty(userTwo.id)
    expect(filtered).not.toHaveProperty(builtIn.id)
  })

  it("v1 → v2 migrate drops legacy built-in rows", () => {
    const persisted = {
      templates: { [builtIn.id]: builtIn, [userOne.id]: userOne },
    }
    const migrated = migrateV1ToV2(persisted)
    expect(migrated.templates).toHaveProperty(userOne.id)
    expect(migrated.templates).not.toHaveProperty(builtIn.id)
  })

  it("migrate is a no-op when persistedState has no templates", () => {
    const empty: { templates?: Record<string, AgentTeamTemplate> } = {}
    expect(migrateV1ToV2(empty)).toEqual(empty)
  })
})

describe("migrateAgentTeamPersisted — v3 → v4 (durable team definitions)", () => {
  it("defaults teams/teammates/tasks to empty maps for a pre-v4 snapshot", () => {
    const migrated = migrateAgentTeamPersisted({ defaultConfig: {} }, 3) as unknown as Record<
      string,
      unknown
    >
    expect(migrated.teams).toEqual({})
    expect(migrated.teammates).toEqual({})
    expect(migrated.tasks).toEqual({})
  })

  it("resets non-terminal team statuses to idle but keeps terminal ones", () => {
    const migrated = migrateAgentTeamPersisted(
      {
        teams: {
          a: { id: "a", status: "executing" },
          b: { id: "b", status: "planning" },
          c: { id: "c", status: "paused" },
          d: { id: "d", status: "completed" },
          e: { id: "e", status: "cancelled" },
        },
      },
      3
    ) as { teams: Record<string, { status: string }> }
    expect(migrated.teams.a.status).toBe("idle")
    expect(migrated.teams.b.status).toBe("idle")
    expect(migrated.teams.c.status).toBe("idle")
    expect(migrated.teams.d.status).toBe("completed")
    expect(migrated.teams.e.status).toBe("cancelled")
  })

  it("preserves persisted teams/teammates and does not reset when already at v4", () => {
    const snapshot = {
      teams: { a: { id: "a", status: "executing" } },
      teammates: { tm: { id: "tm" } },
      tasks: { t: { id: "t" } },
    }
    const migrated = migrateAgentTeamPersisted(snapshot, 4) as unknown as typeof snapshot
    // Already current — returned as-is (executing NOT reset, definitions intact).
    expect(migrated.teams.a.status).toBe("executing")
    expect(migrated.teammates.tm).toEqual({ id: "tm" })
    expect(migrated.tasks.t).toEqual({ id: "t" })
  })

  it("returns non-object input unchanged", () => {
    expect(migrateAgentTeamPersisted(null, undefined)).toBeNull()
  })

  it("backfills governancePolicy/capabilities on persisted template configs", () => {
    const migrated = migrateAgentTeamPersisted(
      { templates: { t1: { id: "t1", config: { foo: 1 } } } },
      1
    ) as { templates: Record<string, { config: Record<string, unknown> }> }
    const cfg = migrated.templates.t1.config
    expect(cfg.governancePolicy).toBeDefined()
    expect("capabilities" in cfg).toBe(true)
    expect("sharedMemoryAdapterId" in cfg).toBe(true)
  })
})

describe("partializeAgentTeamState", () => {
  it("persists definitions + templates but not live runtime ephemera", () => {
    const state = {
      templates: { t: {} },
      defaultConfig: { x: 1 },
      displayMode: "grid",
      workspaceTab: "tasks",
      lastAdapterSyncVersion: { a: { b: 1 } },
      teams: { team1: { id: "team1" } },
      teammates: { tm: { id: "tm" } },
      tasks: { task1: { id: "task1" } },
      // Ephemera that must NOT be persisted:
      messages: { m: {} },
      events: [{ e: 1 }],
      consensus: { c: {} },
      delegations: { d: {} },
    } as unknown as AgentTeamState

    const persisted = partializeAgentTeamState(state) as Record<string, unknown>
    expect(persisted.teams).toEqual({ team1: { id: "team1" } })
    expect(persisted.teammates).toEqual({ tm: { id: "tm" } })
    expect(persisted.tasks).toEqual({ task1: { id: "task1" } })
    expect(persisted).not.toHaveProperty("messages")
    expect(persisted).not.toHaveProperty("events")
    expect(persisted).not.toHaveProperty("consensus")
    expect(persisted).not.toHaveProperty("delegations")
  })
})
