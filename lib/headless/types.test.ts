import type { HeadlessRuntime, HeadlessRuntimeContext, RuntimeBridge } from "./types"

describe("headless runtime contracts", () => {
  it("accepts the bridge, context, runtime, and teardown shapes used by the brain", async () => {
    const bridge: RuntimeBridge = {
      listen: async () => () => undefined,
      invoke: async () => ({ ok: true }),
    }
    const context: HeadlessRuntimeContext = {
      host: "brain",
      accountId: "account-1",
      bridge,
      notifyDbWrite: jest.fn(),
      resolveMessage: (key) => key,
      log: jest.fn(),
    }
    const teardown = jest.fn()
    const runtime: HeadlessRuntime = {
      name: "contract-test",
      hosts: ["brain"],
      start: async (received) => {
        expect(received).toBe(context)
        return teardown
      },
    }

    const result = await runtime.start(context)
    await result?.()
    expect(teardown).toHaveBeenCalledTimes(1)
  })
})
