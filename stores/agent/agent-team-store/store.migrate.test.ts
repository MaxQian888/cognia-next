/** @jest-environment jsdom */
/**
 * Pure tests for the v1 → v2 migration helper.
 *
 * Exercises:
 *   - Empty / non-object input is passed through.
 *   - v2 input is passed through unchanged (idempotency).
 *   - v1 default config is backfilled with governancePolicy + capabilities.
 *   - v1 per-template config is backfilled the same way.
 *   - Templates without a `config` block are left alone.
 */

import "fake-indexeddb/auto"
import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"
import { DEFAULT_PROJECT_ID } from "@/lib/db/project-defaults"
import {
  backfillTeamProjectIds,
  migrateAgentTeamPersisted,
  resetStaleTeamStatuses,
  rehydrateResetStaleTeams,
} from "./store"

describe("migrateAgentTeamPersisted", () => {
  it("returns non-object input as-is", () => {
    expect(migrateAgentTeamPersisted(null, 1)).toBeNull()
    expect(migrateAgentTeamPersisted(undefined, 1)).toBeUndefined()
    expect(migrateAgentTeamPersisted(42 as unknown, 1)).toBe(42)
  })

  it("returns current-version input unchanged (idempotency)", () => {
    const current = {
      defaultConfig: { capabilities: { skillIds: ["s"] }, sharedMemoryAdapterId: undefined },
      lastAdapterSyncVersion: {},
      editorSession: {},
    }
    const out = migrateAgentTeamPersisted(current, 7)
    expect(out).toBe(current)
  })

  it("upgrades v6 → v7: stamps DEFAULT_PROJECT_ID on every team without a workspace", () => {
    const v6 = {
      defaultConfig: { governancePolicy: DEFAULT_TEAM_CONFIG.governancePolicy },
      lastAdapterSyncVersion: {},
      editorSession: {},
      teams: {
        legacy: { id: "legacy", status: "idle" },
        blank: { id: "blank", status: "idle", projectId: "" },
        scoped: { id: "scoped", status: "idle", projectId: "proj-A" },
      },
      teammates: {},
      tasks: {},
    }
    const out = migrateAgentTeamPersisted(v6, 6) as unknown as {
      teams: Record<string, { projectId?: string }>
    }
    expect(out.teams.legacy.projectId).toBe(DEFAULT_PROJECT_ID)
    expect(out.teams.blank.projectId).toBe(DEFAULT_PROJECT_ID)
    expect(out.teams.scoped.projectId).toBe("proj-A")
    // Idempotent: a second pass changes nothing.
    expect(backfillTeamProjectIds(out.teams)).toBe(0)
  })

  it("backfillTeamProjectIds tolerates missing / malformed maps and reports the count", () => {
    expect(backfillTeamProjectIds(undefined)).toBe(0)
    expect(backfillTeamProjectIds({ x: undefined, y: { projectId: "p" }, z: {} })).toBe(1)
  })

  it("upgrades v5 → v6: backfills an empty editorSession map", () => {
    const v5 = {
      defaultConfig: { governancePolicy: DEFAULT_TEAM_CONFIG.governancePolicy },
      tasks: { t1: { id: "t1", title: "a", comments: [] } },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v5, 5) as any
    expect(out.editorSession).toEqual({})
  })

  it("upgrades v4 → v5: backfills an empty comments array on every task", () => {
    const v4 = {
      defaultConfig: { governancePolicy: DEFAULT_TEAM_CONFIG.governancePolicy },
      tasks: {
        t1: { id: "t1", title: "a" },
        t2: { id: "t2", title: "b", comments: [{ id: "c1", text: "keep me" }] },
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v4, 4) as any
    expect(out.tasks.t1.comments).toEqual([])
    expect(out.tasks.t2.comments).toEqual([{ id: "c1", text: "keep me" }])
  })

  it("upgrades v2 → v3: backfills sharedMemoryAdapterId + lastAdapterSyncVersion", () => {
    const v2 = {
      defaultConfig: { governancePolicy: DEFAULT_TEAM_CONFIG.governancePolicy },
      templates: { a: { config: { governancePolicy: DEFAULT_TEAM_CONFIG.governancePolicy } } },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v2, 2) as any
    expect("sharedMemoryAdapterId" in out.defaultConfig).toBe(true)
    expect(out.defaultConfig.sharedMemoryAdapterId).toBeUndefined()
    expect("sharedMemoryAdapterId" in out.templates.a.config).toBe(true)
    expect(out.lastAdapterSyncVersion).toEqual({})
  })

  it("backfills governancePolicy + capabilities on a v1 default config", () => {
    const v1 = { defaultConfig: { maxTeammates: 10 } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v1, 1) as any
    expect(out.defaultConfig.governancePolicy).toEqual(DEFAULT_TEAM_CONFIG.governancePolicy)
    expect("capabilities" in out.defaultConfig).toBe(true)
    expect(out.defaultConfig.capabilities).toBeUndefined()
  })

  it("preserves an existing governancePolicy on a v1 default config", () => {
    const customPolicy = {
      approval: { requirePlanApproval: true, requireDelegationApproval: false },
      budget: {
        tokenBudget: 42,
        warningThreshold: 0.5,
        criticalThreshold: 0.9,
        onCritical: "pause_for_review",
      },
      escalation: { allowOperatorPatternOverride: false, pauseOnHighRisk: true },
    }
    const v1 = { defaultConfig: { governancePolicy: customPolicy } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v1, 1) as any
    expect(out.defaultConfig.governancePolicy).toBe(customPolicy)
  })

  it("backfills per-template configs", () => {
    const v1 = {
      templates: {
        a: { config: { maxTeammates: 5 } },
        b: { config: {} },
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v1, 1) as any
    expect(out.templates.a.config.governancePolicy).toEqual(DEFAULT_TEAM_CONFIG.governancePolicy)
    expect("capabilities" in out.templates.a.config).toBe(true)
    expect(out.templates.b.config.governancePolicy).toEqual(DEFAULT_TEAM_CONFIG.governancePolicy)
  })

  it("leaves templates without a `config` block untouched", () => {
    const v1 = { templates: { a: { name: "x" } } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v1, 1) as any
    expect(out.templates.a).toEqual({ name: "x" })
  })

  it("treats missing version as v1 (forward-compatible default)", () => {
    const v1 = { defaultConfig: {} }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v1, undefined) as any
    expect(out.defaultConfig.governancePolicy).toEqual(DEFAULT_TEAM_CONFIG.governancePolicy)
  })

  it("resets a team persisted at the CURRENT version out of a non-terminal status", () => {
    // A same-version snapshot skips `migrate` entirely, so the reset must not
    // depend on it — this is what `onRehydrateStorage` calls.
    const teams = {
      t1: { id: "t1", status: "executing" },
      t2: { id: "t2", status: "planning" },
      t3: { id: "t3", status: "paused" },
      t4: { id: "t4", status: "completed" },
      t5: { id: "t5", status: "idle" },
    }
    resetStaleTeamStatuses(teams)
    expect(teams.t1.status).toBe("idle")
    expect(teams.t2.status).toBe("idle")
    expect(teams.t3.status).toBe("idle")
    // Terminal / already-idle statuses are untouched.
    expect(teams.t4.status).toBe("completed")
    expect(teams.t5.status).toBe("idle")
  })

  it("resetStaleTeamStatuses tolerates missing / malformed maps", () => {
    expect(() => resetStaleTeamStatuses(undefined)).not.toThrow()
    expect(() => resetStaleTeamStatuses({ x: {} as { status?: string } })).not.toThrow()
  })

  it("rehydrateResetStaleTeams resets team statuses and no-ops on a missing state", () => {
    // No-op branch: a rehydrate that restored nothing.
    expect(() => rehydrateResetStaleTeams(undefined)).not.toThrow()
    // Reset branch.
    const state = { teams: { a: { status: "executing" }, b: { status: "completed" } } }
    rehydrateResetStaleTeams(state)
    expect(state.teams.a.status).toBe("idle")
    expect(state.teams.b.status).toBe("completed")
  })
})
