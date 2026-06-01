/**
 * Tests for the read-only Performance Plugin API (`ctx.perf`).
 */

import { createPerfAPI } from "./perf-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"

const perfSnapshot = jest.fn(async () => ({ samples: [{ t: 1 }], running: true, intervalMs: 1000 }))
const perfHotspots = jest.fn(async () => [{ name: "render", totalMs: 5 }])
const perfSystemDetails = jest.fn(async () => ({ os: "win" }))
const perfListTraces = jest.fn(async () => [{ path: "/t.json" }])
const unsubscribe = jest.fn()
const subscribePerfSample = jest.fn(() => unsubscribe)
jest.mock("@/lib/perf/backend/commands", () => ({
  perfSnapshot: (...a: unknown[]) => perfSnapshot(...a),
  perfHotspots: (...a: unknown[]) => perfHotspots(...a),
  perfSystemDetails: (...a: unknown[]) => perfSystemDetails(...a),
  perfListTraces: (...a: unknown[]) => perfListTraces(...a),
  subscribePerfSample: (...a: unknown[]) => subscribePerfSample(...a),
}))

const PLUGIN = "perf-plugin"

describe("createPerfAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    resetPermissionGuard()
    guard = getPermissionGuard()
  })

  it("gates every method behind perf:read", () => {
    guard.registerPlugin(PLUGIN, [])
    const api = createPerfAPI(PLUGIN)
    expect(() => api.snapshot()).toThrow(PermissionError)
    expect(() => api.subscribe(() => {})).toThrow(PermissionError)
  })

  describe("granted", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["perf:read"]))

    it("forwards read commands", async () => {
      const api = createPerfAPI(PLUGIN)
      expect(await api.snapshot()).toMatchObject({ running: true })
      expect(await api.hotspots()).toHaveLength(1)
      expect(await api.systemDetails()).toEqual({ os: "win" })
      expect(await api.listTraces()).toEqual([{ path: "/t.json" }])
      expect(perfSnapshot).toHaveBeenCalled()
    })

    it("subscribe wires the handler and returns the disposer", () => {
      const api = createPerfAPI(PLUGIN)
      const handler = jest.fn()
      const dispose = api.subscribe(handler)
      expect(subscribePerfSample).toHaveBeenCalledWith(handler)
      dispose()
      expect(unsubscribe).toHaveBeenCalled()
    })
  })
})
