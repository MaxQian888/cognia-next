/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { HeadlessRuntimeContext } from "../types"

const startBotDeliveryRunner = jest.fn()

jest.mock("@/lib/bot/runtime/delivery-runner", () => ({
  startBotDeliveryRunner: (...args: unknown[]) => startBotDeliveryRunner(...args),
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
    const dispose = await runtime.start(context())

    // Two brains serving different accounts must never contend for one
    // another's leases.
    expect(startBotDeliveryRunner).toHaveBeenCalledWith({ owner: "brain:acct_1" })
    if (typeof dispose === "function") dispose()
    expect(stop).toHaveBeenCalled()
  })
})
