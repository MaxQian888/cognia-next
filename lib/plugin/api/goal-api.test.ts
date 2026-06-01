/**
 * Tests for the Goal Plugin API (`ctx.goals`).
 *
 * Covers permission gating (goal:read / goal:write), read forwarding to
 * the Dexie layer, mutation forwarding through the goal runtime, and the
 * sub-goal decomposition path (renderer LLM client built internally).
 */

import { createGoalAPI, NoJudgeModelError } from "./goal-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"

// --- mock the runtime singleton -----------------------------------------
const runtime = {
  createGoal: jest.fn(async () => ({ id: "g1" })),
  updateObjective: jest.fn(async () => ({ goal: { id: "g1" }, updatePrompt: "regen" })),
  pauseGoal: jest.fn(async () => ({ id: "g1", status: "paused" })),
  resumeGoal: jest.fn(async () => ({ id: "g1", status: "active" })),
  stopGoal: jest.fn(async () => ({ id: "g1", status: "stopped" })),
  preemptGoal: jest.fn(async () => ({ id: "g1", status: "preempted" })),
  updateConfig: jest.fn(async () => ({ id: "g1" })),
  generateSubgoals: jest.fn(async () => ({ id: "g1", subgoals: [{ id: "s1" }] })),
  toggleSubgoal: jest.fn(async () => ({ id: "g1" })),
  clearSubgoals: jest.fn(async () => ({ id: "g1", subgoals: [] })),
  deleteGoal: jest.fn(async () => undefined),
}
jest.mock("@/lib/goal/runtime", () => ({ getGoalRuntime: () => runtime }))

// --- mock the Dexie data layer ------------------------------------------
const mockGetGoal = jest.fn(async (id: string) =>
  id === "missing" ? undefined : { id, sessionId: "sess" }
)
jest.mock("@/lib/db/goals", () => ({
  getGoal: (id: string) => mockGetGoal(id),
  listAllGoals: jest.fn(async () => [{ id: "g1" }, { id: "g2" }]),
  listGoalsBySession: jest.fn(async () => [{ id: "g1" }]),
  getActiveGoalForSession: jest.fn(async () => ({ id: "g1", status: "active" })),
  getOpenGoalForSession: jest.fn(async () => undefined),
  listGoalEvents: jest.fn(async () => [{ id: "e1" }]),
}))

jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(async () => ({ id: "sess" })),
}))

let mockClient: unknown = { complete: jest.fn() }
const buildRendererLlmClient = jest.fn((..._a: unknown[]) => mockClient)
jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: (...a: unknown[]) => buildRendererLlmClient(...a),
}))

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings: { fake: true } }) },
}))

import * as db from "@/lib/db/goals"

const PLUGIN = "goal-plugin"

describe("createGoalAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    mockClient = { complete: jest.fn() }
    resetPermissionGuard()
    guard = getPermissionGuard()
  })

  describe("permission gating", () => {
    it("throws without goal:read on a read", () => {
      guard.registerPlugin(PLUGIN, [])
      const api = createGoalAPI(PLUGIN)
      expect(() => api.listAll()).toThrow(PermissionError)
    })

    it("throws without goal:write on a mutation", () => {
      guard.registerPlugin(PLUGIN, ["goal:read"])
      const api = createGoalAPI(PLUGIN)
      expect(() => api.stop("g1")).toThrow(PermissionError)
      expect(runtime.stopGoal).not.toHaveBeenCalled()
    })
  })

  describe("reads", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["goal:read"]))

    it("get maps undefined to null", async () => {
      const api = createGoalAPI(PLUGIN)
      expect(await api.get("missing")).toBeNull()
      expect(await api.get("g1")).toEqual({ id: "g1", sessionId: "sess" })
    })

    it("listAll / listBySession / events forward", async () => {
      const api = createGoalAPI(PLUGIN)
      expect(await api.listAll(10)).toHaveLength(2)
      expect(db.listAllGoals).toHaveBeenCalledWith(10)
      await api.listBySession("sess")
      expect(db.listGoalsBySession).toHaveBeenCalledWith("sess")
      await api.getEvents("g1", 5)
      expect(db.listGoalEvents).toHaveBeenCalledWith("g1", 5)
    })

    it("getOpenForSession maps undefined to null", async () => {
      const api = createGoalAPI(PLUGIN)
      expect(await api.getOpenForSession("sess")).toBeNull()
      expect(await api.getActiveForSession("sess")).toEqual({ id: "g1", status: "active" })
    })
  })

  describe("mutations", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["goal:read", "goal:write"]))

    it("create maps the input and injects app settings", async () => {
      const api = createGoalAPI(PLUGIN)
      await api.create({ sessionId: "sess", rawObjective: "ship it", startPaused: true })
      expect(runtime.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess",
          rawObjective: "ship it",
          startPaused: true,
          appSettings: { fake: true },
        })
      )
    })

    it("lifecycle ops forward to the runtime", async () => {
      const api = createGoalAPI(PLUGIN)
      await api.updateObjective("g1", "new")
      await api.pause("g1")
      await api.resume("g1")
      await api.stop("g1")
      await api.preempt("g1")
      await api.updateConfig("g1", { maxTurns: 5 } as never)
      await api.toggleSubgoal("g1", "s1")
      await api.clearSubgoals("g1")
      await api.delete("g1")
      expect(runtime.updateObjective).toHaveBeenCalledWith("g1", "new")
      expect(runtime.pauseGoal).toHaveBeenCalledWith("g1")
      expect(runtime.resumeGoal).toHaveBeenCalledWith("g1")
      expect(runtime.stopGoal).toHaveBeenCalledWith("g1")
      expect(runtime.preemptGoal).toHaveBeenCalledWith("g1")
      expect(runtime.updateConfig).toHaveBeenCalledWith("g1", { maxTurns: 5 })
      expect(runtime.toggleSubgoal).toHaveBeenCalledWith("g1", "s1")
      expect(runtime.clearSubgoals).toHaveBeenCalledWith("g1")
      expect(runtime.deleteGoal).toHaveBeenCalledWith("g1")
    })

    describe("decomposeSubgoals", () => {
      it("returns null for a missing goal without touching the model", async () => {
        const api = createGoalAPI(PLUGIN)
        expect(await api.decomposeSubgoals("missing")).toBeNull()
        expect(buildRendererLlmClient).not.toHaveBeenCalled()
      })

      it("builds the renderer client and delegates to the runtime", async () => {
        const api = createGoalAPI(PLUGIN)
        const updated = await api.decomposeSubgoals("g1")
        expect(buildRendererLlmClient).toHaveBeenCalledWith(
          expect.objectContaining({ featureId: "goal-subgoals", appSettings: { fake: true } })
        )
        expect(runtime.generateSubgoals).toHaveBeenCalledWith("g1", mockClient)
        expect(updated).toEqual({ id: "g1", subgoals: [{ id: "s1" }] })
      })

      it("throws NoJudgeModelError when no judge client can be built", async () => {
        mockClient = null
        const api = createGoalAPI(PLUGIN)
        await expect(api.decomposeSubgoals("g1")).rejects.toThrow(NoJudgeModelError)
        expect(runtime.generateSubgoals).not.toHaveBeenCalled()
      })
    })
  })
})
