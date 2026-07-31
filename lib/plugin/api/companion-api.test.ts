/**
 * Tests for the Companion Plugin API (`ctx.companion`).
 *
 * Verifies: (1) each method is gated behind its tier permission
 * (`companion:read` / `:control` / `:goal-control`), (2) control calls run the
 * Rust command then the Dexie mirror, and (3) goal control reuses the goal
 * runtime and filters the open-goal set.
 */

import { createCompanionAPI } from "./companion-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"

// Mock fns carry a rest signature so the `(...a) => fn(...a)` factory wrappers
// can forward args without tripping TS2556 (parity with the Proxy mock used in
// automation-api.test.ts — the forward target must accept a rest parameter).
const call = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/tauri", () => ({ transport: { call: (...a: unknown[]) => call(...a) } }))

const listPairedDevices = jest.fn(async (..._a: unknown[]) => [{ deviceId: "d1" }])
const getPairedDevice = jest.fn(async (..._a: unknown[]): Promise<unknown> => ({ deviceId: "d1" }))
const setRemoteControlAllowed = jest.fn(async (..._a: unknown[]) => undefined)
const revokePairedDevice = jest.fn(async (..._a: unknown[]) => undefined)
const resumePairedDevice = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/db/paired-devices", () => ({
  listPairedDevices: (...a: unknown[]) => listPairedDevices(...a),
  getPairedDevice: (...a: unknown[]) => getPairedDevice(...a),
  setRemoteControlAllowed: (...a: unknown[]) => setRemoteControlAllowed(...a),
  revokePairedDevice: (...a: unknown[]) => revokePairedDevice(...a),
  resumePairedDevice: (...a: unknown[]) => resumePairedDevice(...a),
}))

const listAllGoals = jest.fn(async (..._a: unknown[]) => [
  { id: "g-active", status: "active" },
  { id: "g-paused", status: "paused" },
  { id: "g-done", status: "completed" },
])
jest.mock("@/lib/db/goals", () => ({ listAllGoals: (...a: unknown[]) => listAllGoals(...a) }))

const pauseGoal = jest.fn(async (id: string) => ({ id, status: "paused" }))
const resumeGoal = jest.fn(async (id: string) => ({ id, status: "active" }))
const stopGoal = jest.fn(async (id: string) => ({ id, status: "stopped" }))
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({ pauseGoal, resumeGoal, stopGoal }),
}))

const PLUGIN = "companion-plugin"

describe("createCompanionAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    resetPermissionGuard()
    guard = getPermissionGuard({ confirmDangerousByDefault: false })
  })

  it("gates each method behind its tier permission", () => {
    guard.registerPlugin(PLUGIN, [])
    const api = createCompanionAPI(PLUGIN)
    expect(() => api.listDevices()).toThrow(PermissionError)
    expect(() => api.setRemoteControl("d1", true)).toThrow(PermissionError)
    expect(() => api.pauseGoal("g")).toThrow(PermissionError)
  })

  it("read permission does not unlock control or goal-control", () => {
    guard.registerPlugin(PLUGIN, ["companion:read"])
    const api = createCompanionAPI(PLUGIN)
    expect(() => api.listDevices()).not.toThrow()
    expect(() => api.revokeDevice("d1")).toThrow(PermissionError)
    expect(() => api.stopGoal("g")).toThrow(PermissionError)
  })

  describe("read (companion:read)", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["companion:read"]))

    it("forwards device reads and server status", async () => {
      const api = createCompanionAPI(PLUGIN)
      expect(await api.listDevices()).toEqual([{ deviceId: "d1" }])
      expect(await api.getDevice("d1")).toEqual({ deviceId: "d1" })
      await api.serverStatus()
      expect(call).toHaveBeenCalledWith("companion_server_status", {})
    })

    it("getDevice maps undefined to null", async () => {
      getPairedDevice.mockResolvedValueOnce(undefined as never)
      const api = createCompanionAPI(PLUGIN)
      expect(await api.getDevice("missing")).toBeNull()
    })
  })

  describe("control (companion:control)", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["companion:control"]))

    it("runs the Rust command then the Dexie mirror for setRemoteControl", async () => {
      const api = createCompanionAPI(PLUGIN)
      await api.setRemoteControl("d1", true)
      expect(call).toHaveBeenCalledWith("companion_set_remote_control", {
        deviceId: "d1",
        allowed: true,
      })
      expect(setRemoteControlAllowed).toHaveBeenCalledWith("d1", true)
    })

    it("revoke / unrevoke pair the command with the db mirror", async () => {
      const api = createCompanionAPI(PLUGIN)
      await api.revokeDevice("d1")
      expect(call).toHaveBeenCalledWith("companion_revoke_device", { deviceId: "d1" })
      expect(revokePairedDevice).toHaveBeenCalledWith("d1")

      await api.unrevokeDevice("d1")
      expect(call).toHaveBeenCalledWith("companion_unrevoke_device", { deviceId: "d1" })
      expect(resumePairedDevice).toHaveBeenCalledWith("d1")
    })
  })

  describe("goal control (companion:goal-control)", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["companion:goal-control"]))

    it("lists only open (active/paused) goals", async () => {
      const api = createCompanionAPI(PLUGIN)
      const open = await api.listOpenGoals()
      expect(open.map((g) => g.id)).toEqual(["g-active", "g-paused"])
    })

    it("delegates pause/resume/stop to the goal runtime", async () => {
      const api = createCompanionAPI(PLUGIN)
      expect(await api.pauseGoal("g1")).toMatchObject({ status: "paused" })
      expect(pauseGoal).toHaveBeenCalledWith("g1")
      await api.resumeGoal("g1")
      expect(resumeGoal).toHaveBeenCalledWith("g1")
      await api.stopGoal("g1")
      expect(stopGoal).toHaveBeenCalledWith("g1")
    })
  })
})
