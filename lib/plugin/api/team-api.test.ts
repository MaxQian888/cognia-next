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

jest.mock("@cognia/logging", () => {
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
      mcp: { ...child, child: () => child },
      plugin: { ...child, child: () => child },
    },
  }
})

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null, projects: [] }) },
}))

const startSquadRun = jest.fn(async () => ({ started: true, runId: "run_team_1" }))
jest.mock("@/lib/ai/agent/team/start-squad-run", () => ({
  startSquadRun: (...args: unknown[]) => startSquadRun(...(args as [])),
}))

const managerPause = jest.fn(async () => {})
const managerResume = jest.fn(async () => {})
const managerShutdown = jest.fn(async () => {})
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    pause: (...a: unknown[]) => managerPause(...(a as [])),
    resume: (...a: unknown[]) => managerResume(...(a as [])),
    shutdown: (...a: unknown[]) => managerShutdown(...(a as [])),
  },
}))

const getAgentTeamTemplate = jest.fn()
jest.mock("@/lib/plugin/registries/agent-team-template-registry", () => ({
  getAgentTeamTemplate: (...a: unknown[]) => getAgentTeamTemplate(...(a as [])),
}))

const resolveDurable = jest.fn(async () => null as Record<string, unknown> | null)
jest.mock("@/lib/ai/agent/team/durable-new-team", () => ({
  resolveDurableNewTeamConfig: (...a: unknown[]) => resolveDurable(...(a as [])),
}))

