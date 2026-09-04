/** @jest-environment node */
import type { HeadlessRuntimeContext } from "../types"

const installTriggerBridgeMock = jest.fn()
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  installTriggerBridge: () => installTriggerBridgeMock(),
}))

function makeContext(): HeadlessRuntimeContext & { log: jest.Mock } {
  return {
    host: "brain",
    localAccountId: "account",
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

/** Fresh registry + bootstrap + runtime module per test (module-level registration). */
async function loadFresh() {
  jest.resetModules()
  const { __resetHeadlessRuntimesForTesting } = await import("../registry")
  __resetHeadlessRuntimesForTesting()
  await import("./workflow-trigger-bridge")
  const { bootstrapHeadlessRuntimes } = await import("../bootstrap")
  return bootstrapHeadlessRuntimes
}

beforeEach(() => {
  installTriggerBridgeMock.mockReset()
})

it("installs the workflow trigger bridge in the brain and disposes it on stop", async () => {
  const dispose = jest.fn()
  installTriggerBridgeMock.mockResolvedValue(dispose)
  const bootstrap = await loadFresh()
  const context = makeContext()
  const result = await bootstrap(context)
  expect(result.failed).toEqual([])
  expect(result.started).toContain("workflow-trigger-bridge")
  expect(installTriggerBridgeMock).toHaveBeenCalledTimes(1)
  expect(context.log).toHaveBeenCalledWith(
    "info",
    expect.stringMatching(/trigger bridge installed/)
  )
  await result.stop()
  expect(dispose).toHaveBeenCalledTimes(1)
})

it("keeps the roster healthy when the bridge cannot install", async () => {
  installTriggerBridgeMock.mockRejectedValue(new Error("no events plane"))
  const bootstrap = await loadFresh()
  const context = makeContext()
  const result = await bootstrap(context)
  expect(result.failed).toEqual([])
  expect(result.started).toContain("workflow-trigger-bridge")
  expect(context.log).toHaveBeenCalledWith("error", expect.stringMatching(/no events plane/))
  await expect(result.stop()).resolves.toBeUndefined()
})
