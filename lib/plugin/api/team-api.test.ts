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

    it("getTeammate returns the roster row or null", async () => {
      const { mate } = seed()
      const api = createTeamAPI(PLUGIN)
      expect(await api.getTeammate(mate.id)).toMatchObject({ name: "Worker" })
      expect(await api.getTeammate("missing")).toBeNull()
    })

    it("exposes run status, events, execution report, and checkpoints", async () => {
      const { team, failed } = seed()
      const state = useAgentTeamStore.getState()
      const api = createTeamAPI(PLUGIN)

      expect(await api.getRunStatus(team.id)).toEqual({
        teamId: team.id,
        status: team.status,
        report: null,
      })
      expect(await api.getRunStatus("missing")).toBeNull()
      expect(await api.getExecutionReport(team.id)).toBeNull()
      expect(await api.listCheckpoints(team.id)).toEqual([])

      const now = new Date()
      state.addEvent({ type: "task_created", teamId: team.id, taskId: failed.id, timestamp: now })
      state.addEvent({ type: "task_created", teamId: "other-team", timestamp: now })
      const events = await api.listEvents(team.id)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ teamId: team.id, taskId: failed.id })

      state.upsertExecutionReport(team.id, {
        id: "rep1",
        teamId: team.id,
        status: "running",
        checkpoints: [],
        createdAt: now,
        updatedAt: now,
      })
      state.addExecutionCheckpoint(team.id, {
        id: "cp1",
        type: "task_completed",
        timestamp: now,
        summary: "done",
      })
      expect((await api.getRunStatus(team.id))?.report?.id).toBe("rep1")
      expect((await api.getExecutionReport(team.id))?.status).toBe("running")
      expect(await api.listCheckpoints(team.id)).toHaveLength(1)
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

    it("updateTask patches only whitelisted fields and returns the fresh row", async () => {
      const { team, failed } = seed()
      const api = createTeamAPI(PLUGIN)
      const updated = await api.updateTask(failed.id, {
        title: "Renamed",
        priority: "critical",
        tags: ["sync"],
        // Smuggled run-owned field — must never reach the store.
        ...({ status: "completed" } as object),
      })
      expect(updated).toMatchObject({ title: "Renamed", priority: "critical", tags: ["sync"] })
      expect(useAgentTeamStore.getState().tasks[failed.id].status).toBe("failed")
      expect(team.id).toBe(updated.teamId)
      await expect(api.updateTask("missing", { title: "x" })).rejects.toThrow(/not found/)
    })

    it("reorderTask renumbers within the column and validates the task", async () => {
      const { team } = seed()
      const api = createTeamAPI(PLUGIN)
      const a = await api.createTask({ teamId: team.id, title: "A" })
      const b = await api.createTask({ teamId: team.id, title: "B" })
      await api.reorderTask(b.id, 0)
      const state = useAgentTeamStore.getState()
      expect(state.tasks[b.id].order).toBeLessThan(state.tasks[a.id].order)
      await expect(api.reorderTask("missing", 0)).rejects.toThrow(/not found/)
    })

    it("assignTask validates task + same-team assignee", async () => {
      const { team, mate, failed } = seed()
      const api = createTeamAPI(PLUGIN)
      await api.assignTask(failed.id, mate.id)
      expect(useAgentTeamStore.getState().tasks[failed.id].assignedTo).toBe(mate.id)
      await expect(api.assignTask("missing", mate.id)).rejects.toThrow(/not found/)
      await expect(api.assignTask(failed.id, "stranger")).rejects.toThrow(/not on the team/)
    })

    it("attachTaskFile appends an attachment and validates the task", async () => {
      const { failed } = seed()
      const api = createTeamAPI(PLUGIN)
      await api.attachTaskFile(failed.id, { name: "report.md", kind: "file", ref: "out/report.md" })
      const task = useAgentTeamStore.getState().tasks[failed.id]
      expect(task.attachments?.some((a) => a.name === "report.md")).toBe(true)
      await expect(
        api.attachTaskFile("missing", { name: "x", kind: "link", ref: "https://e.io" })
      ).rejects.toThrow(/not found/)
    })

    it("addTeammate always lands as a non-lead teammate (with specialization)", async () => {
      const { team } = seed()
      const api = createTeamAPI(PLUGIN)
      const mate = await api.addTeammate({
        teamId: team.id,
        name: "Reviewer",
        spawnPrompt: "review PRs",
        specialization: "code review",
      })
      expect(mate).toMatchObject({
        teamId: team.id,
        name: "Reviewer",
        role: "teammate",
        spawnPrompt: "review PRs",
        specialization: "code review",
      })
      await expect(api.addTeammate({ teamId: "ghost", name: "x" })).rejects.toThrow(/not found/)
    })

    it("updateTeammate patches only identity fields; removeTeammate protects the lead", async () => {
      const { team, mate } = seed()
      const api = createTeamAPI(PLUGIN)
      const updated = await api.updateTeammate(mate.id, {
        name: "Worker 2",
        ...({ status: "completed", progress: 100 } as object),
      })
      expect(updated.name).toBe("Worker 2")
      expect(useAgentTeamStore.getState().teammates[mate.id].status).not.toBe("completed")
      await expect(api.updateTeammate("missing", { name: "x" })).rejects.toThrow(/not found/)

      expect(await api.removeTeammate(team.leadId)).toBe(false)
      expect(useAgentTeamStore.getState().teammates[team.leadId]).toBeDefined()
      expect(await api.removeTeammate(mate.id)).toBe(true)
      expect(useAgentTeamStore.getState().teammates[mate.id]).toBeUndefined()
      expect(await api.removeTeammate("missing")).toBe(false)
    })

    it("updateTeamConfig replaces the config through the store normalizer", async () => {
      const { team } = seed()
      const api = createTeamAPI(PLUGIN)
      const config = useAgentTeamStore.getState().teams[team.id].config
      await api.updateTeamConfig(team.id, { ...config, maxTeammates: config.maxTeammates + 1 })
      expect(useAgentTeamStore.getState().teams[team.id].config.maxTeammates).toBe(
        config.maxTeammates + 1
      )
      await expect(api.updateTeamConfig("ghost", config)).rejects.toThrow(/not found/)
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
