/**
 * @jest-environment jsdom
 *
 * Tests for the Agent-Team Plugin API (`ctx.team`).
 *
 * Covers permission gating (team:read / team:write), reads against the real
 * agent-team-store, guarded moves (shared canMoveTask semantics), plugin-
 * attributed comments, validated task creation, and board subscriptions.
 */

import { createTeamAPI } from "./team-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

jest.mock("@/lib/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    createLogger: () => ({ ...child, child: () => child }),
    logger: { ...child, child: () => child },
    loggers: {
      agent: { ...child, child: () => child },
      plugin: { ...child, child: () => child },
    },
  }
})

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null }) },
}))

const PLUGIN = "tracker-sync"

const seed = () => {
  const state = useAgentTeamStore.getState()
  const team = state.createTeam({ name: "T", task: "t" })
  const mate = state.addTeammate({
    teamId: team.id,
    name: "Worker",
    description: "",
    role: "teammate",
  })
  const failed = state.createTask({ teamId: team.id, title: "F", description: "" })
  state.updateTask(failed.id, { status: "failed" })
  return { team, mate, failed }
}

describe("createTeamAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    localStorage.clear()
    useAgentTeamStore.getState().reset()
    resetPermissionGuard()
    guard = getPermissionGuard()
  })

  describe("permission gating", () => {
    it("throws without team:read on a read", () => {
      guard.registerPlugin(PLUGIN, [])
      const api = createTeamAPI(PLUGIN)
      expect(() => api.listTeams()).toThrow(PermissionError)
    })

    it("throws without team:write on a mutation", () => {
      guard.registerPlugin(PLUGIN, ["team:read"])
      const { failed } = seed()
      const api = createTeamAPI(PLUGIN)
      expect(() => api.moveTask(failed.id, "pending")).toThrow(PermissionError)
      expect(useAgentTeamStore.getState().tasks[failed.id].status).toBe("failed")
    })
  })

  describe("reads", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["team:read"]))

    it("lists teams, teammates and tasks from the live store", async () => {
      const { team, mate, failed } = seed()
      const api = createTeamAPI(PLUGIN)
      expect((await api.listTeams()).map((t) => t.id)).toContain(team.id)
      expect(await api.getTeam(team.id)).toMatchObject({ name: "T" })
      expect(await api.getTeam("missing")).toBeNull()
      expect((await api.listTeammates(team.id)).map((m) => m.id)).toContain(mate.id)
      expect((await api.listTasks(team.id)).map((t) => t.id)).toEqual([failed.id])
    })

    it("subscribe fires on board changes for the team and stops after unsubscribe", () => {
      const { team } = seed()
      const api = createTeamAPI(PLUGIN)
      const listener = jest.fn()
      const unsubscribe = api.subscribe(team.id, listener)

      useAgentTeamStore.getState().createTask({ teamId: team.id, title: "N", description: "" })
      expect(listener).toHaveBeenCalled()

      const calls = listener.mock.calls.length
      unsubscribe()
      useAgentTeamStore.getState().createTask({ teamId: team.id, title: "M", description: "" })
      expect(listener).toHaveBeenCalledTimes(calls)
    })
  })

  describe("mutations", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["team:read", "team:write"]))

    it("createTask validates the team + assignee and lands on the board", async () => {
      const { team, mate } = seed()
      const api = createTeamAPI(PLUGIN)
      const task = await api.createTask({
        teamId: team.id,
        title: "Imported issue",
        priority: "high",
        assignedTo: mate.id,
        tags: ["jira"],
      })
      expect(useAgentTeamStore.getState().tasks[task.id]).toMatchObject({
        title: "Imported issue",
        priority: "high",
        assignedTo: mate.id,
        status: "pending",
      })
      await expect(api.createTask({ teamId: "ghost", title: "x" })).rejects.toThrow(/not found/)
      await expect(
        api.createTask({ teamId: team.id, title: "x", assignedTo: "stranger" })
      ).rejects.toThrow(/not on the team/)
    })

    it("addComment attributes the plugin as author", async () => {
      const { failed } = seed()
      const api = createTeamAPI(PLUGIN)
      const comment = await api.addComment(failed.id, "synced upstream")
      expect(comment).toMatchObject({
        authorId: `plugin:${PLUGIN}`,
        authorName: PLUGIN,
        text: "synced upstream",
      })
      expect(await api.addComment("missing", "x")).toBeNull()
    })

    it("moveTask enforces the shared guard and reports denials without throwing", async () => {
      const { failed } = seed()
      const api = createTeamAPI(PLUGIN)
      expect(await api.moveTask(failed.id, "pending")).toEqual({ ok: true })
      expect(useAgentTeamStore.getState().tasks[failed.id].status).toBe("pending")
      expect(await api.moveTask(failed.id, "completed")).toEqual({
        ok: false,
        reason: "illegal-transition",
      })
      expect(await api.moveTask("missing", "pending")).toEqual({
        ok: false,
        reason: "task-not-found",
      })
    })
  })
})
