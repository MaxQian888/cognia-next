import { bootstrapHeadlessRuntimes } from "./bootstrap"
import { __resetHeadlessRuntimesForTesting, registerHeadlessRuntime } from "./registry"
import type { HeadlessRuntimeContext } from "./types"

function ctx(): HeadlessRuntimeContext {
  return {
    host: "brain",
    accountId: "local_acct_a",
    bridge: {
      listen: async () => () => undefined,
      invoke: async () => null,
    },
    notifyDbWrite: () => undefined,
    resolveMessage: (key) => key,
    log: () => undefined,
  }
}

describe("bootstrapHeadlessRuntimes", () => {
  beforeEach(() => __resetHeadlessRuntimesForTesting())

  it("starts registered runtimes and tears down in reverse order", async () => {
    const order: string[] = []
    registerHeadlessRuntime({
      name: "first",
      hosts: ["brain"],
      start: () => {
        order.push("start:first")
        return () => {
          order.push("stop:first")
        }
      },
    })
    registerHeadlessRuntime({
      name: "second",
      hosts: ["brain"],
      start: async () => {
        order.push("start:second")
        return async () => {
          order.push("stop:second")
        }
      },
    })

    const result = await bootstrapHeadlessRuntimes(ctx())
    expect(result.started).toEqual(["first", "second"])
    expect(result.failed).toEqual([])

    await result.stop()
    expect(order).toEqual(["start:first", "start:second", "stop:second", "stop:first"])

    // stop() is idempotent.
    await result.stop()
    expect(order).toHaveLength(4)
  })

  it("isolates a failing runtime and keeps starting the rest", async () => {
    registerHeadlessRuntime({
      name: "boom",
      hosts: ["brain"],
      start: () => {
        throw new Error("kaput")
      },
    })
    const stopped: string[] = []
    registerHeadlessRuntime({
      name: "survivor",
      hosts: ["brain"],
      start: () => () => {
        stopped.push("survivor")
      },
    })

    const result = await bootstrapHeadlessRuntimes(ctx())
    expect(result.started).toEqual(["survivor"])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].name).toBe("boom")
    expect((result.failed[0].error as Error).message).toBe("kaput")

    await result.stop()
    expect(stopped).toEqual(["survivor"])
  })

  it("teardown failures do not abort the remaining teardowns", async () => {
    const stopped: string[] = []
    registerHeadlessRuntime({
      name: "fragile",
      hosts: ["brain"],
      start: () => () => {
        throw new Error("teardown boom")
      },
    })
    registerHeadlessRuntime({
      name: "sturdy",
      hosts: ["brain"],
      start: () => () => {
        stopped.push("sturdy")
      },
    })

    const result = await bootstrapHeadlessRuntimes(ctx())
    await result.stop()
    // sturdy tears down first (reverse order), fragile's throw is swallowed.
    expect(stopped).toEqual(["sturdy"])
  })

  it("runtimes without a teardown still count as started", async () => {
    registerHeadlessRuntime({
      name: "fire-and-forget",
      hosts: ["brain"],
      start: () => undefined,
    })
    const result = await bootstrapHeadlessRuntimes(ctx())
    expect(result.started).toEqual(["fire-and-forget"])
    await result.stop()
  })
})
