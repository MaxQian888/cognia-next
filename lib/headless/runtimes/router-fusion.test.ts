/** @jest-environment node */
import type { HeadlessRuntimeContext } from "../types"

const recoverRouterFusionRuns = jest.fn()
const stopRetention = jest.fn()
const startRouterFusionRetention = jest.fn()
jest.mock("@/lib/router-fusion/gate/boot", () => ({
  recoverRouterFusionRuns: (...args: unknown[]) => recoverRouterFusionRuns(...args),
  startRouterFusionRetention: (...args: unknown[]) => startRouterFusionRetention(...args),
}))

const getSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettings() }))

const ON = { routerFusion: { enabled: true, surfaces: { gatewayRuns: true } } }

function makeContext(): HeadlessRuntimeContext & { log: jest.Mock } {
  return {
    host: "brain",
    localAccountId: "acct-1",
    bridge: {
      listen: async () => () => undefined,
      invoke: jest.fn(),
      respondMedia: async () => {},
    },
    notifyDbWrite: jest.fn(),
    resolveMessage: (key) => key,
    log: jest.fn(),
  }
}

async function loadFresh() {
  jest.resetModules()
  const { __resetHeadlessRuntimesForTesting } = await import("../registry")
  __resetHeadlessRuntimesForTesting()
  await import("./router-fusion")
  const { bootstrapHeadlessRuntimes } = await import("../bootstrap")
  return bootstrapHeadlessRuntimes
}

beforeEach(() => {
  recoverRouterFusionRuns.mockReset().mockResolvedValue(0)
  startRouterFusionRetention.mockReset().mockReturnValue(stopRetention)
  stopRetention.mockReset()
  getSettings.mockReset().mockResolvedValue(ON)
})

it("sweeps and schedules retention from the account's stored settings", async () => {
  const bootstrap = await loadFresh()
  const result = await bootstrap(makeContext())
  expect(result.failed).toEqual([])
  expect(result.started).toContain("router-fusion")

  // The brain never loads the settings store, so both jobs read the row.
  await new Promise((resolve) => setImmediate(resolve))
  expect(recoverRouterFusionRuns).toHaveBeenCalledWith(ON)
  const readSettings = startRouterFusionRetention.mock.calls[0][0] as () => Promise<unknown>
  await expect(readSettings()).resolves.toBe(ON)

  await result.stop()
  expect(stopRetention).toHaveBeenCalled()
})

it("keeps booting when the settings row cannot be read, treating every surface as off", async () => {
  getSettings.mockRejectedValue(new Error("database closed"))
  const bootstrap = await loadFresh()
  const ctx = makeContext()
  const result = await bootstrap(ctx)
  expect(result.failed).toEqual([])

  await new Promise((resolve) => setImmediate(resolve))
  // `null` is what the gate reads as off: nothing is loaded or swept.
  expect(recoverRouterFusionRuns).toHaveBeenCalledWith(null)
  expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("could not read settings"))
  await result.stop()
})

it("does not let a failed recovery sweep fail the boot", async () => {
  recoverRouterFusionRuns.mockRejectedValue(new Error("boom"))
  const bootstrap = await loadFresh()
  const ctx = makeContext()
  const result = await bootstrap(ctx)
  expect(result.failed).toEqual([])
  await new Promise((resolve) => setImmediate(resolve))
  expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("recovery failed"))
  await result.stop()
})
