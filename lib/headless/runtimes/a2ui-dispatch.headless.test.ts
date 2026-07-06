/**
 * Headless smoke for the a2ui-dispatch runtime (ADR-0059 T-A4).
 *
 * @jest-environment node
 */
const processMessage = jest.fn()

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: {
    getState: () => ({ processMessage }),
  },
}))

import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext, RuntimeBridge } from "../types"

type Handler = (e: { payload: unknown }) => void

describe("a2ui-dispatch headless smoke", () => {
  it("subscribes via the injected bridge and feeds the store", async () => {
    __resetHeadlessRuntimesForTesting()
    await import("./a2ui-dispatch")

    const listeners = new Map<string, Handler>()
    const bridge: RuntimeBridge = {
      listen: async (event, handler) => {
        listeners.set(event, handler as Handler)
        return () => listeners.delete(event)
      },
      invoke: async () => null,
    }
    const ctx: HeadlessRuntimeContext = {
      host: "brain",
      accountId: "local_acct_a",
      bridge,
      notifyDbWrite: () => undefined,
      resolveMessage: (key) => key,
      log: () => undefined,
    }

    const result = await bootstrapHeadlessRuntimes(ctx)
    expect(result.failed).toEqual([])
    expect(result.started).toContain("a2ui-dispatch")
    expect(listeners.has("a2ui://dispatch")).toBe(true)

    // A well-formed envelope reaches the store.
    listeners.get("a2ui://dispatch")!({
      payload: {
        type: "a2ui_dispatch",
        sessionId: "s1",
        message: { kind: "createSurface", surfaceId: "x" },
      },
    })
    expect(processMessage).toHaveBeenCalledWith({ kind: "createSurface", surfaceId: "x" })

    // A malformed one is dropped without throwing.
    listeners.get("a2ui://dispatch")!({ payload: { type: "other" } })
    expect(processMessage).toHaveBeenCalledTimes(1)

    await result.stop()
    expect(listeners.size).toBe(0)
  })
})