const publishTemplate = jest.fn(async () => {})
jest.mock("@/lib/agent-team/publish-template-to-platform", () => ({
  publishSquadTemplateToPlatform: (...a: unknown[]) => publishTemplate(...(a as [])),
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

  describe("lifecycle", () => {
    /**
     * The half of the surface that did not exist. A plugin could add
     * teammates, feed the board and run the thing, but the only way to obtain
     * a Squad was `instantiateTemplate` and the only way to lose one was for a
     * human to click Delete.
     */
    it("creates a Squad through createSquad, so it picks up the durable default", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "team:write"])
      resolveDurable.mockResolvedValueOnce({ runtimeVersion: "durable-v2" })
      const api = createTeamAPI(PLUGIN)
      const squad = await api.createTeam({ name: "Review Crew", task: "review the diff" })
      expect(squad.name).toBe("Review Crew")
      expect(squad.config.runtimeVersion).toBe("durable-v2")
      // The lead is synthesized by the store, not by the plugin.
      expect(useAgentTeamStore.getState().teammates[squad.leadId]).toBeDefined()
    })

    it("still creates a Squad when no durable default resolves", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "team:write"])
      resolveDurable.mockRejectedValueOnce(new Error("no workspace root"))
      const api = createTeamAPI(PLUGIN)
      const squad = await api.createTeam({ name: "Solo", task: "x" })
      expect(squad.id).toBeTruthy()
    })

    it("caller config wins over the discovered durable default", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "team:write"])
      resolveDurable.mockResolvedValueOnce({ runtimeVersion: "durable-v2" })
      const api = createTeamAPI(PLUGIN)
      const squad = await api.createTeam({
        name: "Pinned",
        task: "x",
        config: { runtimeVersion: "legacy" },
      })
      expect(squad.config.runtimeVersion).toBe("legacy")
    })

    it("deleteTeam reports an unknown id instead of throwing", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "team:write"])
      const { team } = seed()
      const api = createTeamAPI(PLUGIN)
      expect(await api.deleteTeam("ghost")).toBe(false)
      expect(await api.deleteTeam(team.id)).toBe(true)
      expect(useAgentTeamStore.getState().teams[team.id]).toBeUndefined()
    })

    it("duplicateTeam copies the roster and starts the copy idle", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "team:write"])
      const { team } = seed()
      const api = createTeamAPI(PLUGIN)
      const copy = await api.duplicateTeam(team.id, { name: "Review Crew (web)" })
      expect(copy).not.toBeNull()
      expect(copy!.id).not.toBe(team.id)
      expect(copy!.name).toBe("Review Crew (web)")
      expect(copy!.status).toBe("idle")
      // Repointed, not shared: a copy holding the source's lead id would let
      // one Squad's roster edits move the other's.
      expect(copy!.leadId).not.toBe(team.leadId)
      expect(await api.duplicateTeam("ghost", { name: "x" })).toBeNull()
    })

    it("saveAsTemplate mirrors into the unified platform at write time", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "team:write"])
      const { team } = seed()
      const api = createTeamAPI(PLUGIN)
      const template = await api.saveAsTemplate(team.id, "Review Crew blueprint")
      expect(template).not.toBeNull()
      expect(publishTemplate).toHaveBeenCalledWith(template)
      expect(await api.saveAsTemplate("ghost", "x")).toBeNull()
    })

    it("a failed platform mirror does not lose the template", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "team:write"])
      publishTemplate.mockRejectedValueOnce(new Error("catalog offline"))
      const { team } = seed()
      const api = createTeamAPI(PLUGIN)
      await expect(api.saveAsTemplate(team.id, "Blueprint")).resolves.not.toBeNull()
    })

    it("takes team:write, not agent:dispatch: creating spends nothing", () => {
      guard.registerPlugin(PLUGIN, ["team:read", "agent:dispatch", "agent:control"])
      const api = createTeamAPI(PLUGIN)
      expect(() => api.createTeam({ name: "x", task: "y" })).toThrow(PermissionError)
      expect(() => api.deleteTeam("x")).toThrow(PermissionError)
      expect(() => api.duplicateTeam("x", { name: "y" })).toThrow(PermissionError)
      expect(() => api.saveAsTemplate("x", "y")).toThrow(PermissionError)
    })
  })

  describe("run control", () => {
    /**
     * This module's header used to promise it deliberately had none, on the
     * grounds that spending tokens must stay a human decision. `ctx.agent.runTeam`
     * has always started a Squad on `agent:dispatch` alone, from an ad-hoc config
     * it invents, so the promise was one a reader could act on and be wrong.
     */
    it("starts through the ADR-0140 funnel, not the manager", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "agent:dispatch"])
      const { team } = seed()
      const api = createTeamAPI(PLUGIN)
      const result = await api.start(team.id, { goal: "ship it" })
      expect(result).toEqual({ ok: true, runId: "run_team_1" })
      expect(startSquadRun).toHaveBeenCalledWith(
        expect.objectContaining({ squadId: team.id, goal: "ship it", origin: "api" })
      )
    })

    it("takes agent:dispatch to start, matching ctx.agent.runTeam", () => {
      guard.registerPlugin(PLUGIN, ["team:read", "team:write"])
      const { team } = seed()
      const api = createTeamAPI(PLUGIN)
      expect(() => api.start(team.id)).toThrow(PermissionError)
    })

    it("takes agent:control to pause, resume and stop", () => {
      guard.registerPlugin(PLUGIN, ["team:read", "team:write", "agent:dispatch"])
      const { team } = seed()
      const api = createTeamAPI(PLUGIN)
      expect(() => api.pause(team.id)).toThrow(PermissionError)
      expect(() => api.resume(team.id)).toThrow(PermissionError)
      expect(() => api.stop(team.id)).toThrow(PermissionError)
    })

    it("maps each control verb onto the manager", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "agent:control"])
      const { team } = seed()
      const api = createTeamAPI(PLUGIN)
      await api.pause(team.id)
      await api.resume(team.id)
      await api.stop(team.id)
      expect(managerPause).toHaveBeenCalledWith(team.id)
      expect(managerResume).toHaveBeenCalledWith(team.id)
      expect(managerShutdown).toHaveBeenCalledWith(team.id)
    })

    it("refuses an unknown Squad without touching the runtime", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "agent:dispatch", "agent:control"])
      const api = createTeamAPI(PLUGIN)
      expect(await api.start("nope")).toEqual({ ok: false, reason: "squad_not_found" })
      expect(await api.pause("nope")).toEqual({ ok: false, reason: "squad_not_found" })
      expect(startSquadRun).not.toHaveBeenCalled()
      expect(managerPause).not.toHaveBeenCalled()
    })

    it("returns a failure rather than throwing when the runtime rejects", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "agent:control"])
      const { team } = seed()
      managerPause.mockRejectedValueOnce(new Error("no live run"))
      const api = createTeamAPI(PLUGIN)
      expect(await api.pause(team.id)).toEqual({ ok: false, reason: "no live run" })
    })
  })

  describe("instantiateTemplate", () => {
    /**
     * A plugin could contribute a Squad blueprint through the
     * `agent-team-template` capability and nothing could turn one into a Squad
     * except a person clicking the library.
     */
    it("builds the Squad, its roster and its seeded tasks", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "team:write"])
      getAgentTeamTemplate.mockReturnValue({
        id: "tpl-1",
        name: "Review Crew",
        description: "reviews",
        config: {},
        teammates: [{ name: "Reviewer", description: "reads" }],
        taskTemplates: [{ title: "Read the diff", description: "" }],
      })
      const api = createTeamAPI(PLUGIN)
      const squad = await api.instantiateTemplate("tpl-1")
      expect(squad?.name).toBe("Review Crew")
      const state = useAgentTeamStore.getState()
      expect(
        Object.values(state.teammates).filter(
          (m) => m.teamId === squad!.id && m.role === "teammate"
        )
      ).toHaveLength(1)
      expect(Object.values(state.tasks).filter((t) => t.teamId === squad!.id)).toHaveLength(1)
    })

    it("answers null for an id no template carries", async () => {
      guard.registerPlugin(PLUGIN, ["team:read", "team:write"])
      getAgentTeamTemplate.mockReturnValue(undefined)
      const api = createTeamAPI(PLUGIN)
      expect(await api.instantiateTemplate("nope")).toBeNull()
    })
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
      const { mate, failed } = seed()
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
