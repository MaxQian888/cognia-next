import {
  getVectorRuntimeAdapters,
  resetVectorRuntimeAdaptersForTesting,
} from "@cognia/vector/runtime-adapters"
import { bootstrapHeadlessRuntimes } from "./bootstrap"
import { __resetHeadlessRuntimesForTesting, registerHeadlessRuntime } from "./registry"
import type { HeadlessRuntimeContext } from "./types"

function ctx(): HeadlessRuntimeContext {
  return {
    host: "brain",
    localAccountId: "local_acct_a",
    bridge: {
      listen: async () => () => undefined,
      invoke: async () => null,
      respondMedia: async () => {},
    },
    notifyDbWrite: () => undefined,
    resolveMessage: (key) => key,
    log: () => undefined,
  }
}

describe("bootstrapHeadlessRuntimes", () => {
  beforeEach(() => __resetHeadlessRuntimesForTesting())

  it("installs vector adapters before the first runtime starts", async () => {
    resetVectorRuntimeAdaptersForTesting()
    registerHeadlessRuntime({
      name: "vector-consumer",
      hosts: ["brain"],
      start: () => {
        expect(getVectorRuntimeAdapters().isTauri()).toBe(false)
      },
    })
    const result = await bootstrapHeadlessRuntimes(ctx())
    expect(result.failed).toEqual([])
    expect(result.started).toEqual(["vector-consumer"])
  })

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

describe("restarting one runtime", () => {
  beforeEach(() => __resetHeadlessRuntimesForTesting())

  it("starts a failed runtime again and reports it running", async () => {
    let attempts = 0
    registerHeadlessRuntime({
      name: "flaky",
      hosts: ["brain"],
      start: () => {
        attempts += 1
        if (attempts === 1) throw new Error("backend not ready")
        return () => undefined
      },
    })
    const result = await bootstrapHeadlessRuntimes(ctx(), () => 1000)
    expect(result.status()).toEqual([
      {
        name: "flaky",
        state: "failed",
        error: "backend not ready",
        restartable: true,
        restarts: 0,
      },
    ])

    const after = await result.restart("flaky")
    expect(after).toEqual({
      name: "flaky",
      state: "running",
      restartable: true,
      restarts: 1,
      startedAt: 1000,
    })
    expect(result.status()).toEqual([after])
    // The boot record stays what happened at boot.
    expect(result.failed.map((failure) => failure.name)).toEqual(["flaky"])
  })

  it("tears a running runtime down before starting it again, and stops the new one at shutdown", async () => {
    const events: string[] = []
    let generation = 0
    registerHeadlessRuntime({
      name: "worker",
      hosts: ["brain"],
      start: () => {
        const mine = ++generation
        events.push(`start:${mine}`)
        return () => {
          events.push(`stop:${mine}`)
        }
      },
    })
    const result = await bootstrapHeadlessRuntimes(ctx())
    await result.restart("worker")
    await result.stop()
    expect(events).toEqual(["start:1", "stop:1", "start:2", "stop:2"])
  })

  it("joins a restart already under way instead of starting twice", async () => {
    let release: () => void = () => undefined
    const starts: number[] = []
    registerHeadlessRuntime({
      name: "slow",
      hosts: ["brain"],
      start: async () => {
        starts.push(starts.length + 1)
        if (starts.length > 1) await new Promise<void>((resolve) => (release = resolve))
        return () => undefined
      },
    })
    const result = await bootstrapHeadlessRuntimes(ctx())
    const first = result.restart("slow")
    await Promise.resolve()
    expect(result.status()[0]).toMatchObject({ state: "restarting", restartable: false })
    const second = result.restart("slow")
    expect(second).toBe(first)
    release()
    await expect(first).resolves.toMatchObject({ state: "running", restarts: 1 })
    expect(starts).toEqual([1, 2])
  })

  it("refuses a running runtime without a teardown, an unknown name, and any restart after stop", async () => {
    registerHeadlessRuntime({ name: "no-teardown", hosts: ["brain"], start: () => undefined })
    const result = await bootstrapHeadlessRuntimes(ctx())
    expect(result.status()[0]).toMatchObject({ state: "running", restartable: false })
    await expect(result.restart("no-teardown")).rejects.toMatchObject({
      code: "runtime_not_restartable",
    })
    await expect(result.restart("missing")).rejects.toMatchObject({ code: "runtime_not_found" })
    await result.stop()
    await expect(result.restart("no-teardown")).rejects.toMatchObject({
      code: "runtimes_stopped",
    })
  })

  it("does not start a runtime again when its teardown fails", async () => {
    let starts = 0
    let teardowns = 0
    registerHeadlessRuntime({
      name: "stuck",
      hosts: ["brain"],
      start: () => {
        starts += 1
        return () => {
          teardowns += 1
          if (teardowns === 1) throw new Error("socket busy")
        }
      },
    })
    const result = await bootstrapHeadlessRuntimes(ctx())
    const after = await result.restart("stuck")
    expect(after).toMatchObject({
      state: "running",
      error: "teardown failed: socket busy",
      restartable: true,
    })
    expect(starts).toBe(1)
    // The kept teardown is tried again on the next restart.
    await expect(result.restart("stuck")).resolves.toMatchObject({ state: "running" })
    expect(starts).toBe(2)
    expect(result.status()[0].error).toBeUndefined()
  })

  it("lists only the runtimes this host started", async () => {
    registerHeadlessRuntime({ name: "here", hosts: ["brain"], start: () => () => undefined })
    registerHeadlessRuntime({
      name: "elsewhere",
      hosts: [] as unknown as ["brain"],
      start: () => () => undefined,
    })
    const result = await bootstrapHeadlessRuntimes(ctx())
    expect(result.status().map((runtime) => runtime.name)).toEqual(["here"])
    await expect(result.restart("elsewhere")).rejects.toMatchObject({
      code: "runtime_not_found",
    })
  })
})
