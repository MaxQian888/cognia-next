/** @jest-environment jsdom */
import { installExitLeaseRelease, releaseHeldLeasesForExit } from "./exit-lease-release"

describe("releaseHeldLeasesForExit", () => {
  it("stamps the handoff before dropping the lease", async () => {
    // Order matters: dying between the two writes must leave the run
    // recoverable. A stamped run with a live lease still frees itself at the
    // TTL; a freed lease with no stamp loses why it happened.
    const order: string[] = []
    const released = await releaseHeldLeasesForExit({
      heldRunIds: () => ["run_1"],
      markReleased: async () => void order.push("mark"),
      release: async () => void order.push("release"),
      now: () => 1_700_000_000_000,
    })

    expect(order).toEqual(["mark", "release"])
    expect(released).toEqual(["run_1"])
  })

  it("releases every held run, not just the first", async () => {
    const release = jest.fn(async () => undefined)
    await releaseHeldLeasesForExit({
      heldRunIds: () => ["run_1", "run_2", "run_3"],
      markReleased: async () => undefined,
      release,
    })
    expect(release).toHaveBeenCalledTimes(3)
  })

  it("does nothing when this process holds no lease", async () => {
    const release = jest.fn(async () => undefined)
    await expect(releaseHeldLeasesForExit({ heldRunIds: () => [], release })).resolves.toEqual([])
    expect(release).not.toHaveBeenCalled()
  })

  it("keeps going when one run fails and never throws into the exit path", async () => {
    // Exit must not be blocked or aborted by a lease write; the TTL is the
    // backstop for anything that does not land.
    const onError = jest.fn()
    const released = await releaseHeldLeasesForExit({
      heldRunIds: () => ["run_bad", "run_good"],
      markReleased: async (runId) => {
        if (runId === "run_bad") throw new Error("dexie closed")
      },
      release: async () => undefined,
      onError,
    })

    expect(released).toEqual(["run_good"])
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe("installExitLeaseRelease", () => {
  it("releases on webview teardown and stops after teardown of the listener", async () => {
    const release = jest.fn(async () => undefined)
    const deps = {
      heldRunIds: () => ["run_1"],
      markReleased: async () => undefined,
      release,
    }

    const dispose = installExitLeaseRelease(deps)
    window.dispatchEvent(new Event("pagehide"))
    await Promise.resolve()
    expect(release).toHaveBeenCalledTimes(1)

    dispose()
    window.dispatchEvent(new Event("pagehide"))
    await Promise.resolve()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("is inert outside a browser rather than throwing at import time", () => {
    expect(() => installExitLeaseRelease({ heldRunIds: () => [] })()).not.toThrow()
  })
})
