/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { HeadlessRuntimeContext } from "../types"

const startBotDeliveryRunner = jest.fn()
const recoverStaleBotDeliveries = jest.fn(async () => 0)

jest.mock("@/lib/bot/runtime/delivery-runner", () => ({
  startBotDeliveryRunner: (...args: Parameters<typeof startBotDeliveryRunner>) =>
    startBotDeliveryRunner(...args),
}))
jest.mock("@/lib/bot/schedule/reconcile-timed-triggers", () => ({
  reconcileAllBotSchedules: jest.fn(async () => undefined),
}))
jest.mock("@/lib/db/bot-event-deliveries", () => ({
  recoverStaleBotDeliveries: (...args: Parameters<typeof recoverStaleBotDeliveries>) =>
    recoverStaleBotDeliveries(...args),
}))

function context(overrides: Partial<HeadlessRuntimeContext> = {}): HeadlessRuntimeContext {
  return {
    host: "brain",
    localAccountId: "acct_1",
    bridge: {} as HeadlessRuntimeContext["bridge"],
    notifyDbWrite: jest.fn(),
    resolveMessage: (key: string) => key,
    log: jest.fn(),
    ...overrides,
  } as HeadlessRuntimeContext
}

/**
 * The registry is module state, so the module under test and the reader have
 * to come from the same instance. Importing both AFTER `resetModules` is what
 * guarantees that.
 */
async function loadRuntime() {
  jest.resetModules()
  await import("./bots")
  const { listHeadlessRuntimes } = await import("../registry")
  const runtime = listHeadlessRuntimes().find((r) => r.name === "bot-delivery-runner")
  if (!runtime) throw new Error("bot-delivery-runner did not register")
  return runtime
}

beforeEach(() => {
  recoverStaleBotDeliveries.mockReset().mockResolvedValue(0)
  startBotDeliveryRunner.mockReset()
})

describe("bot-delivery-runner headless runtime", () => {
  it("registers for the brain", async () => {
    expect((await loadRuntime()).hosts).toEqual(["brain"])
  })

  it("namespaces its lease owner by host kind and account", async () => {
    const stop = jest.fn()
    startBotDeliveryRunner.mockReturnValue({ stop })

    const runtime = await loadRuntime()
    const { isBotRunnerOwnedHere } = await import("@/lib/bot/runtime/runner-owner")
    expect(isBotRunnerOwnedHere()).toBe(false)
    const dispose = await runtime.start(context())
    expect(isBotRunnerOwnedHere()).toBe(true)

    // Two brains serving different accounts must never contend for one
    // another's leases.
    expect(startBotDeliveryRunner).toHaveBeenCalledWith({ owner: "brain:acct_1" })
    if (typeof dispose === "function") dispose()
    expect(stop).toHaveBeenCalled()
    expect(isBotRunnerOwnedHere()).toBe(false)
  })

  it("does not claim ownership on failed startup and releases ownership even if stop fails", async () => {
    const runtime = await loadRuntime()
    const { isBotRunnerOwnedHere } = await import("@/lib/bot/runtime/runner-owner")
    startBotDeliveryRunner.mockImplementationOnce(() => {
      throw new Error("start failed")
    })
    expect(() => runtime.start(context())).toThrow("start failed")
    expect(isBotRunnerOwnedHere()).toBe(false)
    startBotDeliveryRunner.mockReturnValue({
      stop: () => {
        throw new Error("stop failed")
      },
    })
    const dispose = await runtime.start(context())
    expect(isBotRunnerOwnedHere()).toBe(true)
    expect(() => (dispose as () => void)()).toThrow("stop failed")
    expect(isBotRunnerOwnedHere()).toBe(false)
  })
})

it("reclaims the rows this brain abandoned before it starts draining", async () => {
  startBotDeliveryRunner.mockReturnValue({ stop: jest.fn() })
  const runtime = await loadRuntime()

  runtime.start(context())

  expect(recoverStaleBotDeliveries).toHaveBeenCalledWith({ owner: "brain:acct_1" })
})
